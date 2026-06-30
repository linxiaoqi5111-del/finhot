#!/usr/bin/env node
/**
 * Unified pre-commit hook (installed via `simple-git-hooks` on `pnpm install`).
 *
 * Why: `simple-git-hooks` and the Python `pre-commit` framework both own
 * `.git/hooks/pre-commit` and clobber each other. Previously `simple-git-hooks`
 * only ran `lint-staged`, so whenever it won the race the "红线" secret /
 * large-file / private-key guard from `.pre-commit-config.yaml` silently did
 * NOT run. This wrapper guarantees the guard runs regardless of which manager
 * is installed, then runs lint-staged.
 *
 *   1) Secret / forbidden-file guard:
 *        - prefer the Python `pre-commit` framework (uses .pre-commit-config.yaml)
 *        - fall back to a self-contained Node guard when `pre-commit` is absent
 *   2) lint-staged (formatting / lint).
 *
 * Bypass (人工确认后): `git commit --no-verify`.
 */
import { execSync, spawnSync } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"

const MAX_KB = 5120

function stagedFiles() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACM", {
    encoding: "utf8",
  })
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

function fail(msg) {
  console.error(`\n红线命中：${msg}`)
  console.error("如确需提交请人工确认并 git commit --no-verify。\n")
  process.exit(1)
}

/** Self-contained guard mirroring .pre-commit-config.yaml (used when `pre-commit` is not installed). */
function builtinGuard() {
  const forbidden =
    /(^|\/)(\.env($|\..+)|.*\.pem$|.*\.key$|.*\.pdf$|.*\.zip$|.*\.duckdb$|.*\.db$|.*\.pyc$|.*\.log$|\.DS_Store$|(\.venv|venv|env|node_modules|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.ipynb_checkpoints|\.cache)\/)/
  const allowExample = /\.env\.(example|sample|template)$/

  for (const file of stagedFiles()) {
    if (forbidden.test(file) && !allowExample.test(file)) {
      fail(`禁止提交的文件（密钥/大二进制/缓存/虚拟环境/依赖等）：${file}`)
    }
    if (!existsSync(file)) continue

    const kb = statSync(file).size / 1024
    if (kb > MAX_KB) fail(`新增大文件 ${Math.round(kb)}KB > ${MAX_KB}KB：${file}`)

    let buf
    try {
      buf = readFileSync(file)
    } catch {
      continue
    }
    if (buf.includes(0)) continue // skip binary

    const text = buf.toString("utf8")
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/.test(text)) {
      fail(`检测到私钥内容：${file}`)
    }
    if (/^<<<<<<< |^>>>>>>> /m.test(text)) {
      fail(`检测到合并冲突标记：${file}`)
    }
  }
}

function redlineGuard() {
  const hasPreCommit =
    spawnSync("pre-commit", ["--version"], { stdio: "ignore" }).status === 0
  if (hasPreCommit && existsSync(".pre-commit-config.yaml")) {
    const r = spawnSync("pre-commit", ["run", "--hook-stage", "pre-commit"], {
      stdio: "inherit",
    })
    if (r.status !== 0) process.exit(r.status || 1)
  } else {
    builtinGuard()
  }
}

function lintStaged() {
  const r = spawnSync("pnpm", ["exec", "lint-staged"], { stdio: "inherit" })
  if (r.status !== 0) process.exit(r.status || 1)
}

redlineGuard()
lintStaged()
