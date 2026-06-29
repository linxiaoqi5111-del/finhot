# FinHot — Claude Code 指引

> 本仓库以 `AGENTS.md` 为**单一事实源**（已整合 Cursor/Claude 指引、工程约定、Git 分支安全规则）。本文件仅供 **Claude Code** 自动加载：核心偏好内联在下，**完整规范请读本仓库 `AGENTS.md`**。

## 👤 用户偏好（核心，必读 —— 教学模式）

- **语言：中文。** 目标是**边做边学**（非科班背景），不只是把活干完。
- **讲原理 + 讲技术选型**：用到某技术先简述它是什么、为什么用；**务必给替代方案对比**（反复强调的重点）；能迁移到别处的知识点请点出“这在 X 场景也能用”。面试常考点可顺带点一句。
- **学习重点**：RAG、Hybrid 检索（向量 + BM25 + rerank）等；实现时优先选能学到主流/前沿做法的方案并解释取舍。
- **Git 约定**：开工先 `git status --short && git branch --show-current`；大任务必开分支（`<type>/<short-task>`），**合并 `main` 必须等我确认**，不强推；小文档修补可直接 `main`。
- 🚫 **红线**：禁提交 `.env*` / 密钥 / `*.pdf|zip|duckdb|db` / `.DS_Store` / 缓存或虚拟环境；不写明文密钥；不擅自合并 `main`、不强推。
- 完整偏好见 `.agent-memory/30_conventions/preferences.md`（repo 内软链 → `/Users/a77/agent-memory`，已 gitignore）。

## 🧠 共享记忆底座（开工前先读）

本机有一个跨 Agent 共享的记忆底座（Obsidian vault）：`/Users/a77/agent-memory`（仓库 `linxiaoqi5111-del/agent-memory`），repo 内可经软链 `.agent-memory/` 访问。

**开始任务前先读：**

- `.agent-memory/30_conventions/preferences.md` — 用户偏好与人设
- 本项目对应笔记 `.agent-memory/20_projects/finhot.md` — 项目背景、关键决策、任务看板

**完成后回写：** 把关键结论/决策追加到 `.agent-memory/20_projects/finhot.md` 的「交接记录」，可复用知识提炼进 `.agent-memory/10_knowledge/`。详细回写步骤见 `.agent-memory/40_playbooks/devin-writeback.md`。

## 完整规范

项目栈、命令、目录导览、Git 分支安全规则等详见本仓库 `AGENTS.md`。
