<div align="center">

**中文** · [English](./README.en.md)

  <h1>🔥 FinHot · 金融热词雷达</h1>
  <p><strong>本地优先的金融信息监控平台</strong></p>
  <p>监控财经快讯中的突发热词，量化热度与炒作浓度</p>
</div>

<p align="center">
  <img src="https://img.shields.io/badge/license-AGPL--3.0-blue" alt="license"/>
  <img src="https://img.shields.io/badge/based_on-Focal_(Folo_fork)-orange" alt="base"/>
  <img src="https://img.shields.io/badge/status-Phase_0-green" alt="status"/>
</p>

---

## 它是什么

FinHot 基于 [Focal](https://github.com/nextcaicai/Focal)（[Folo/RSSNext](https://github.com/RSSNext/Folo) 的 fork）构建，复用其成熟的 RSS 订阅引擎、本地 SQLite 数据库、BYOK AI 增强框架和 Electron 桌面壳，专注于**金融热词监控**场景：

- 📡 **多源采集** — RSS 财经快讯 + 微博/雪球 watchlist
- 🔥 **热词引擎** — 分词 + n-gram + 突发检测 + 热度评分
- 📊 **A股炒作浓度** — 自动标注含炒作信号的热词
- 📰 **金融简报** — AI 自动生成每日精选
- 🖥️ **桌面应用** — macOS/Windows/Linux，本地优先

## 技术架构

```
Electron (桌面壳)
├── Renderer (Vite + React)
│   ├── 热词看板 (趋势图/突发词/炒作浓度)
│   ├── RSS 时间线 (Smart Feeds: 监管/产品/行业/研报/观点)
│   └── AI 简报面板
├── Main Process
│   ├── RSS 定时采集
│   ├── 热词分析引擎
│   └── 本地 SQLite (Drizzle ORM)
└── Shared Packages
    ├── @follow/components (UI 组件库)
    ├── @follow/utils (工具函数)
    └── @follow/database (数据层)
```

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发模式（浏览器，推荐）
cd apps/desktop && pnpm run dev:web

# 完整 Electron 开发
cd apps/desktop && pnpm run dev:electron

# 构建
pnpm run build:web
```

## 路线图

- [x] Phase 0：Focal 底座 + 品牌定制
- [ ] Phase 1：预置金融 RSS 源
- [ ] Phase 2：热词分析引擎（TypeScript）
- [ ] Phase 3：金融看板 UI
- [ ] Phase 4：AI 简报 + 推荐排序

## 致谢

- [Focal](https://github.com/nextcaicai/Focal) — 本地优先 RSS 阅读器
- [Folo (RSSNext)](https://github.com/RSSNext/Folo) — 上游 RSS 平台
- [finhot (zycyyyya)](https://github.com/zycyyyya/finhot) — 金融热词 Agent Skill 灵感

## 许可证

[AGPL-3.0](./LICENSE)
