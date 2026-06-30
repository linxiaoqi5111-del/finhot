# disclosure_lookup

实时查新 + 选择性 L3 沉淀系统。**完整设计见 [`DESIGN.md`](./DESIGN.md)，进度/决策/坑见 [`HANDOFF.md`](./HANDOFF.md)。**

> 状态：**Phase 1-3 已完成并实网验证**。按公司/关键词查 → 缓存 → 6 维分级（P0-P3）→
> P0/P1 生成证据卡候选。Phase 4（问答补盲）/ Phase 5（盘后监控）未开始。

## 定位

让 agent **在需要时**去官方源（巨潮 / 交易所 / 互动易 / 问询函）**查、判断、筛选、
沉淀**，而不是把全市场公告无脑入库。pull（按需）模型，与 `skills/cninfo-rss`
的 push（定时全量扫）模型**共生不替代**。

## 源覆盖

| 源 | 数据 | 备注 |
| --- | --- | --- |
| `cninfo` | 巨潮公告 | 复用 `skills/cninfo-rss/scripts/fetch_cninfo.py`，零依赖直连，最稳 |
| `irm_szse` | 深互动易 | 深市/创业板互动问答（akshare） |
| `inquiry` | 监管问询函 | cninfo searchkey 路径 |
| `sse_einteract` | 上证 e 互动 | 科创板/沪市互动问答；**需 OpenSSL≥1.1 的 Python**（见下） |

## 快速上手（本机已有环境）

```bash
cd finhot/finhot
python3 -m disclosure_lookup.cli company 瑞华泰 --days 30
python3 -m disclosure_lookup.cli company 688323 --days 30 --source cninfo,sse_einteract
python3 -m disclosure_lookup.cli keyword "CoWoS" --days 30
python3 -m disclosure_lookup.cli evidence 瑞华泰 --days 30   # P0/P1 → 证据卡候选 YAML
python3 -m disclosure_lookup.cli cache --stats
```

> 以模块方式运行（`python3 -m disclosure_lookup.cli`）时，工作目录需为 `finhot/finhot/`（本包的父目录）。
> 每条输出带 `[P0]/[P1]/[P2]/[P3]` 分级，反证带 `[P0][反证]`。

## 在另一台 Mac 上跑

代码无硬编码路径，clone 即可用。步骤：

```bash
# 1. clone（含本包 + 复用的 skills/cninfo-rss）
git clone <repo-url> finhot && cd finhot/finhot

# 2. 建 venv 并装依赖（建议 brew python@3.12，OpenSSL 3.x，sse 源才稳）
/usr/local/bin/python3.12 -m venv ~/.venv-disclosure          # 或 brew install python@3.12 后
~/.venv-disclosure/bin/pip install -r disclosure_lookup/requirements.txt
# 国内网络慢可加清华镜像：-i https://pypi.tuna.tsinghua.edu.cn/simple

# 3. 跑（用 venv 的 python）
~/.venv-disclosure/bin/python -m disclosure_lookup.cli company 瑞华泰 --days 30
```

**说明**：
- 公告（cninfo）/ 深互动易（irm_szse）/ 问询函（inquiry）用系统 `python3` 也能跑。
- **上证 e 互动（sse_einteract）建议用 venv**：macOS 系统 Python 多为 LibreSSL，与 `sns.sseinfo.com` 握手不稳；OpenSSL≥1.1 的 Python + 代码层 `_no_proxy()`（绕 VPN 系统代理）才稳。详见 HANDOFF §4。
- 本地缓存（`.cache/`）与 uid 映射（`.cache/sse_uids.json`）每台机器各自一份，已 gitignore。

## 作为 Python 库调用

```python
from disclosure_lookup import lookup
for r in lookup.search_company("瑞华泰", days=30):
    print(r.triage_level, r.fact_type, r.title)   # P0/P1/P2/P3
```

## 分级口径（triage）

- **P0**：硬事实（订单/量产/扩产/客户验证）+ 反证（否认/澄清）→ 建议沉淀
- **P1**：需复核的进展（送样/小批量，互动答复感知）
- **P2**：官方但低价值 → 仅缓存
- **P3**：噪音（董事会决议/风险提示，命中 cninfo exclude_any）→ 忽略

## 目录

| 文件 | 职责 |
| --- | --- |
| `schema.py` | 统一数据契约 `DisclosureRecord` |
| `sources/` | 源适配器：`cninfo` / `irm`(深互动易+上证e互动) / `inquiry` |
| `cache.py` | SQLite cache-aside（TTL + 负缓存） |
| `triage.py` | 6 维打分 + 硬门槛定级 P0-P3（反证/噪音/进展词/否定式） |
| `evidence_card.py` | P0/P1 → YAML 证据卡候选（review-queue） |
| `lookup.py` | 编排入口（service 函数） |
| `cli.py` | 命令行（company/keyword/evidence/cache） |
| `tests/` | 离线单测（`python3 -m unittest discover`） |
