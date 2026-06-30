#!/usr/bin/env python3
"""候选 → L3 升格脚本：下载公告 PDF → 抽正文 → 抽结构化硬字段 → 输出带证据的
L3 草稿 JSON（默认 review_required=true，绝不自动入库）。

设计边界（对齐 archive_l3.py / disclosure-archive 的「只产草稿不入库」原则）：
- 本脚本只做「抽取式信息抽取（IE）」，产出 *草稿*；是否升真 L3 仍由人工复核决定。
- 每个抽出的字段都带 evidence（原文证据句）+ source_url，便于人工/二次模型回溯核验。
- fact_status 只能从正文判定（标题会骗人：中标≠已签约、试生产≠达产、预披露=planned）。
- 命中中介/合规声明（不得参与/经办人员/核查报告…）直接判 not_l3，不产草稿。

用法：
    # 单条：给 pdf_url + 元数据
    python3 promote_l3.py --pdf-url http://...PDF --code 002307 --name 北新路桥 \
        --title "工程中标公告" --fact-type order_contract
    # 批量：读 run.py/collect 产出的候选 JSON 数组（含 pdf_url 字段）
    python3 promote_l3.py --in candidates.json --out drafts.json

抽字纯函数（extract_facts / classify_fact_status / find_amounts）不依赖网络，便于离线单测。
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.request

# 中介机构/合规声明等「配套文件」标志词：命中即非交易事实本身，不产 L3 草稿。
_INTERMEDIARY_MARKERS = (
    "不得参与", "经办人员", "核查报告", "专项核查", "独立财务顾问",
    "验资报告", "估值报告", "相关主体不存在", "承诺函",
)

# 阶段判定词。realized 为兜底；planned/partially 命中即覆盖（planned 优先级最高）。
_PLANNED_MARKERS = ("预披露", "预案", "拟", "预计", "计划", "尚未提交", "意向", "框架协议")
_PARTIAL_MARKERS = (
    "试生产", "开车试", "尚未.{0,6}签订", "尚未.{0,6}正式签订", "部分生产线",
    "部分产线", "中标通知书", "中标人",
)

# 金额：阿拉伯数字（带千分位）+ 单位；以及 ¥ 前缀的精确到分金额。
_AMOUNT_ARABIC = re.compile(r"(?:人民币|¥)?\s*([\d,]+(?:\.\d+)?)\s*(亿元|万元|元)")
_AMOUNT_YUAN = re.compile(r"¥\s*([\d,]+\.\d{2})")
_UNIT_MULT = {"元": 1, "万元": 10_000, "亿元": 100_000_000}

# 占营收/净利比例（公告里量化影响的常见句式）。
_RATIO = re.compile(r"占[^，。；]{0,20}?(?:营业收入|营收|净利润)[^，。；]{0,10}?([\d.]+)\s*%")
# 工期/期限。
_DURATION = re.compile(r"(?:工期|期限|建设周期)[^，。；]{0,8}?(\d+)\s*(日历天|天|个月|年)")


def find_amounts(text: str) -> list[dict]:
    """抽金额并归一到「元」。返回 [{raw, value_yuan, unit}]，按金额降序、去重。"""
    seen: set[float] = set()
    out: list[dict] = []
    for m in _AMOUNT_YUAN.finditer(text):
        val = float(m.group(1).replace(",", ""))
        if val not in seen:
            seen.add(val)
            out.append({"raw": m.group(0).strip(), "value_yuan": val, "unit": "元"})
    for m in _AMOUNT_ARABIC.finditer(text):
        unit = m.group(2)
        val = float(m.group(1).replace(",", "")) * _UNIT_MULT[unit]
        if val not in seen:
            seen.add(val)
            out.append({"raw": m.group(0).strip(), "value_yuan": val, "unit": unit})
    out.sort(key=lambda d: d["value_yuan"], reverse=True)
    return out


def _first(text: str, pattern: re.Pattern) -> str | None:
    m = pattern.search(text)
    return m.group(0).strip() if m else None


def _evidence_sentence(text: str, marker: str) -> str | None:
    """返回包含 marker 的最小句子片段（按中文标点切句），用作证据。"""
    m = re.search(marker, text)
    if not m:
        return None
    start = max(text.rfind("。", 0, m.start()), text.rfind("\n", 0, m.start())) + 1
    end = m.end()
    for p in ("。", "\n", "；"):
        i = text.find(p, m.end())
        if i != -1:
            end = min(end if end > m.end() else i, i)
    seg = text[start:end].strip()
    return re.sub(r"\s+", "", seg) or None


def classify_fact_status(text: str) -> tuple[str, str | None]:
    """从正文判定事实阶段。返回 (status, evidence)。

    优先级：partially_realized > planned > realized（兜底）。intermediary 由调用方先判。
    partial 先于 planned 是刻意的——强实现信号（试生产/中标通知书/尚未签订）比泛化的
    「计划/预计」更能定调；否则「计划总投资」里的『计划』会把试生产误判成 planned。
    局限：极少数「预计明年试生产」式的未来句会被高判为 partial，留待人工复核。
    """
    for kw in _PARTIAL_MARKERS:
        if re.search(kw, text):
            return "partially_realized", _evidence_sentence(text, kw)
    for kw in _PLANNED_MARKERS:
        if re.search(kw, text):
            return "planned", _evidence_sentence(text, kw)
    return "realized", None


def is_intermediary_noise(text: str) -> str | None:
    """命中中介/合规声明标志词则返回该词，否则 None。"""
    for kw in _INTERMEDIARY_MARKERS:
        if re.search(kw, text):
            return kw
    return None


def extract_facts(text: str, record: dict | None = None) -> dict:
    """纯函数：正文 → 结构化硬字段草稿（带证据）。不联网。"""
    record = record or {}
    text = text or ""
    noise = is_intermediary_noise(text)
    if noise:
        return {
            "l3_usable": False,
            "reject_reason": f"intermediary_or_compliance:{noise}",
            "fact_status": "n/a",
        }

    status, status_ev = classify_fact_status(text)
    amounts = find_amounts(text)
    ratio = _first(text, _RATIO)
    duration = _first(text, _DURATION)

    fields: dict = {}
    if amounts:
        fields["amount"] = {"value": amounts[0], "candidates": amounts[:5],
                            "evidence": _evidence_sentence(text, re.escape(amounts[0]["raw"]))}
    if ratio:
        fields["revenue_impact"] = {"value": ratio, "evidence": _evidence_sentence(text, _RATIO.pattern)}
    if duration:
        fields["duration"] = {"value": duration, "evidence": duration}

    return {
        "l3_usable": True,
        "fact_status": status,
        "fact_status_evidence": status_ev,
        "extracted_fields": fields,
        "char_count": len(text),
    }


def download_pdf_text(url: str, timeout: int = 30) -> str:
    """下载 PDF 并抽正文。依赖 pypdf（按需 import，便于离线单测不强制安装）。"""
    from io import BytesIO

    from pypdf import PdfReader

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
    reader = PdfReader(BytesIO(data))
    return "\n".join((p.extract_text() or "") for p in reader.pages)


def promote(record: dict, *, text: str | None = None) -> dict:
    """单条候选 → L3 草稿。text 给定则直接用（测试/离线），否则按 pdf_url 下载。"""
    pdf_url = record.get("pdf_url") or record.get("pdfUrl") or ""
    if text is None:
        if not pdf_url:
            return {**_meta(record), "l3_usable": False, "reject_reason": "no_pdf_url",
                    "review_required": True}
        text = download_pdf_text(pdf_url)
    facts = extract_facts(text, record)
    draft = {
        **_meta(record),
        **facts,
        # 安全边界：永远是草稿，永不自动入库。
        "ingest_status": "parsed_draft",
        "review_status": "unreviewed",
        "review_required": True,
        "not_applied": True,
    }
    return draft


def _meta(record: dict) -> dict:
    return {
        "company": record.get("sec_name") or record.get("name") or "",
        "code": record.get("sec_code") or record.get("code") or "",
        "title": record.get("title", ""),
        "fact_type": record.get("fact_type", ""),
        "source_url": record.get("pdf_url") or record.get("detail_url") or "",
        "announcement_id": record.get("announcement_id", ""),
    }


def _cli(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="候选→L3 草稿（带证据，不入库）")
    ap.add_argument("--in", dest="infile", help="候选 JSON 数组文件（含 pdf_url）")
    ap.add_argument("--out", dest="outfile", help="输出草稿 JSON（默认 stdout）")
    ap.add_argument("--pdf-url")
    ap.add_argument("--code")
    ap.add_argument("--name")
    ap.add_argument("--title", default="")
    ap.add_argument("--fact-type", default="")
    args = ap.parse_args(argv)

    if args.infile:
        records = json.load(open(args.infile, encoding="utf-8"))
        drafts = [promote(r) for r in records]
    elif args.pdf_url:
        drafts = [promote({"pdf_url": args.pdf_url, "sec_code": args.code,
                           "sec_name": args.name, "title": args.title,
                           "fact_type": args.fact_type})]
    else:
        ap.error("需要 --in 或 --pdf-url")
        return 2

    payload = json.dumps(drafts, ensure_ascii=False, indent=2)
    if args.outfile:
        open(args.outfile, "w", encoding="utf-8").write(payload)
        usable = sum(1 for d in drafts if d.get("l3_usable"))
        print(f"wrote {len(drafts)} drafts ({usable} l3_usable) -> {args.outfile}")
    else:
        print(payload)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli(sys.argv[1:]))
