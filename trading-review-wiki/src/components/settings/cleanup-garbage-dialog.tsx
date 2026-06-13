import { useState } from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { useWikiStore } from "@/stores/wiki-store"
import {
  cleanupGarbagePages,
  type GarbageReport,
  type GarbageProgress,
} from "@/lib/cleanup-garbage"
import { verifyAllSchemaV1 } from "@/lib/precondition"
import { Loader2, CheckCircle2, AlertTriangle, Trash2 } from "lucide-react"

type Phase = "confirming" | "checking" | "running" | "done" | "error" | "blocked"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function CleanupGarbageDialog({ open, onOpenChange }: Props) {
  const project = useWikiStore((s) => s.project)
  const [phase, setPhase] = useState<Phase>("confirming")
  const [progress, setProgress] = useState<GarbageProgress | null>(null)
  const [report, setReport] = useState<GarbageReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nonV1, setNonV1] = useState<string[]>([])

  function handleClose(next: boolean) {
    if (phase === "running" || phase === "checking") return
    if (!next) {
      setPhase("confirming")
      setProgress(null)
      setReport(null)
      setError(null)
      setNonV1([])
    }
    onOpenChange(next)
  }

  async function run() {
    if (!project) {
      setError("请先打开一个项目")
      setPhase("error")
      return
    }
    setPhase("checking")
    setError(null)
    try {
      const pre = await verifyAllSchemaV1(project.path)
      if (!pre.ok) {
        setNonV1(pre.non_v1_pages)
        setPhase("blocked")
        return
      }
    } catch (err) {
      setError(`前置检查失败: ${err instanceof Error ? err.message : String(err)}`)
      setPhase("error")
      return
    }

    setPhase("running")
    try {
      const r = await cleanupGarbagePages(project.path, (p) => setProgress(p))
      setReport(r)
      setPhase("done")
      // 刷新文件树
      const { listDirectory } = await import("@/commands/fs")
      const tree = await listDirectory(project.path)
      useWikiStore.getState().setFileTree(tree)
      useWikiStore.getState().bumpDataVersion()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase("error")
    }
  }

  function downloadReport() {
    if (!report) return
    const text = JSON.stringify(report, null, 2)
    const blob = new Blob([text], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `cleanup-garbage-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Trash2 className="size-5" />
            清理 wiki/源文档/ + wiki/查询/ 历史垃圾页
          </DialogTitle>
          <DialogDescription>
            扫描两个目录下的 .md 文件，识别 LLM 自动生成的"垃圾页"（chat 回复模板、空 slug 文件名、过短 body 等）。
            命中的文件**归档到 wiki/.conflicts/garbage-*/，不删除**，可手动恢复。
          </DialogDescription>
        </DialogHeader>

        {phase === "confirming" && (
          <div className="space-y-3 text-sm">
            <p>识别规则（任一命中即视为垃圾）：</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>title 以「好的，以下」/「&lt;think&gt;」/```/「Save to Wiki」开头</li>
              <li>title 为空 / 是 filename / 是默认 "Saved Query"</li>
              <li>文件名空 slug（仅日期前缀如 <code>-2026-05-10.md</code>）</li>
              <li>文件名是 <code>filename.md</code> / 以「数字+md-」起手 / 含双日期模式</li>
              <li>body 过短（&lt; 100 字符）</li>
            </ul>
            <p className="text-amber-700 dark:text-amber-400">
              ⚠️ 已自动 zip 备份整个 <code>wiki/</code> 到 <code>.llm-wiki/backups/cleanup-garbage-*.zip</code>。
              命中文件移到 <code>wiki/.conflicts/garbage-源文档/</code> 或 <code>garbage-查询/</code>。
            </p>
            <p className="text-xs text-muted-foreground">
              前置依赖：所有页面必须已是 schema_version=1。建议执行顺序：T23 迁移 → T25 body 残骸 → T24 目录归一 → T26（本工具）。
            </p>
          </div>
        )}

        {phase === "checking" && (
          <div className="flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin text-primary" />
            正在校验所有页面 schema_version=1…
          </div>
        )}

        {phase === "blocked" && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="size-5" />
              前置检查未通过：以下页面尚未升级到 Schema v1
            </div>
            <div className="max-h-40 overflow-auto rounded-md border bg-muted/30 p-2 text-xs font-mono">
              {nonV1.map((p) => (
                <div key={p}>{p}</div>
              ))}
              {nonV1.length === 20 && <div className="mt-1 text-muted-foreground">…（仅显示前 20 个）</div>}
            </div>
            <p className="text-muted-foreground">请先完成 Schema v1 迁移后再试。</p>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              {progress
                ? `处理 ${progress.current}/${progress.total} — ${progress.path}`
                : "正在备份并枚举文件…"}
            </div>
            {progress && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{ width: `${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%` }}
                />
              </div>
            )}
          </div>
        )}

        {phase === "done" && report && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 font-semibold text-emerald-600">
              <CheckCircle2 className="size-5" />
              清理完成
            </div>
            <div className="grid grid-cols-3 gap-3 rounded-md border p-3">
              <Stat label="扫描总数" value={report.total} />
              <Stat
                label="已归档"
                value={report.archived.length}
                color={report.archived.length > 0 ? "text-emerald-600" : ""}
              />
              <Stat
                label="错误"
                value={report.errors.length}
                color={report.errors.length > 0 ? "text-destructive" : ""}
              />
            </div>
            <div className="text-xs text-muted-foreground break-all">备份位置：{report.backup_path}</div>
            {report.archived.length > 0 && (
              <div className="rounded-md border bg-muted/20 p-3">
                <div className="mb-2 text-sm font-medium">归档明细（{report.archived.length} 项）</div>
                <div className="max-h-60 overflow-auto text-xs space-y-1.5">
                  {report.archived.slice(0, 80).map((a, i) => (
                    <div key={i} className="rounded border bg-background/50 p-1.5">
                      <div className="font-mono break-all">{a.original_rel}</div>
                      <div className="text-muted-foreground text-[11px]">
                        → {a.archived_rel}
                      </div>
                      <div className="text-amber-700 dark:text-amber-300 text-[11px]">
                        命中：{a.reasons.join("; ")}
                      </div>
                    </div>
                  ))}
                  {report.archived.length > 80 && (
                    <div className="text-muted-foreground">…仅显示前 80 项，下载 JSON 查看全部</div>
                  )}
                </div>
              </div>
            )}
            {report.errors.length > 0 && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                <div className="mb-2 text-sm font-medium text-destructive">失败明细（{report.errors.length} 项）</div>
                <div className="max-h-40 overflow-auto text-xs">
                  {report.errors.map((e, i) => (
                    <div key={i} className="mb-1 break-all">
                      <span className="font-mono">{e.path}</span> — {e.reason}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {phase === "error" && (
          <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive break-all">
            {error}
          </div>
        )}

        <DialogFooter>
          {phase === "confirming" && (
            <>
              <Button variant="outline" onClick={() => handleClose(false)}>取消</Button>
              <Button onClick={run} disabled={!project}>开始清理</Button>
            </>
          )}
          {(phase === "checking" || phase === "running") && (
            <Button disabled>
              <Loader2 className="mr-2 size-4 animate-spin" />
              {phase === "checking" ? "校验中…" : "处理中…"}
            </Button>
          )}
          {phase === "blocked" && <Button onClick={() => handleClose(false)}>关闭</Button>}
          {phase === "done" && (
            <>
              <Button variant="outline" onClick={downloadReport}>下载报告 JSON</Button>
              <Button onClick={() => handleClose(false)}>关闭</Button>
            </>
          )}
          {phase === "error" && <Button onClick={() => handleClose(false)}>关闭</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={`text-xl font-semibold ${color ?? ""}`}>{value}</div>
    </div>
  )
}
