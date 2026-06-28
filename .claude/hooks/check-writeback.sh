#!/bin/sh
# planning-with-files 之外的独立 Stop hook：本 session 在 repo 有改动却没回写记忆底座时，
# 拦截结束并提示模型按 devin-writeback.md 回写。仅在「有改动」时触发，避免打扰纯问答会话。
set -u

# 读取 Stop hook 的 stdin JSON；若是 hook 触发的二次结束(stop_hook_active)则放行，防死循环
input="$(cat 2>/dev/null || true)"
case "$input" in *'"stop_hook_active":true'*) exit 0 ;; esac

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || exit 0
repo="$(basename "$repo_root")"

V="$repo_root/.agent-memory"
[ -d "$V" ] || V="/Users/a77/agent-memory"
[ -d "$V" ] || exit 0
note="$V/20_projects/$repo.md"

# 是否「有改动」：工作树有未提交改动，或本地领先上游(已 commit 未沉淀)
dirty="$(git -C "$repo_root" status --porcelain 2>/dev/null)"
ahead="$(git -C "$repo_root" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
if [ -z "$dirty" ] && [ "${ahead:-0}" = "0" ]; then
  exit 0
fi

# 项目笔记最近 10 分钟内被改过 → 视为已回写，放行（也防止回写后再次拦截）
if [ -f "$note" ] && [ -n "$(find "$note" -mmin -10 2>/dev/null)" ]; then
  exit 0
fi

# 否则拦截结束，要求按 playbook 回写
reason="本次在 $repo 有代码改动但还没回写记忆底座。请按 .agent-memory/40_playbooks/devin-writeback.md：把本次关键结论/决策追加到 .agent-memory/20_projects/$repo.md 的「交接记录」（可复用知识提炼进 .agent-memory/10_knowledge/），写完再结束。若本次确实无需沉淀，在交接记录加一行『$(date +%F)：无实质改动』即可。"
printf '{"decision":"block","reason":%s}\n' "$(printf '%s' "$reason" | python3 -c 'import json,sys;print(json.dumps(sys.stdin.read()))')"
exit 0
