import { describe, expect, it } from "vitest"

import {
  parseYouTubeContent,
  parseYouTubeTime,
  parseYouTubeTranscript,
  secondsToYouTubeTime,
} from "./youtube-format"

describe("youtube-format", () => {
  it("formats seconds using YouTube-style timestamps", () => {
    expect(secondsToYouTubeTime(0)).toBe("00:00")
    expect(secondsToYouTubeTime(23)).toBe("00:23")
    expect(secondsToYouTubeTime(3723)).toBe("01:02:03")
  })

  it("parses transcript markdown with numeric timestamps", () => {
    const cues = parseYouTubeTranscript(`# Transcript

## Intro

0

- It's hard. It's hard to kill your existing business and start a new one.

0

- We launched our app.

23

- Every day since then we've been number one.
`)

    expect(cues).toEqual([
      {
        id: "0-0",
        time: "00:00",
        seconds: 0,
        text: "It's hard. It's hard to kill your existing business and start a new one. We launched our app.",
      },
      {
        id: "23-1",
        time: "00:23",
        seconds: 23,
        text: "Every day since then we've been number one.",
      },
    ])
  })

  it("parses bold timestamp lines from Defuddle markdown", () => {
    expect(parseYouTubeTranscript("## Transcript\n\n**0:01** Hello there")).toEqual([
      {
        id: "1-0",
        time: "00:01",
        seconds: 1,
        text: "Hello there",
      },
    ])
  })

  it("splits YouTube descriptions into paragraphs and chapter lists", () => {
    const blocks = parseYouTubeContent(`First paragraph.

https://meesho.com

Apply to Y Combinator: https://www.ycombinator.com/apply
Work at a startup: https://www.ycombinator.com/jobs

00:00 - Intro
00:33 - What is Meesho?
01:56 - 250 Million Buyers a Year`)

    expect(blocks).toEqual([
      {
        type: "paragraph",
        text: "First paragraph.",
      },
      {
        type: "paragraph",
        text: "https://meesho.com",
      },
      {
        type: "paragraph",
        text: "Apply to Y Combinator: https://www.ycombinator.com/apply\nWork at a startup: https://www.ycombinator.com/jobs",
      },
      {
        type: "chapters",
        items: [
          { time: "00:00", seconds: 0, title: "Intro" },
          { time: "00:33", seconds: 33, title: "What is Meesho?" },
          { time: "01:56", seconds: 116, title: "250 Million Buyers a Year" },
        ],
      },
    ])
  })

  it("finds chapter lists inside collapsed descriptions", () => {
    const blocks = parseYouTubeContent(
      "Apply: https://www.ycombinator.com/apply 00:00 - Intro 00:33 - What is Meesho?",
    )

    expect(blocks).toEqual([
      {
        type: "paragraph",
        text: "Apply: https://www.ycombinator.com/apply",
      },
      {
        type: "chapters",
        items: [
          { time: "00:00", seconds: 0, title: "Intro" },
          { time: "00:33", seconds: 33, title: "What is Meesho?" },
        ],
      },
    ])
  })

  it("parses time strings", () => {
    expect(parseYouTubeTime("1:23")).toEqual({ time: "01:23", seconds: 83 })
    expect(parseYouTubeTime("01:02:03")).toEqual({ time: "01:02:03", seconds: 3723 })
  })
})
