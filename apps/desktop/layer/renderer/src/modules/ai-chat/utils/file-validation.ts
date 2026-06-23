import { getI18n } from "~/i18n"

const MAX_IMAGE_ALLOWED_SIZE = 3 * 1024 * 1024
const MAX_DOCUMENT_ALLOWED_SIZE = 1 * 1024 * 1024
export const SUPPORTED_MIME_ACCEPT = "image/*,.pdf,.txt,.md"
export const SUPPORTED_FILE_TYPES = {
  // Images
  "image/png": { extension: "png", category: "image", maxSize: MAX_IMAGE_ALLOWED_SIZE },
  "image/jpeg": { extension: "jpg", category: "image", maxSize: MAX_IMAGE_ALLOWED_SIZE },
  "image/jpg": { extension: "jpg", category: "image", maxSize: MAX_IMAGE_ALLOWED_SIZE },
  "image/webp": { extension: "webp", category: "image", maxSize: MAX_IMAGE_ALLOWED_SIZE },
  "image/gif": { extension: "gif", category: "image", maxSize: MAX_IMAGE_ALLOWED_SIZE },

  // Documents
  "application/pdf": { extension: "pdf", category: "document", maxSize: MAX_DOCUMENT_ALLOWED_SIZE },
  "text/plain": { extension: "txt", category: "text", maxSize: MAX_DOCUMENT_ALLOWED_SIZE },
  "text/markdown": { extension: "md", category: "text", maxSize: MAX_DOCUMENT_ALLOWED_SIZE },
} as const

export type SupportedFileType = keyof typeof SUPPORTED_FILE_TYPES
export type FileCategory = (typeof SUPPORTED_FILE_TYPES)[SupportedFileType]["category"]

export interface FileValidationError {
  type: "unsupported" | "too_large" | "invalid"
  message: string
}

export interface FileValidationResult {
  isValid: boolean
  error?: FileValidationError
  fileInfo?: {
    type: SupportedFileType
    category: FileCategory
    extension: string
    maxSize: number
  }
}

export function validateFile(file: File): FileValidationResult {
  const i18n = getI18n()
  const fileType = file.type as SupportedFileType
  const fileInfo = SUPPORTED_FILE_TYPES[fileType]

  if (!fileInfo) {
    return {
      isValid: false,
      error: {
        type: "unsupported",
        message: i18n.t("file_validation.unsupported", {
          ns: "ai",
          type: file.type || "unknown",
        }),
      },
    }
  }

  if (file.size > fileInfo.maxSize) {
    return {
      isValid: false,
      error: {
        type: "too_large",
        message: i18n.t("file_validation.too_large", {
          ns: "ai",
          fileSize: formatFileSize(file.size),
          maxSize: formatFileSize(fileInfo.maxSize),
        }),
      },
    }
  }

  if (file.size === 0) {
    return {
      isValid: false,
      error: {
        type: "invalid",
        message: i18n.t("file_validation.empty_or_corrupted", { ns: "ai" }),
      },
    }
  }

  return {
    isValid: true,
    fileInfo: {
      type: fileType,
      category: fileInfo.category,
      extension: fileInfo.extension,
      maxSize: fileInfo.maxSize,
    },
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 Bytes"

  const k = 1024
  const sizes = ["Bytes", "KB", "MB", "GB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))

  return `${Number.parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

export function getFileCategoryFromMimeType(mimeType: string): FileCategory {
  // Images
  if (mimeType.startsWith("image/")) {
    return "image"
  }

  // Documents
  if (mimeType === "application/pdf") {
    return "document"
  }

  // Text files
  if (mimeType.startsWith("text/")) {
    return "text"
  }

  // Default fallback
  return "image"
}

export function getFileIconName(category: FileCategory): string {
  switch (category) {
    case "image": {
      return tw`i-focal-pic`
    }
    case "document": {
      return tw`i-focal-file`
    }
    case "text": {
      return tw`i-focal-text`
    }
    default: {
      return tw`i-focal-attachment`
    }
  }
}
