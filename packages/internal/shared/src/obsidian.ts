type ObsidianFrontmatterValue = string | readonly string[]

export interface ObsidianFrontmatter {
  url: string
  author: string
  publishedAt: string
  description?: string
  tags: readonly string[]
  feedTitle?: string
  feedUrl?: string
}

const normalizeLineEndings = (value: string) => value.replaceAll(/\r\n?/g, "\n")

const isPlainYamlScalar = (value: string) => /^[\w-]+$/.test(value)

const formatYamlString = (value: string) => {
  const normalizedValue = normalizeLineEndings(value)
  if (!normalizedValue.includes("\n")) {
    return JSON.stringify(normalizedValue)
  }

  const lines = normalizedValue.replaceAll(/\n+$/g, "").split("\n")
  return ["|-", ...lines.map((line) => (line.length > 0 ? `  ${line}` : ""))].join("\n")
}

const formatYamlArrayItem = (value: string) => {
  const normalizedValue = normalizeLineEndings(value)
  return isPlainYamlScalar(normalizedValue) ? normalizedValue : JSON.stringify(normalizedValue)
}

const serializeYamlField = (key: string, value: ObsidianFrontmatterValue) => {
  if (typeof value !== "string") {
    return [`${key}:`, ...value.map((item) => `  - ${formatYamlArrayItem(item)}`)]
  }

  const [firstLine, ...restLines] = formatYamlString(value).split("\n")
  return [`${key}: ${firstLine}`, ...restLines]
}

const serializeOptionalStringField = (key: string, value: string | undefined) =>
  value ? serializeYamlField(key, value) : []

const formatPublishedAt = (value: string) => value.replace(/\.\d{3}Z$/, "").replace(/Z$/, "")

const serializeYamlRawField = (key: string, value: string) => [`${key}: ${value}`]

export const createObsidianFrontmatter = (metadata: ObsidianFrontmatter) => {
  const fields = [
    ...serializeYamlField("url", metadata.url),
    ...serializeYamlField("author", metadata.author),
    ...serializeYamlRawField("publishedAt", formatPublishedAt(metadata.publishedAt)),
    ...serializeOptionalStringField("description", metadata.description),
    ...serializeYamlField("tags", metadata.tags),
    ...serializeOptionalStringField("feedTitle", metadata.feedTitle),
    ...serializeOptionalStringField("feedUrl", metadata.feedUrl),
  ]

  return ["---", ...fields, "---"].join("\n")
}

// Taken from https://github.com/rollup/rollup/blob/4f69d33af3b2ec9320c43c9e6c65ea23a02bdde3/src/utils/sanitizeFileName.ts
// https://datatracker.ietf.org/doc/html/rfc2396
// eslint-disable-next-line no-control-regex
const INVALID_CHAR_REGEX = /[\u0000-\u001F"#$%&*+,:;<=>?[\]^`{|}\u007F/\\]/g
const DRIVE_LETTER_REGEX = /^[a-z]:/i

export function sanitizeObsidianFileName(name: string): string {
  const match = DRIVE_LETTER_REGEX.exec(name)
  const driveLetter = match ? match[0] : ""

  // A `:` is only allowed as part of a windows drive letter (ex: C:\foo)
  // Otherwise, avoid them because they can refer to NTFS alternate data streams.
  return driveLetter + name.slice(driveLetter.length).replaceAll(INVALID_CHAR_REGEX, "_")
}

export interface BuildObsidianNoteInput extends ObsidianFrontmatter {
  title: string
  content: string
}

export interface ObsidianNote {
  fileName: string
  markdown: string
}

export function buildObsidianNote(input: BuildObsidianNoteInput): ObsidianNote {
  const { title, content, ...metadata } = input

  const fileName = `${sanitizeObsidianFileName(title || metadata.publishedAt)
    .trim()
    .slice(0, 80)}.md`

  const frontmatter = createObsidianFrontmatter(metadata)

  const markdown = `${frontmatter}

# ${title}

${content}
`

  return { fileName, markdown }
}
