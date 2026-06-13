import { describe, it, expect } from "vitest"
import { stripLegacyBodyResidue, mergeListField } from "@/lib/body-residue"

describe("stripLegacyBodyResidue", () => {
  it("正样本：*** 起头 + 字段块 + 终止 → 干净剖除", () => {
    const body = `***
title: 传艺科技
created: 2026-04-19
type: 个股档案
status: 活跃
---
# 真实正文标题

这是真实页面内容，至少要 50 字符以上才能通过 cleanedBody 长度阈值。再补一些字。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(true)
    expect(r.cleanedBody.startsWith("# 真实正文标题")).toBe(true)
    expect(r.cleanedBody).not.toContain("title: 传艺科技")
  })

  it("正样本：``` + --- + 字段 + sources list → 抢救 sources", () => {
    const body = `\`\`\`
---
title: 2026-05-06 开盘预测
created: 2026-05-05
type: 预测
sources:
  - 2026-04-30 交割单
  - 五一假期舆情
---
\`\`\`

# 预测正文

这是真实预测页面正文部分内容，需要确保长度足够通过保守度阈值检查 (50 字符以上)。再补充更多文字保证。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(true)
    expect(r.rescued.sources).toContain("2026-04-30 交割单")
    expect(r.rescued.sources).toContain("五一假期舆情")
    expect(r.cleanedBody.startsWith("# 预测正文")).toBe(true)
  })

  it("正样本：--- 起头 + 字段 + --- 终止", () => {
    const body = `---
title: X
type: 概念
status: 活跃
created: 2026-01-01
---

# 正文

正文内容长度足够通过保守度阈值检查，需要至少五十字符以上才能通过 cleanedBody 长度阈值，所以多写一点。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(true)
    expect(r.cleanedBody).not.toContain("title: X")
  })

  it("负样本：body 头是合法 markdown 标题 → 不剖", () => {
    const body = `# 真实标题

这是合法页面正文，应该完全保留不动。再写一些内容凑长度通过测试。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
    expect(r.cleanedBody).toBe(body)
  })

  it("负样本：body 头是 ```python 代码块 → 不剖", () => {
    const body = `\`\`\`python
def foo():
    return 42
\`\`\`

# 正文标题

代码示例下方是页面内容，需要保留代码块和标题。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
    expect(r.cleanedBody).toBe(body)
  })

  it("负样本：起点 + 字段块但含 markdown 标题 → 不剖（标题信号说明这不是残骸）", () => {
    const body = `---
title: X
type: 概念
# 这是标题不是字段
status: 活跃
---

正文`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
    expect(r.reason).toMatch(/heading/)
  })

  it("负样本：剖完后 cleanedBody 太短 → uncertain，不剖", () => {
    const body = `***
title: X
type: 概念
status: 活跃
---
小`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
    expect(r.reason).toMatch(/cleaned-too-short/)
    expect(r.cleanedBody).toBe(body)
  })

  it("负样本：找不到终点 → uncertain，不剖", () => {
    const body = `---
title: X
type: 概念
status: 活跃
created: 2026-01-01

后面没有 --- 终止符也没空行收束，直接是更多字段未结尾`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
  })

  it("负样本：字段太少（< 3）→ 不剖", () => {
    const body = `***
title: X
---

正文，这一段是真实正文内容长度足够通过 cleanedBody 阈值检查，再补字保证 50。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
    expect(r.reason).toMatch(/too-few-fields/)
  })

  it("负样本：起点之前有大量内容（超过 SCAN_WINDOW）→ 不剖", () => {
    const body = "正文行\n".repeat(25) + `***
title: X
type: 概念
status: 活跃
---
更多正文`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(false)
  })

  it("中文字段名兼容（预测日期）", () => {
    const body = `***
title: 预测页
type: 预测
预测日期: 2026-05-05
验证日期: 2026-05-06
status: 活跃
---

# 正文

预测页面真实正文，长度足够通过保守度阈值检查 (五十字符以上限制)，再补充一些文字凑数。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(true)
    expect(r.cleanedBody).not.toContain("预测日期: 2026-05-05")
  })

  it("rescue 不抢救业务字段，只抢救 sources/tags/aliases", () => {
    const body = `***
title: X
type: 预测
预测日期: 2026-05-05
sources:
  - A
  - B
tags:
  - hot
aliases:
  - X1
---

# 正文

正文长度需要通过保守度阈值的检查，必须超过五十字符以上才能通过测试断言，再补充一些文字凑数。`
    const r = stripLegacyBodyResidue(body)
    expect(r.certain).toBe(true)
    expect(r.rescued.sources).toEqual(["A", "B"])
    expect(r.rescued.tags).toEqual(["hot"])
    expect(r.rescued.aliases).toEqual(["X1"])
  })
})

describe("mergeListField 去重", () => {
  it("merge 去重", () => {
    expect(mergeListField(["A"], ["A", "B"])).toEqual(["A", "B"])
    expect(mergeListField(undefined, ["X"])).toEqual(["X"])
    expect(mergeListField(["A", "B"], [])).toEqual(["A", "B"])
    expect(mergeListField([], ["X", "X"])).toEqual(["X"])
  })
})
