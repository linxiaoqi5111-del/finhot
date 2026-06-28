#!/usr/bin/env bash
# SessionStart hook: 把记忆底座(偏好 + 本项目笔记)注入 Claude Code 上下文。
# 在 Mac 本机经软链 .agent-memory 读取；软链不在则回退到绝对路径。
set -euo pipefail

V=".agent-memory"
[ -d "$V" ] || V="/Users/a77/agent-memory"

[ -d "$V" ] || exit 0   # vault 不可达(如在别的机器)就静默退出，不打扰

echo "# 记忆底座（SessionStart 自动注入）"
echo "> 以下为用户长期偏好与本项目笔记，请全程严格遵守（尤其教学模式：讲原理 + 技术选型/替代方案对比 + 标注可复用知识点；中文）。"
echo

if [ -f "$V/30_conventions/preferences.md" ]; then
  echo "## 用户偏好 (preferences.md)"
  cat "$V/30_conventions/preferences.md"
  echo
fi

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
remote="$(git -C "$repo_root" remote get-url origin 2>/dev/null || true)"
if [ -n "${remote:-}" ]; then repo="$(basename "${remote%.git}")"; else repo="$(basename "$repo_root")"; fi
note="$V/20_projects/$repo.md"
if [ -f "$note" ]; then
  echo "## 本项目笔记 ($repo)"
  cat "$note"
  echo
fi

echo "## Git 现状（开工先看）"
br="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
echo "当前分支：${br:-?}"
st="$(git status --short 2>/dev/null || true)"
if [ -n "$st" ]; then echo '```'; echo "$st"; echo '```'; else echo "(工作树干净)"; fi
echo "Git 约定：大任务开分支；合并 main 必须等确认，不强推。"
echo

echo "## 回写约定"
echo "完工后按 $V/40_playbooks/devin-writeback.md 把结论/决策回写到 $V/20_projects/$repo.md。"
