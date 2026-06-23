# AI RSS Reader - Layer 1 Content Scoring System

## Overview

目标：

解决信息源过多时无法逐篇阅读的问题。

系统通过：

```text
Content Type Detection
↓
Type-specific Rubric
↓
Quality Score
↓
Feed Ranking
```

帮助用户优先阅读最有价值的内容。

注意：

当前阶段不考虑个性化推荐。

只评估：

```text
内容本身是否值得阅读
```

而不是：

```text
用户是否喜欢阅读
```

---

# Architecture

```text
RSS Item
↓
Content Extraction
↓
Content Type Detection
↓
Feature Extraction
↓
Type-specific Rubric
↓
Quality Score
↓
Feed Ranking
```

---

# Core Principle

AI 不直接输出最终分数。

错误方式：

```json
{
  "quality_score": 87
}
```

正确方式：

```json
{
  "information_gain": 4,
  "depth": 5,
  "evidence": 3,
  "actionability": 5,
  "originality": 4,
  "signal_density": 4
}
```

系统负责计算最终分数。

这样便于后期调整权重。

---

# Content Type Detection

## Goal

识别内容属于什么知识类型（Knowledge Type）。

支持多标签。

例如：

```json
{
  "CaseStudy": 0.6,
  "Tutorial": 0.3,
  "Opinion": 0.1
}
```

不要强制单分类。

---

# Knowledge Types

## Workflow

回答：

```text
高手是如何工作的？
```

Examples:

- Claude Code Workflow
- Agent Workflow
- Research Workflow
- Product Workflow

Signals:

- workflow
- pipeline
- process
- automation
- system design
- end-to-end

Priority:

Highest

---

## Case Study

回答：

```text
别人是怎么做的？
```

Examples:

- 公司实践
- 项目复盘
- Agent落地案例

Signals:

- we built
- we tried
- we tested
- our experience
- lessons learned

Priority:

Highest

---

## Tutorial

回答：

```text
教我怎么做？
```

Examples:

- Claude Code Tutorial
- MCP Tutorial
- Prompt Guide

Signals:

- tutorial
- guide
- walkthrough
- step by step
- how to

Priority:

Highest

---

## Open Source Release

回答：

```text
出现了什么新工具？
```

Examples:

- Github Release
- New Framework
- New Agent

Signals:

- github
- repo
- release
- version
- changelog

Priority:

High

---

## Opinion

回答：

```text
别人怎么看？
```

Examples:

- Long-form Blog
- Analysis
- Commentary

Signals:

- I think
- my opinion
- my perspective
- analysis

Priority:

High

---

## Research

回答：

```text
有什么新发现？
```

Examples:

- Paper
- Benchmark
- Experiment

Signals:

- experiment
- evaluation
- benchmark
- paper
- methodology

Priority:

Medium

---

## Product Update

回答：

```text
产品更新了什么？
```

Examples:

- Cursor Update
- Claude Update
- Figma Update

Signals:

- announcement
- update
- new feature
- release note

Priority:

Medium

---

## News

回答：

```text
发生了什么？
```

Examples:

- Funding
- Acquisition
- Industry News

Signals:

- announced
- raised
- acquired
- partnership

Priority:

Low

---

# Type Weight

Initial Weight Configuration

```yaml
Workflow: 1.00

CaseStudy: 1.00

Tutorial: 1.00

OpenSourceRelease: 0.95

Opinion: 0.90

Research: 0.80

ProductUpdate: 0.70

News: 0.30
```

---

# Quality Dimensions

所有维度评分范围：

```text
0 ~ 5
```

最终转换为：

```text
0 ~ 100
```

---

# 1. Information Gain

问题：

```text
是否提供新的信息？
```

Scoring:

0 = Pure repost

1 = Repeated reporting

2 = Minor new details

3 = Multiple new facts

4 = First-hand information

5 = Original discovery

Feature Extraction:

```json
{
  "is_repost": false,
  "contains_new_facts": true,
  "contains_first_hand_info": true,
  "contains_original_discovery": false
}
```

Weight:

```text
20%
```

---

# 2. Depth

问题：

```text
内容是否足够深入？
```

Scoring:

0 = Clickbait

1 = News only

2 = Basic explanation

3 = Explains why

4 = Explains how

5 = Full systematic analysis

Feature Extraction:

```json
{
  "explains_what": true,
  "explains_why": true,
  "explains_how": true,
  "includes_case_study": true,
  "includes_limitations": false
}
```

Weight:

```text
25%
```

---

# 3. Evidence

问题：

```text
观点是否有证据支持？
```

Scoring:

0 = Pure opinion

1 = Personal feeling

2 = Third-party references

3 = Data

4 = Experiment

5 = Experiment + Data + Sources

Feature Extraction:

```json
{
  "has_statistics": true,
  "has_experiment": true,
  "has_citations": true,
  "has_reproducible_steps": false
}
```

Weight:

```text
15%
```

---

# 4. Actionability

问题：

```text
是否可以立即实践？
```

Scoring:

0 = Pure news

1 = Trend discussion

2 = Directional advice

3 = Actionable suggestions

4 = Step-by-step guidance

5 = Fully reproducible workflow

Feature Extraction:

```json
{
  "contains_recommendations": true,
  "contains_steps": true,
  "contains_workflow": true,
  "contains_reproducible_method": true
}
```

Weight:

```text
15%
```

---

# 5. Originality

问题：

```text
是否有原创内容？
```

Scoring:

0 = Repost

1 = AI summary

2 = Aggregation

3 = Personal viewpoint

4 = Personal practice

5 = Original framework

Feature Extraction:

```json
{
  "is_translation": false,
  "is_summary": false,
  "contains_personal_experience": true,
  "contains_original_framework": true
}
```

Weight:

```text
15%
```

---

# 6. Signal Density

问题：

```text
有效信息占比有多高？
```

Scoring:

0 = Mostly filler

1 = <10% useful information

2 = ~20%

3 = ~40%

4 = ~60%

5 = >80%

Feature Extraction:

```json
{
  "estimated_information_density": 0.72,
  "contains_redundancy": false,
  "contains_filler_content": false
}
```

Weight:

```text
10%
```

---

# Generic Quality Score Formula

```text
Quality Score

=
Information Gain × 0.20
+
Depth × 0.25
+
Evidence × 0.15
+
Actionability × 0.15
+
Originality × 0.15
+
Signal Density × 0.10
```

Convert:

```text
0~5
↓
0~100
```

---

# Type-Specific Rubric Adjustment

## Workflow

Boost:

- Actionability
- Originality
- Signal Density

Reduce:

- News value

---

## Case Study

Boost:

- Evidence
- Originality
- Actionability

---

## Tutorial

Boost:

- Actionability
- Depth

Reduce:

- Originality requirement

---

## Open Source Release

Boost:

- Information Gain
- Actionability

Reduce:

- Depth requirement

---

## Opinion

Boost:

- Originality
- Depth

Reduce:

- Actionability

---

## Research

Boost:

- Information Gain
- Evidence
- Depth

Reduce:

- Actionability

---

## Product Update

Boost:

- Information Gain
- Freshness

Reduce:

- Originality

---

## News

Boost:

- Information Gain
- Freshness

Reduce:

- Depth
- Actionability
- Originality

---

# AI Output Schema

```json
{
  "content_types": {
    "CaseStudy": 0.6,
    "Tutorial": 0.3,
    "Opinion": 0.1
  },

  "scores": {
    "information_gain": 4,
    "depth": 5,
    "evidence": 4,
    "actionability": 5,
    "originality": 3,
    "signal_density": 4
  },

  "quality_score": 86,

  "positive_reasons": [
    "Contains real-world case study",
    "Provides reproducible workflow",
    "High information gain"
  ],

  "negative_reasons": ["Limited quantitative evidence"]
}
```

---

# Future Roadmap

Layer 1:

```text
Content Type Detection
+
Quality Score
```

Layer 2:

```text
User Behavior Collection

Read
Star
Archive
Export to Obsidian
```

Layer 3:

```text
Preference Score
```

Layer 4:

```text
For You Feed
```

Current MVP Scope:

✅ Content Type Detection

✅ Type-specific Rubric

✅ Quality Score

❌ Personalization

❌ Recommendation

❌ Behavior Learning

```

```
