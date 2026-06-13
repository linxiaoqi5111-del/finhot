import { describe, it, expect } from "vitest"
import { detectGarbagePage } from "@/lib/garbage-detector"
import type { WikiFrontmatter } from "@/lib/schema"

// 帮助：构造一个合法的"较长" body（>= 100 字符）
const LONG_BODY = "这是一段足够长的正文内容，用来满足 body 长度 >= 100 字符的要求，避免误触发短 body 检测规则。重复一下确保字符数足够：" +
  "这是一段足够长的正文内容，用来满足 body 长度 >= 100 字符的要求。"

function fm(partial: Partial<WikiFrontmatter>): Partial<WikiFrontmatter> {
  return partial
}

describe("detectGarbagePage — title 模式", () => {
  it("命中「好的，以下」", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "好的，以下是完整内容…" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中「好的，这是」", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "好的，这是分析" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中「好的，我」（v2 新增）", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "好的，我分批次提供完整更新页面" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中「好的，现在」（v2 新增）", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "好的，现在写入。" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中仅「好的」", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "好的。" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中 <think> 标签", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "<think>思考" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中 ``` 起手", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "```python\ncode" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中 Save to Wiki 自身回流", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "Save to Wiki: think" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中所有 Source: xxx 兜底（v2 扩展）", () => {
    expect(detectGarbagePage("a.md", fm({ title: "Source: save-to-wiki-2026-05-10.md" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("a.md", fm({ title: "Source: think-2026-04-19.md" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("a.md", fm({ title: "Source: research-deepseek.md" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("命中 queries/xxx 路径残留（v2 新增）", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "queries/明日预测" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("命中「以下是」/「这份」/「你可以」（v2 新增）", () => {
    expect(detectGarbagePage("a.md", fm({ title: "以下是分析" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("a.md", fm({ title: "这份文件信息密度极高" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("a.md", fm({ title: "你可以逐个保存" }), LONG_BODY).isGarbage).toBe(true)
  })
})

describe("detectGarbagePage — title 退化值", () => {
  it("title 为空", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
    expect(r.reasons).toContain("title 为空")
  })

  it("title 是 filename", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "filename" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("title 是 <think>", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "<think>" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("title 是默认 Saved Query", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "Saved Query" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })
})

describe("detectGarbagePage — 文件名模式", () => {
  it("空 slug + 可选 -N suffix（v2 修 bug）", () => {
    expect(detectGarbagePage("-2026-05-10.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("-2026-05-06-1.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("-2026-05-06-99.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("单字符/单数字 + 日期（v2 新增）", () => {
    expect(detectGarbagePage("2-2026-05-06.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("4-2026-05-04.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("a-2026-05-10.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("「数字+md-」起手", () => {
    const r = detectGarbagePage("51md-wiki-sav-2026-05-05.md", fm({ title: "龙头战法详解" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("以 8 位数字日期起手（v2 新增）", () => {
    expect(detectGarbagePage("20260503ai53md-wiki-2026-05-05.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("20260505ai55md-2026-05-07.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("filename.md", () => {
    const r = detectGarbagePage("filename.md", fm({ title: "龙头战法详解" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("含双日期模式", () => {
    const r = detectGarbagePage("2026-05-04-wiki-2026-05-05.md", fm({ title: "龙头战法详解" }), LONG_BODY)
    expect(r.isGarbage).toBe(true)
  })

  it("「think-日期」chat <think> 残留（v2 新增）", () => {
    expect(detectGarbagePage("think-2026-04-19.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("think-2026-04-22-15.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("「wiki-日期」Save to Wiki 残留（v2 新增）", () => {
    expect(detectGarbagePage("wiki-2026-05-02.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("wiki-2026-05-05-1.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("「markdown-日期」slug 错误命名（v2 新增）", () => {
    expect(detectGarbagePage("markdown-2026-05-05.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("「save-to-wiki-」按钮文本回流（v2 新增）", () => {
    expect(detectGarbagePage("save-to-wiki-2026-05-10.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("双 `--` slug 空字段（v2 新增）", () => {
    expect(detectGarbagePage("research--2026-04-22.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
    expect(detectGarbagePage("scale-up--2026-05-10.md", fm({ title: "龙头战法详解" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("「好的」中文开头的文件名（v2 新增）", () => {
    expect(detectGarbagePage("好的，现在写入。-2026-05-07.md", fm({ title: "X" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("日期 + 中文长串描述（v2 新增）", () => {
    expect(detectGarbagePage("2026-05-09-舆情文件的关键提炼.md", fm({ title: "X" }), LONG_BODY).isGarbage).toBe(true)
  })

  it("LLM 描述模板开头的文件名（v2 新增）", () => {
    expect(detectGarbagePage("这份-2026-05-07-的微信聊天舆情文件信息密度极高.md", fm({ title: "X" }), LONG_BODY).isGarbage).toBe(true)
  })
})

describe("detectGarbagePage — body 内容模式（v2 新增）", () => {
  it("body 含 <think> 推理过程", () => {
    const r = detectGarbagePage("a.md", fm({ title: "合法标题" }), LONG_BODY + "\n<think>这是 LLM 推理过程</think>")
    expect(r.isGarbage).toBe(true)
    expect(r.reasons.some((r) => r.includes("<think>"))).toBe(true)
  })

  it("body 含 [Binary file: ...]", () => {
    const r = detectGarbagePage("a.md", fm({ title: "合法标题" }), LONG_BODY + "\n[Binary file: xxx.pdf (1.2 MB)]")
    expect(r.isGarbage).toBe(true)
  })
})

describe("detectGarbagePage — body 过短", () => {
  it("body < 100 字符", () => {
    const r = detectGarbagePage("normal.md", fm({ title: "短笔记" }), "只有这几个字")
    expect(r.isGarbage).toBe(true)
    expect(r.reasons.some((r) => r.includes("body 过短"))).toBe(true)
  })
})

describe("detectGarbagePage — 合法页面（不应误判）", () => {
  it("合法中文 title + 合法文件名 + 长 body", () => {
    const r = detectGarbagePage("龙头战法-2026-05-11.md", fm({ title: "龙头战法-情绪周期分析" }), LONG_BODY)
    expect(r.isGarbage).toBe(false)
    expect(r.reasons).toEqual([])
  })

  it("合法英文 title", () => {
    const r = detectGarbagePage("trading-rules-2026-04-22.md", fm({ title: "Trading Rules 2026 Q2" }), LONG_BODY)
    expect(r.isGarbage).toBe(false)
  })

  it("合法 deep research 输出", () => {
    const r = detectGarbagePage(
      "research-deepseek-2026-04-20.md",
      fm({ title: "Research: DeepSeek V4.1 发布预期" }),
      LONG_BODY,
    )
    expect(r.isGarbage).toBe(false)
  })
})

describe("detectGarbagePage — 多原因聚合", () => {
  it("title + filename 同时命中，reasons 都列出", () => {
    const r = detectGarbagePage(
      "-2026-05-10.md",
      fm({ title: "好的，以下是完整内容" }),
      "短",
    )
    expect(r.isGarbage).toBe(true)
    expect(r.reasons.length).toBeGreaterThanOrEqual(3) // title + filename + short body
  })
})
