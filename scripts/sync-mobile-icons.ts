import fs from "node:fs"

import path from "pathe"

const PROJECT_ICONS_DIR = "./icons/focal"
const MOBILE_ICONS_DIR = "./apps/mobile/src/icons"

const toComponentName = (fileName: string) =>
  `${fileName
    .replace(/\.svg$/, "")
    .split(/[_-]/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("")}Icon`

const toComponentSource = (
  componentName: string,
  svg: string,
) => `import type { SvgProps } from "react-native-svg"
import { SvgXml } from "react-native-svg"

const xml = ${JSON.stringify(svg)}

export const ${componentName} = (props: SvgProps) => <SvgXml xml={xml} {...props} />
`

if (!fs.existsSync(MOBILE_ICONS_DIR)) {
  console.info(`Skipped mobile icon sync: ${MOBILE_ICONS_DIR} does not exist in this checkout.`)
} else {
  const iconFiles = fs
    .readdirSync(PROJECT_ICONS_DIR)
    .filter((file) => file.endsWith(".svg"))
    .sort()

  for (const file of iconFiles) {
    const svg = fs.readFileSync(path.join(PROJECT_ICONS_DIR, file), "utf8").trim()
    const componentName = toComponentName(file)
    const targetFile = path.join(MOBILE_ICONS_DIR, file.replace(/\.svg$/, ".tsx"))

    fs.writeFileSync(targetFile, toComponentSource(componentName, svg))
  }

  console.info(`Synced ${iconFiles.length} mobile icon components from ${PROJECT_ICONS_DIR}.`)
}
