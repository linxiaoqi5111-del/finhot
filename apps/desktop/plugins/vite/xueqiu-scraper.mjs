/**
 * Xueqiu timeline scraper via headful Playwright.
 *
 * Xueqiu uses Aliyun WAF that blocks all non-browser HTTP clients (curl,
 * node-fetch, headless Chromium). We launch a real Chrome instance in headful
 * mode to pass the WAF challenge, then fetch the user timeline API from within
 * the authenticated browser context.
 *
 * Usage: node xueqiu-scraper.mjs <userId>
 * Output: JSON to stdout { statuses: [...], screenName: string }
 */

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const { chromium } = require("playwright")

const userId = process.argv[2]
if (!userId || !/^\d+$/.test(userId)) {
  throw new Error("Usage: node xueqiu-scraper.mjs <userId>")
}

const PROFILE_DIR = "/tmp/xq-pw-profile"

let context
try {
  context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    channel: "chrome",
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-blink-features=AutomationControlled",
      "--window-position=-2400,-2400",
      "--window-size=800,600",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
  })

  const page = context.pages()[0] || (await context.newPage())

  // Solve WAF: visit homepage first (don't use networkidle — xueqiu never stops polling)
  await page.goto("https://xueqiu.com", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  })
  await page.waitForTimeout(5_000)

  // Visit user page to establish context
  await page.goto(`https://xueqiu.com/u/${userId}`, {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  })
  await page.waitForTimeout(3_000)

  // Fetch timeline API from browser context (inherits WAF cookies)
  const timeline = await page.evaluate(async (uid) => {
    const resp = await fetch(`/v4/statuses/user_timeline.json?user_id=${uid}&type=10`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }, userId)

  // Get user screen name
  let screenName = userId
  try {
    const userTitle = await page.title()
    // Title is like "用户名 的个人主页 - 雪球"
    const nameMatch = userTitle.match(/^([^\s-]+(?:\s[^\s-]+)*)\s*(?:的个人主页|-\s*雪球)/)
    if (nameMatch) screenName = nameMatch[1].trim()
  } catch {
    // ignore
  }

  const output = {
    statuses: timeline?.statuses ?? [],
    screenName,
  }

  process.stdout.write(JSON.stringify(output))
} catch (err) {
  process.stderr.write(err.message || "Unknown error")
  throw err
} finally {
  if (context) await context.close().catch(() => {})
}
