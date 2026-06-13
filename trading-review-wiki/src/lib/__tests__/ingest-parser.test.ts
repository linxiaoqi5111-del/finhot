import { describe, expect, it } from "vitest"
import { parseFileBlocks, tryExtractImplicitBlock } from "@/lib/ingest"

describe("parseFileBlocks", () => {
  it("解析标准 3 短横线 FILE block", () => {
    const text = `---FILE: wiki/股票/平安银行.md---\n---\ntype: 股票\n---\nbody\n---END FILE---`
    const blocks = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/股票/平安银行.md")
    expect(blocks[0].content).toContain("type: 股票")
    expect(blocks[0].content).not.toContain("END FILE")
  })

  it("容忍 4+ 短横线（弱模型常见）", () => {
    const text = `----FILE: wiki/概念/锂电.md----\n内容\n----END FILE----`
    const blocks = parseFileBlocks(text)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].path).toBe("wiki/概念/锂电.md")
  })

  it("剥掉路径外层的 ** 加粗", () => {
    const text = `---FILE: **wiki/股票/x.md**---\ncontent`
    const blocks = parseFileBlocks(text)
    expect(blocks[0].path).toBe("wiki/股票/x.md")
  })

  it("剥掉路径外层的反引号", () => {
    const text = "---FILE: `wiki/x.md`---\ncontent"
    const blocks = parseFileBlocks(text)
    expect(blocks[0].path).toBe("wiki/x.md")
  })

  it("缺失 END FILE 时仍能解析（内容到下一个 FILE 或 EOF）", () => {
    const text = `---FILE: wiki/a.md---\nA内容\n---FILE: wiki/b.md---\nB内容`
    const blocks = parseFileBlocks(text)
    expect(blocks).toHaveLength(2)
    expect(blocks[0].content.trim()).toBe("A内容")
    expect(blocks[1].content.trim()).toBe("B内容")
  })

  it("END FILE 大小写不敏感 + 多短横线", () => {
    const text = `---FILE: wiki/x.md---\nbody\n-----end file-----\n后续 LLM 啰嗦`
    const blocks = parseFileBlocks(text)
    expect(blocks[0].content.trim()).toBe("body")
  })

  it("无 FILE marker 时返回空", () => {
    expect(parseFileBlocks("纯文本，没有 marker")).toEqual([])
  })
})

describe("tryExtractImplicitBlock", () => {
  it("纯 frontmatter+body 当作 expectedPath 的内容", () => {
    const text = `---\ntype: 股票\ntitle: 平安银行\n---\n\n# 正文`
    const block = tryExtractImplicitBlock(text, "wiki/股票/平安银行.md")
    expect(block).not.toBeNull()
    expect(block!.path).toBe("wiki/股票/平安银行.md")
    expect(block!.content).toContain("type: 股票")
  })

  it("剥掉外层 markdown code fence", () => {
    const text = "```markdown\n---\ntype: 股票\n---\nbody\n```"
    const block = tryExtractImplicitBlock(text, "wiki/x.md")
    expect(block).not.toBeNull()
    expect(block!.content.startsWith("---")).toBe(true)
    expect(block!.content).not.toContain("```")
  })

  it("跳过前置寒暄行", () => {
    const text = `好的，以下是更新后的内容：\n---\ntype: 股票\n---\nbody`
    const block = tryExtractImplicitBlock(text, "wiki/x.md")
    expect(block).not.toBeNull()
    expect(block!.content.startsWith("---")).toBe(true)
  })

  it("不像 frontmatter 时返回 null", () => {
    expect(tryExtractImplicitBlock("我不能帮你做这个", "wiki/x.md")).toBeNull()
  })

  it("缺少 frontmatter 收尾分隔符时返回 null", () => {
    expect(tryExtractImplicitBlock("---\ntype: 股票", "wiki/x.md")).toBeNull()
  })
})
