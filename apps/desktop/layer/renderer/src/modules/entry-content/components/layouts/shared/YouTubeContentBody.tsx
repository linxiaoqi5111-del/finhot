import { cn } from "@follow/utils"
import type { ReactNode } from "react"
import { useMemo } from "react"

import { parseYouTubeContent } from "./youtube-format"

const URL_REGEX = /https?:\/\/[^\s<]+[^\s<.,)]/g

interface YouTubeContentBodyProps {
  className?: string
  content: string
}

export const YouTubeContentBody: React.FC<YouTubeContentBodyProps> = ({ className, content }) => {
  const blocks = useMemo(() => parseYouTubeContent(content), [content])

  if (blocks.length === 0) return null

  return (
    <div
      className={cn(
        "cursor-auto select-text text-left text-[0.95rem] leading-[1.8] text-text-secondary",
        className,
      )}
    >
      {blocks.map((block) => {
        if (block.type === "chapters") {
          return (
            <div
              key={`chapters-${block.items[0]?.seconds}-${block.items.length}`}
              className="mb-6 space-y-0.5"
            >
              {block.items.map((item) => (
                <div
                  key={`${item.seconds}-${item.title}`}
                  className="flex items-baseline gap-3 leading-[1.8]"
                >
                  <span className="shrink-0 font-mono text-sm tabular-nums text-text-tertiary">
                    {item.time}
                  </span>
                  <span className="text-text-secondary">{item.title}</span>
                </div>
              ))}
            </div>
          )
        }

        return (
          <p
            key={`paragraph-${block.text.slice(0, 48)}`}
            className="mb-5 whitespace-pre-line last:mb-0"
          >
            {renderInlineLinks(block.text)}
          </p>
        )
      })}
    </div>
  )
}

function renderInlineLinks(text: string) {
  const matches = [...text.matchAll(URL_REGEX)]

  if (matches.length === 0) return text

  const nodes: ReactNode[] = []
  let lastIndex = 0

  matches.forEach((match) => {
    const url = match[0]
    const start = match.index ?? 0

    if (start > lastIndex) {
      nodes.push(text.slice(lastIndex, start))
    }

    nodes.push(
      <a
        key={`${url}-${start}`}
        className="inline-flex items-baseline gap-1 font-semibold text-accent transition-colors hover:text-accent/80"
        href={url}
        rel="noreferrer"
        target="_blank"
      >
        <span>{url}</span>
        <i className="i-focal-external-link size-[0.72em] translate-y-px" />
      </a>,
    )

    lastIndex = start + url.length
  })

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex))
  }

  return nodes
}
