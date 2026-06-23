import fs from "node:fs"
import { createRequire } from "node:module"

import path from "pathe"

import legacyIconNames from "./icon-legacy-names.json" with { type: "json" }

type IconData = {
  body: string
  height?: number
  width?: number
}

type IconSet = {
  icons: Record<string, IconData>
  height?: number
  width?: number
}

type IconSource =
  | {
      collection: "logos" | "lucide" | "ph" | "simpleIcons"
      name: string
    }
  | {
      lobe: LobeIconName
    }
  | {
      custom: keyof typeof customIcons
    }

const require = createRequire(import.meta.url)

const logos = require("@iconify-json/logos/icons.json") as IconSet
const lucide = require("@iconify-json/lucide/icons.json") as IconSet
const simpleIcons = require("@iconify-json/simple-icons/icons.json") as IconSet

const OUTPUT_ICONS_FOLDER = "./icons/focal"
const LOBE_ICONS_FOLDER = path.dirname(require.resolve("@lobehub/icons-static-svg/package.json"))

const lobeIconNames = [
  "anthropic",
  "claude",
  "deepseek",
  "gemini",
  "groq",
  "grok",
  "lmstudio",
  "minimax",
  "mistral",
  "moonshot",
  "ollama",
  "openai",
  "openrouter",
  "qwen",
  "stepfun",
  "vercel",
  "volcengine",
  "xai",
  "zhipu",
] as const

type LobeIconName = (typeof lobeIconNames)[number]

const customIcons = {
  "focal-ai": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Focal AI</title><path fill="currentColor" d="M5.382 0h13.236A5.37 5.37 0 0 1 24 5.383v13.235A5.37 5.37 0 0 1 18.618 24H5.382A5.37 5.37 0 0 1 0 18.618V5.383A5.37 5.37 0 0 1 5.382.001Z"/><path fill="#fff" d="M13.269 17.31a1.813 1.813 0 1 0-3.626.002 1.813 1.813 0 0 0 3.626-.002m-.535-6.527H7.213a1.813 1.813 0 1 0 0 3.624h5.521a1.813 1.813 0 1 0 0-3.624m4.417-4.712H8.87a1.813 1.813 0 1 0 0 3.625h8.283a1.813 1.813 0 1 0 0-3.624z"/></svg>`,
  "focal-power": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Focal Power</title><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm1.38 3.6a1 1 0 0 1 .53 1.14l-1.1 4.02h3.06a1 1 0 0 1 .77 1.64l-5.85 6.97a1 1 0 0 1-1.73-.87l1.1-4.02H7.1a1 1 0 0 1-.77-1.64l5.85-6.97a1 1 0 0 1 1.2-.27Z"/></svg>`,
  "focal-power-mono": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Focal Power Mono</title><path fill="currentColor" d="m12.78 3.6-7.2 9.15a1.25 1.25 0 0 0 .98 2.02h3.18l-1.1 4.6a1.25 1.25 0 0 0 2.2 1.05l7.2-9.15a1.25 1.25 0 0 0-.98-2.02h-3.18l1.1-4.6a1.25 1.25 0 0 0-2.2-1.05Z"/></svg>`,
  "focal-power-outline": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><title>Focal Power Outline</title><path fill="none" stroke="currentColor" stroke-linejoin="round" stroke-width="2" d="M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z"/><path fill="currentColor" d="M13.22 6.15a.9.9 0 0 1 .48 1.02l-1.02 3.75h2.86a.9.9 0 0 1 .69 1.48l-5.43 6.46a.9.9 0 0 1-1.56-.78l1.02-3.75H7.4a.9.9 0 0 1-.69-1.48l5.43-6.46a.9.9 0 0 1 1.08-.24Z"/></svg>`,
} as const

const explicitSources: Record<string, IconSource> = {
  add_cute_fi: { collection: "lucide", name: "plus" },
  add_cute_re: { collection: "lucide", name: "plus" },
  alert_cute_fi: { collection: "lucide", name: "triangle-alert" },
  check_filled: { collection: "lucide", name: "check" },
  close_cute_re: { collection: "lucide", name: "x" },
  deepseek_original: { lobe: "deepseek" },
  focal_ai: { custom: "focal-ai" },
  folo_bot_original: { custom: "focal-ai" },
  loading_3_cute_li: { collection: "lucide", name: "loader-circle" },
  loading_3_cute_re: { collection: "lucide", name: "loader-circle" },
  power: { custom: "focal-power" },
  power_mono: { custom: "focal-power-mono" },
  power_outline: { custom: "focal-power-outline" },
  rada_cute_fi: { collection: "lucide", name: "radar" },
  rada_cute_re: { collection: "lucide", name: "radar" },
  safe_lock_filled: { collection: "lucide", name: "lock-keyhole" },
  moonshotai_original: { lobe: "moonshot" },
}

const brandSources: Record<string, IconSource> = {
  anthropic: { lobe: "anthropic" },
  apple: { collection: "simpleIcons", name: "apple" },
  discord: { collection: "simpleIcons", name: "discord" },
  facebook: { collection: "simpleIcons", name: "facebook" },
  github: { collection: "simpleIcons", name: "github" },
  github_2: { collection: "simpleIcons", name: "github" },
  google: { collection: "logos", name: "google-icon" },
  instagram: { collection: "simpleIcons", name: "instagram" },
  openai: { lobe: "openai" },
  openai_original: { lobe: "openai" },
  social_x: { collection: "simpleIcons", name: "x" },
  telegram: { collection: "simpleIcons", name: "telegram" },
  twitter: { collection: "simpleIcons", name: "x" },
  weibo: { collection: "simpleIcons", name: "sinaweibo" },
  youtube: { collection: "simpleIcons", name: "youtube" },
}

const extraFocalSources: Record<string, IconSource> = {
  "arrow-left-up": { collection: "lucide", name: "arrow-up-left" },
  "arrow-to-down": { collection: "lucide", name: "arrow-down-to-line" },
  "arrow-to-up": { collection: "lucide", name: "arrow-up-to-line" },
  anthropic: { lobe: "anthropic" },
  claude: { lobe: "claude" },
  deepseek: { lobe: "deepseek" },
  down: { collection: "lucide", name: "chevron-down" },
  "empty-box": { collection: "lucide", name: "package-open" },
  file: { collection: "lucide", name: "file" },
  gemini: { lobe: "gemini" },
  "group-2": { collection: "lucide", name: "users-round" },
  groq: { lobe: "groq" },
  grok: { lobe: "grok" },
  hashtag: { collection: "lucide", name: "hash" },
  "layout-right": { collection: "lucide", name: "panel-right" },
  left: { collection: "lucide", name: "chevron-left" },
  list: { collection: "lucide", name: "list" },
  "list-check": { collection: "lucide", name: "list-check" },
  "list-checks": { collection: "lucide", name: "list-checks" },
  lmstudio: { lobe: "lmstudio" },
  minimax: { lobe: "minimax" },
  minimize: { collection: "lucide", name: "minimize-2" },
  mistral: { lobe: "mistral" },
  monitor: { collection: "lucide", name: "monitor" },
  moonshot: { lobe: "moonshot" },
  news: { collection: "lucide", name: "newspaper" },
  ollama: { lobe: "ollama" },
  openrouter: { lobe: "openrouter" },
  qwen: { lobe: "qwen" },
  "rectangle-vertical": { collection: "lucide", name: "panel-left" },
  restore: { collection: "lucide", name: "rotate-ccw" },
  rss: { collection: "lucide", name: "rss" },
  square: { collection: "lucide", name: "square" },
  stepfun: { lobe: "stepfun" },
  sun: { collection: "lucide", name: "sun" },
  text: { collection: "lucide", name: "text" },
  "thumb-down": { collection: "lucide", name: "thumbs-down" },
  vercel: { lobe: "vercel" },
  volcengine: { lobe: "volcengine" },
  xai: { lobe: "xai" },
  zhipu: { lobe: "zhipu" },
}

const semanticAliases: Record<string, string | IconSource> = {
  ai: "sparkles",
  align_justify: "align-justify",
  align_left: "align-left",
  announcement: "megaphone",
  attachment: "paperclip",
  arrow_left: "arrow-left",
  arrow_right_circle: "circle-arrow-right",
  arrow_right_up: "square-arrow-out-up-right",
  arrow_up_circle: "circle-arrow-up",
  at: "at-sign",
  AZ_sort_ascending_letters: "arrow-down-a-z",
  AZ_sort_descending_letters: "arrow-down-z-a",
  back_2: "arrow-left",
  black_board_2: "presentation",
  book_6: "book-open",
  bookmark: "bookmark",
  brain: "brain",
  bubble: "message-circle",
  bug: "bug",
  calendar_time_add: "calendar-plus",
  celebrate: "party-popper",
  certificate: "badge-check",
  check: "check",
  check_circle: "circle-check",
  check_circle_filled: "circle-check",
  close_circle: "circle-x",
  classify_2: "layout-grid",
  comment: "message-circle",
  comment_2: "message-square-text",
  compass: "compass",
  compass_3: "compass",
  copy: "copy",
  copy_2: "copy",
  cursor_3: "mouse-pointer-click",
  danmaku: "messages-square",
  delete_2: "trash-2",
  department: "building-2",
  docment: "file-text",
  documents: "files",
  download_2: "download",
  edit: "square-pen",
  emoji_2: "smile",
  exit: "log-out",
  external_link: "square-arrow-out-up-right",
  eye_2: "eye",
  eye_close: "eye-off",
  fast_forward: "fast-forward",
  file_import: "file-down",
  file_upload: "file-up",
  filter: "funnel",
  finger_press: "pointer",
  flash: "zap",
  fire: "flame",
  flag_1: "flag",
  flashlight: "flashlight",
  folder_open: "folder-open",
  forward_2: "arrow-right",
  fullscreen: "maximize",
  fullscreen_2: "expand",
  fullscreen_exit: "minimize",
  ghost: "ghost",
  gift: "gift",
  grid: "layout-grid",
  grid_2: "grid-2x2",
  hammer: "hammer",
  heart: "heart",
  hexagon: "hexagon",
  history: "history",
  home_5: "house",
  hotkey: "keyboard",
  inbox: "inbox",
  information: "info",
  key_2: "key",
  layout_4: "panel-top",
  layout_leftbar_close: "panel-left-close",
  layout_leftbar_open: "panel-left-open",
  left: "chevron-left",
  left_small: "chevron-left",
  line: "minus",
  link: "link",
  list_check: "list-checks",
  list_check_2: "list-checks",
  list_check_3: "list-checks",
  list_collapse: "list-collapse",
  list_expansion: "list-plus",
  love: "heart",
  magic_2: "wand-sparkles",
  mail: "mail",
  mic: "mic",
  mind_map: "git-branch",
  minus_circle: "circle-minus",
  moon: "moon",
  more_1: "ellipsis",
  mountain_2: "mountain",
  music_2: "music",
  notification: "bell",
  numbers_09_sort_ascending: "arrow-down-0-1",
  numbers_09_sort_descending: "arrow-down-1-0",
  numbers_90_sort_ascending: "arrow-down-0-1",
  numbers_90_sort_descending: "arrow-down-1-0",
  paddle: "chart-line",
  paint_brush_ai: "paintbrush",
  palette: "palette",
  paper: "newspaper",
  paste: "clipboard-paste",
  pause: "pause",
  pdf: "file-text",
  photo_album: "images",
  pic: "image",
  play: "play",
  plugin_2: "plug",
  polygon: "pentagon",
  planet: "orbit",
  question: "circle-question-mark",
  quill_pen: "pen-line",
  refresh_2: "rotate-cw",
  refresh_4_ai: "rotate-cw",
  rewind_backward_15: "rewind",
  rewind_forward_30: "fast-forward",
  right: "chevron-right",
  right_small: "chevron-right",
  robot_2: "bot",
  route: "route",
  rocket: "rocket",
  round: "circle",
  rss: "rss",
  rss_2: "rss",
  sad: "frown",
  safe_alert: "shield-alert",
  safety_certificate: "shield-check",
  save: "save",
  search: "search",
  search_2: "search",
  search_3: "search",
  search_ai: "search",
  send_plane: "send",
  settings_1: "settings",
  settings_3: "settings-2",
  settings_7: "sliders-horizontal",
  share_forward: "share-2",
  shuffle_2: "shuffle",
  sort_ascending: "arrow-up-down",
  sort_descending: "arrow-down-up",
  stairs: { lobe: "stepfun" },
  star: "star",
  stop_circle: "circle-stop",
  terminal_box: "square-terminal",
  test_tube: "test-tube",
  thought: "message-circle-more",
  time: "clock",
  tool: "wrench",
  train: "train-front",
  translate_2: "languages",
  translate_2_ai: "languages",
  trending_up: "trending-up",
  triangle: "triangle",
  trophy: "trophy",
  user_3: "user",
  user_4: "circle-user-round",
  user_add_2: "user-plus",
  user_heart: "user-star",
  user_setting: "user-round-cog",
  up: "chevron-up",
  VIP_2: "crown",
  video: "video",
  vector_bezier_3: "route",
  voice: "audio-lines",
  volume: "volume-2",
  volume_mute: "volume-x",
  volume_off: "volume-off",
  wallet_2: "wallet",
  warning: "triangle-alert",
  wave_line: "audio-waveform",
  web: "globe",
  webhook: "webhook",
  wind: "wind",
  wifi_off: "wifi-off",
  world_2: "earth",
}

const unsupportedBrandLegacyNames = new Set<string>()

const collections = {
  logos,
  lucide,
  simpleIcons,
} satisfies Record<Extract<IconSource, { collection: string }>["collection"], IconSet>

const kebab = (name: string) => name.replaceAll("_", "-").toLowerCase()

const baseName = (iconName: string) =>
  iconName
    .replace(/_cute_(?:re|fi|li)$/, "")
    .replace(/_(?:filled|fill)$/, "")
    .replace(/_original$/, "")
    .replace(/_sharp$/, "")

const fillIcon = (iconName: string) => /(?:_cute_fi|_filled|_fill)$/.test(iconName)

const lineIcon = (iconName: string) => iconName.endsWith("_cute_li")

export const toFocalIconName = (legacyName: string) => {
  if (legacyName === "focal_ai" || legacyName === "folo_bot_original") return "focal-ai"
  if (legacyName === "power") return "power"
  if (legacyName === "power_mono") return "power-mono"
  if (legacyName === "power_outline") return "power-outline"
  if (legacyName === "moonshotai_original") return "moonshot"
  if (legacyName === "openai_original") return "openai"
  if (brandSources[baseName(legacyName)]) return kebab(baseName(legacyName))

  const suffix = fillIcon(legacyName) ? "-fill" : lineIcon(legacyName) ? "-line" : ""
  return `${kebab(baseName(legacyName))}${suffix}`
}

const hasIcon = (collection: keyof typeof collections, name: string) =>
  Boolean(collections[collection].icons[name])

const resolveSource = (legacyName: string): IconSource | null => {
  if (explicitSources[legacyName]) return explicitSources[legacyName]

  const base = baseName(legacyName)
  if (brandSources[base]) return brandSources[base]

  const semantic = semanticAliases[base]
  if (!semantic) return null
  if (typeof semantic !== "string") return semantic

  return hasIcon("lucide", semantic) ? { collection: "lucide", name: semantic } : null
}

const fromIconify = (source: Extract<IconSource, { collection: string }>) => {
  const iconSet = collections[source.collection]
  const icon = iconSet.icons[source.name]

  if (!icon) throw new Error(`Missing ${source.collection}:${source.name}`)

  const width = icon.width ?? iconSet.width ?? 24
  const height = icon.height ?? iconSet.height ?? 24

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${icon.body}</svg>`
}

const fromLobe = (name: LobeIconName) => {
  if (!lobeIconNames.includes(name)) throw new Error(`Unsupported lobe:${name}`)

  const svgPath = path.join(LOBE_ICONS_FOLDER, "icons", `${name}.svg`)
  if (!fs.existsSync(svgPath)) throw new Error(`Missing lobe:${name}`)

  return fs.readFileSync(svgPath, "utf8").trim()
}

const toSvg = (source: IconSource) =>
  "custom" in source
    ? customIcons[source.custom]
    : "lobe" in source
      ? fromLobe(source.lobe)
      : fromIconify(source)

const activeLegacyIconNames = legacyIconNames.filter(
  (name) => !unsupportedBrandLegacyNames.has(name),
)

const missingMappings = activeLegacyIconNames.filter((name) => !resolveSource(name))
if (missingMappings.length > 0) {
  throw new Error(`Missing replacements for: ${missingMappings.join(", ")}`)
}

fs.rmSync(OUTPUT_ICONS_FOLDER, { force: true, recursive: true })
fs.mkdirSync(OUTPUT_ICONS_FOLDER, { recursive: true })

const writtenIcons = new Set<string>()
for (const legacyName of activeLegacyIconNames) {
  const source = resolveSource(legacyName)
  if (!source) throw new Error(`Missing replacement for: ${legacyName}`)

  const focalIconName = toFocalIconName(legacyName)
  if (writtenIcons.has(focalIconName)) continue

  fs.writeFileSync(path.join(OUTPUT_ICONS_FOLDER, `${focalIconName}.svg`), `${toSvg(source)}\n`)
  writtenIcons.add(focalIconName)
}

for (const [focalIconName, source] of Object.entries(extraFocalSources)) {
  if (writtenIcons.has(focalIconName)) continue

  fs.writeFileSync(path.join(OUTPUT_ICONS_FOLDER, `${focalIconName}.svg`), `${toSvg(source)}\n`)
  writtenIcons.add(focalIconName)
}

console.info(`Updated ${writtenIcons.size} Focal icons from redistributable sources.`)
