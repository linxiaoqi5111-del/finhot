import { readability } from "@follow-app/readability"
import type { IpcContext } from "electron-ipc-decorator"
import { IpcMethod, IpcService } from "electron-ipc-decorator"
import type { ModelResult } from "vscode-languagedetection"

import { detectCodeStringLanguage } from "../../modules/language-detection"
import { fetchYouTubeDefuddle } from "../../modules/youtube-defuddle"

interface ReadabilityInput {
  url: string
  html?: string
}

interface YouTubeDefuddleInput {
  url?: string
  guid?: string
  language?: string
}

interface DetectCodeStringLanguageInput {
  codeString: string
}

export class ReaderService extends IpcService {
  static override readonly groupName = "reader"

  @IpcMethod()
  async readability(_context: IpcContext, input: ReadabilityInput) {
    const { url } = input

    if (!url) {
      return null
    }
    const result = await readability(url)

    return result
  }

  @IpcMethod()
  async youtubeDefuddle(_context: IpcContext, input: YouTubeDefuddleInput) {
    const { url, guid, language } = input
    if (!url && !guid) {
      return null
    }

    return fetchYouTubeDefuddle({ url, guid }, language)
  }

  @IpcMethod()
  async detectCodeStringLanguage(
    _context: IpcContext,
    input: DetectCodeStringLanguageInput,
  ): Promise<ModelResult | undefined> {
    const { codeString } = input
    const languages = detectCodeStringLanguage(codeString)

    let finalLanguage: ModelResult | undefined
    for await (const language of languages) {
      if (!finalLanguage) {
        finalLanguage = language
        continue
      }
      if (language.confidence > finalLanguage.confidence) {
        finalLanguage = language
      }
    }

    return finalLanguage
  }
}
