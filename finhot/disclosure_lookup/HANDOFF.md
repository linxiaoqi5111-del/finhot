# disclosure_lookup · HANDOFF

> 交接快照。设计见 `DESIGN.md`，本文件只记**当前进度 / 决策 / 坑 / 下一步**。
> 最后更新：2026-06-30（Phase 2 triage 落地）。

## 1. 现在在哪

- **Phase 1 (P1 MVP) 已完成并验证**：按公司/关键词查 → cache-aside → 多源归一 → 返回。
- **Phase 2 (triage P0-P3) 已完成并验证**：6 维打分 + 硬门槛定级 + 反证→P0 + cninfo 噪音→P3，已集成进 lookup/CLI（详见 §6）。
- **Phase 3 (证据卡) 已完成并验证**：P0/P1 → YAML 候选 → 知识库 disclosures review-queue；反证→`L3_negative`；CLI `evidence` 子命令按需生成（不自动落盘，避免噪音）。`is_reverse_evidence` 公开复用。
- **实网验（P1 收尾）**：`irm_szse` / `inquiry` / `sse_einteract` 全部实网跑通；Gap B（互动精度）已修（见 §5.9）。
- 五期节奏见 `DESIGN.md` §11。

## 2. Phase 1 实现清单（均已落地）

| 文件 | 状态 | 说明 |
| --- | --- | --- |
| `cache.py` | ✅ | SQLite cache-aside：`connect/init_db/is_fresh/get_cached/put_records/mark_review_status/purge_expired/stats`；CN_TZ +08:00；TTL 同格式字符串比较；upsert **不覆盖** `review_status` |
| `sources/cninfo.py` | ✅ | 复用 `fetch_cninfo`；新增 `top_search/resolve_orgid/name_of_code`；`_collect` 去重；公司查 stock(真实 orgId) + searchkey 兜底 |
| `sources/inquiry.py` | ✅ | searchkey(问询函/关注函/监管工作函/监管函) + 标题二次校验；用 `resolve_orgid` |
| `sources/irm.py` | ✅ | `irm_szse`(深互动易) + `sse_einteract`(上证e互动) via akshare；`_pick` 列名自适应 + 日期解析 + 窗口过滤 |
| `sources/__init__.py` | ✅ | `get_source` importlib 工厂 |
| `lookup.py` | ✅ | `search_company/keyword/event`、`_resolve_company`(topSearch)、`db_path`、`_enabled_sources`；单源失败优雅降级（warn 不中断） |
| `cli.py` | ✅ | `company` / `keyword` / `cache --stats/--purge-expired` |
| `schema.py` / `config.yaml` / `sources/base.py` | ✅(P0 既有) | 未改动 |

## 3. 验证状态

- **离线全过**：`python3 -m unittest disclosure_lookup.tests.test_smoke`(3/3)、cache 往返、`py_compile` 全模块。
- **实网已验**：`cninfo`——`company 688323 --days 30 --source cninfo` → **21 条真实公告，4.9s**，已入缓存。
- **实网未验**：`irm_szse` / `sse_einteract` / `inquiry`（代码就绪、SSL 已修，但尚未实网跑通一次）。
  - 注意 688323 是科创板(SSE)，**深互动易 `irm_szse` 对它本就为空**；验证互动易请用深市/创业板代码（如 `300750`）。
- **Phase 2 离线全过**：`python3 -m unittest disclosure_lookup.tests.test_triage`（**23 用例**）+ smoke 回归 + py_compile 全模块。核心断言与 PyYAML/网络解耦（反证走 `detect_negation`+锚点，问询靠 source 跳过 classify，定级规则用合成 dims 直测）。
- **Phase 2 真实数据验**：缓存里 688323 的 21 条公告跑 triage → 「股票交易风险提示公告」**正确落 P3**（exclude_any「风险提示」命中），其余转债赎回提示公告落 P2；本期窗口无订单/量产/否认类故无 P0/P1，符合实情。
- **Phase 2 classify 联调**：`签订重大合同/量产`→P0(hard_delta，fact_type 回填) / `拟签订`→P2(low_confidence 降级) / `irm 否认CoWoS`→P0(反证) / 问询函→P2 / irm 套话→P2(抑制)。
- **实网验（irm_szse/inquiry/sse_einteract）**：
  - `irm_szse 300750` ✅ 33 条互动问答（2.8s），SSL 修复对 `irm.cninfo.com.cn` 有效；**完整链路（源→triage→证据卡）在真实数据上跑通**。
  - `inquiry` ✅ 机制工作（全局「关注函」→ 安恒信息真实记录；`300750`=0 是它近 120 天无问询函，非 bug）。
  - `sse_einteract` ✅ **已修通**（瑞华泰 688323 实网拉到 70 条 PI膜/CoWoS/TGV/HBM 问答，自动捞出 3 条 P1：韩国半导体评测+小批量供货、下游送样评估）。**真根因是本机 VPN 系统代理**（非 SSL/服务端）：requests 默认走 macOS 系统代理，对国内源 `sns.sseinfo.com` 间歇握手超时。三层修法：① `irm._no_proxy()` 绕代理直连；② uid 映射文件缓存（`.cache/sse_uids.json`，避免每次爬 72 页 `allcompany.do`）；③ `_to_iso` 支持 `年月日`+相对日期。需用 venv 跑（见 §4）。

## 4. 环境改动（本机 `--user` 已生效）

- 装 `PyYAML 6.0.3`（`fetch_cninfo`/`config.yaml` 需要）。
- `urllib3` 从 `2.4.0` 降到 **`1.26.20`**：修系统 Python(LibreSSL 2.8.3) 下 akshare 触发的 `SSLEOFError`（打 `irm.cninfo.com.cn` / `sns.sseinfo.com` 握手失败）。`requirements.txt` 应钉 `urllib3<2`（**待确认是否已写入**）。
- **sse_einteract 用 venv 跑（+ 代码层 `_no_proxy` 绕代理）**：实测根因是 **VPN 系统代理**（requests 走它对 `sns.sseinfo.com` 超时），LibreSSL 的 TLS 是次要放大因素。已 brew 装 `python@3.12`(OpenSSL 3.6.2) 建 venv（TLS 稳），代码层 `irm._no_proxy()` 绕代理直连：
  - **venv 路径**：`~/.venv-disclosure`（Python 3.12.13 + OpenSSL 3.6.2 + akshare/pyyaml/urllib3<2，均就绪）
  - **用法**：`cd finhot/finhot && ~/.venv-disclosure/bin/python -m disclosure_lookup.cli company 瑞华泰 --days 30 --source cninfo,sse_einteract`
  - **装 deps**（默认 PyPI 在本机慢，用清华镜像）：`~/.venv-disclosure/bin/pip install -i https://pypi.tuna.tsinghua.edu.cn/simple akshare pyyaml 'urllib3<2'`
  - 实测：瑞华泰 70 条 SSE 问答拉通（首次 ~5min 建 uid 映射，后续命中缓存只拉问答页）。分级 `{P2:67, P1:3}`，无假阳性。
  - **残留（可选优化）**：akshare `stock_sns_sseinfo` 仍 `while True` 拉全部问答页（无日期截止），高活跃股（72 页）单次查询 ~2-3min。要更快可重写问答分页加日期截止（约 30 行），但当前已可用。

## 5. 关键决策 / 坑（务必先读）

1. **真实 orgId 是 cninfo 公司查的命门**：合成 `gssh0/gssz0+code` 只对部分主板有效，科创板 688 必须用 topSearch 返回的真实 orgId（如 `688323 → 9900041792`），否则**公告接口静默返回 0**。已由 `resolve_orgid()`（topSearch + 进程内缓存 + 合成兜底）解决。
2. **缓存里有调试残留**：修复前那次 `cninfo:688323:90d` 空水位（ttl 7天）。90 天查询在它过期前会**少返回 31–90 天的记录**（行表只有 ≤30 天的 21 条）。要干净起步：`rm -rf finhot/disclosure_lookup/.cache/`；否则 7 天自愈。
3. **负缓存（已修）**：空/瞬时失败结果现在写 `empty_ttl_days`(默认 1 天) 短水位（`lookup.py` 按 `recs` 是否为空切换 TTL），不再锁满 7 天。
4. **akshare 只在 `irm.py`/`inquiry.py` 方法内延迟 import**——别提到模块顶部，否则巨潮路径被 akshare 拖累（设计 §6 硬规则）。
5. **inquiry 源无需特判（Phase 2 结论，修正 §6 旧计划的担忧）**：原计划担心 inquiry 被 cninfo `exclude_any`「吃掉」。实测 inquiry 标题恒含「问询函/关注函」→ `classify` 必返回 None；但 triage 把 None 映射成 `fact_hardness=0`（**不是丢弃**），靠 `source_authority=3` 落 P2 进缓存——正合「问询函仅缓存」。回复里的反证由独立的 `detect_negation` 抓（不经 classify），命中→P0。故无需特判。
6. **P3 口径冲突已按 DESIGN §8 修（Phase 2）**：handoff §6 旧计划把 P3 简写成「否则 sa<2」，与 DESIGN §8「P3=命中 exclude_any 噪音」打架。已对齐 DESIGN：`triage` 在规则定级后加覆盖——cninfo 标题命中 `exclude_any` → P3（真实数据验：688323「风险提示公告」→P3）。反证优先级高于噪音，不被压 P3。`exclude_any` 仅对 `source==cninfo` 生效（为公告标题设计，不套互动/问询 excerpt）。
7. **Gap A 已补（产品进展软词 → P1）**：`fact_hardness` 只复用 cninfo 税法，词表无「送样/小批量/试产/批量供货/形成收入」，互动问答这类软进展原本落 P2。已加 `PRODUCT_PROGRESS` 词表 → 命中兜 `fh=2` → 进 P1 复核桶（区别于 classify 的 `hard_delta=3`）；回填 fact_type（送样→customer_validation，量产类→mass_production）。配套否定前缀防护 `_NEG_PREFIX`：term 前 2 字含 未/尚未/暂未/没/无 → 不当正向进展（避免「未送样」误升 P1）。inquiry 源不套。详见 §6。
8. **classify 否定式硬词假阳性（已修，§5.8）**：`尚未量产 / 未投产` 这类，classify 不看否定前缀，原本按「量产/投产」算 `hard_delta` → 假 P0。已修：`_classify_fact_hardness` 对 hard_delta 结果 parse `l3_match_reason` 拿命中词，用 `_keyword_negated`（复用 `_NEG_PREFIX`）查原文——命中词**全部出现**都被否定前缀修饰 → 降 `fh=1`（review），不当硬事实。
   - **时态否定 vs 断言否认的区分（设计决策）**：`尚未/暂未/未/没/无`（时态，常配「预计 Q4 量产」→偏中性）→ 降 review(P2)；`否认/澄清/不属实/并未`（断言性反证）→ 走 `detect_negation` → P0 反证。两套词表分离：时态在 `_NEG_PREFIX`，断言在 `NEGATION_PHRASES`。
9. **Gap B 已修（互动源答复感知）**：互动 record 的 title 是**投资者提问**，含「回购/量产」会被 classify 当 `hard_delta` → 假 P0（300750 实网样本：生成的 5 张候选里多数误判）。根因：classify 为公告**陈述句**设计，事实其实在**答复正文**。已修：`_text()` 对互动源（`irm_szse`/`sse_einteract`）只取 `raw_excerpt` 里 `||答复：` 之后的答复正文；无答复的纯提问 → 空 → `fh=0` → P2。`||答复：` 是 `irm.py` 与 triage 的契约（irm.py 已标注，改格式需同步 `triage._ANSWER_SEP`）。实网复验：300750 的 33 条从「5 张候选多数误判」降到「1 张真 P1」。**权衡**：答复独占会漏 terse 答复（问"何时量产"答"2027年"），但精度优先——terse 只降 P2（没丢），多数实质答复会重述主题词。

## 6. Phase 2（triage）实施记录 —— 已完成

**落地清单**

| 文件 | 改动 |
| --- | --- |
| `triage.py` | 填充 `score_dimensions / assign_level / triage`（原 `NotImplementedError`）；新增 `_fc_and_cfg`(复用 `fetch_cninfo`+`load_config`，进程缓存、失败降级)、`_analyze`(单次扫描，避免 classify 调两遍)、`detect_negation`(公开，CLI 复用)、`_is_noise`(纯函数) |
| `lookup.py` | `search_company` / `search_keyword` 在 `put_records` 前对 fresh 记录跑 `triage`（写回 `triage_level`/`triage_score`/`fact_type`）；缓存命中路径已有持久化分级，不重跑 |
| `cli.py` | `_print_records` 在 P0 + 命中否定词时追加 `[反证]` 标记 |
| `tests/test_triage.py` | 新增 23 用例（assign_level 规则表 / score 维度齐全且∈[0,3] / 反证强制 P0 / 噪音路由 P3 / detect_negation 含套话抑制） |

**打分（6 维各 0-3）**：`fact_hardness` 复用 `fetch_cninfo.classify`（`hard_delta→3` / `review_candidate→1` / `None→0`；inquiry 源跳过）；**另有 `PRODUCT_PROGRESS` 软词表**（送样/小批量/试产/批量供货/形成收入）兜 `fh=2`→P1（否定前缀紧贴者跳过、inquiry 不套，见 §5.7）；`source_authority` 取 `rec.source_authority`；`lifecycle_impact` 由 fact_type 映射（`customer_validation→3`，order/量产/扩产→2，业绩/认证/重组类→2，其余→1，反证→3）；`company_relevance`/`novelty`/`market_relevance` 占位（context 钩子 `company_keywords`/`seen_doc_hashes`/`watchlist_codes` 就绪，待 watchlist 填充 + :8077 embedding 语义去重）。

**定级（`assign_level` 硬门槛）+ 覆盖（`triage`）**：
- 规则：P0=`fh≥3 且 li≥2` / P1=`fh≥2` / P2=`sa≥2` / 否则 P3；`score`=按 `triage.weights` 加权求和，**仅同级内排序**。
- 覆盖（规则之后，优先级）：**反证→P0** > **cninfo 噪音(exclude_any)→P3** > 规则定级。

**反证**：`detect_negation` 用多字强否认词（否认/澄清/不属实/传闻不实/失实/并未/未涉及…），刻意避开裸「未/无」误伤（会命中「未来/尚未」）；命中 + 题材锚点（有 fact_type / 命中查询关键词 / 来自互动问询源）→ 强制 `fh=3, li=3`→P0。合规套话（应披露而未披露/未发现/不构成…）抑制；强词覆盖套话。⚠ `evidence_layer=L3_negative` 的落字是 Phase 3 证据卡的职责，本期只顶到 P0；`is_negative` 现为 triage 内部态。

**复用路径**：`triage._fc_and_cfg()` → `sources.cninfo._load_fc()`（sys.path 注入 cninfo-rss/scripts）→ `fc.classify` + `fc.load_config()`（cninfo-rss 税法：include/exclude/combo/low_confidence/fact_type）。无需读 `config.yaml reuse.cninfo_rss_config`，直接走 fetch_cninfo 自己的 loader。

## 7. 下一步

- **Phase 3（证据卡）已完成**：`evidence_card.py` 实现 `from_record / to_yaml / write_candidate / generate_candidates / resolve_kb_dir`；`is_reverse_evidence(record)` re-derive（不加 schema/cache 字段）。CLI 新增 `evidence` 子命令。**占位待补**：`lifecycle_impact`（正向）/`theme_links`（真主题映射）需题材知识，Phase 3 留空 / 用 matched_keywords，待 P4 wiki 缺口检测或 LLM 注入；纯反证的 `fact_type` 常为 null（否认词不在 cninfo `include_any`）。
- **Gap A 已补**（§5.7）：`PRODUCT_PROGRESS` 词表 → P1，配套否定前缀防护。
- **classify 否定式硬词假阳性（§5.8）已修**：`_keyword_negated` parse 命中词查否定前缀 → 时态否定降 review、断言否认仍 P0 反证。
- **负缓存已修**（⑤①）：空结果写 `empty_ttl_days`(默认 1 天) 短水位，不再锁满 7 天；`config.yaml cache.empty_ttl_days` 可调。
- **三源全部实网通过**（§3）：irm_szse / inquiry / sse_einteract（venv + `_no_proxy` + uid 缓存 + `_to_iso` 日期修复后）。
- **Gap B（互动精度）已修**（§5.9）：`_text()` 互动源只取答复正文；irm.py 标注 `||答复：` 契约。实网验 300750 精度恢复正常。
- **缓存已清**（⑤③）：`rm -rf .cache/`，调试残留（`cninfo:688323:90d` 空水位 + 未分级旧记录）已清；重查后记录带分级（实测 `by_level: {P2:20, P3:1}`）。

## 8. 怎么跑（cwd = `finhot/finhot/`）

```bash
python3 -m disclosure_lookup.cli company 688323 --days 30 --source cninfo
python3 -m disclosure_lookup.cli company 瑞华泰 --days 30        # 名→code 走 topSearch
python3 -m disclosure_lookup.cli keyword "CoWoS" --days 30
python3 -m disclosure_lookup.cli evidence 瑞华泰 --days 30        # P0/P1 → 证据卡候选写盘（按需，不自动）
python3 -m disclosure_lookup.cli cache --stats
python3 -m unittest disclosure_lookup.tests.test_smoke disclosure_lookup.tests.test_triage disclosure_lookup.tests.test_evidence_card
```
