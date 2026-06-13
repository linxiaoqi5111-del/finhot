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
  cleanupBodyResidue,
  type ResidueReport,
  type ResidueProgress,
} from "@/lib/cleanup-body-residue"
import { verifyAllSchemaV1 } from "@/lib/precondition"
import { Loader2, CheckCircle2, AlertTriangle, FileScan } from "lucide-react"

type Phase = "confirming" | "checking" | "running" | "done" | "error" | "blocked"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function BodyResidueDialog({ open, onOpenChange }: Props) {
  const project = useWikiStore((s) => s.project)
  const [phase, setPhase] = useState<Phase>("confirming")
  const [progress, setProgress] = useState<ResidueProgress | null>(null)
  const [report, setReport] = useState<ResidueReport | null>(null)
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
      const r = await cleanupBodyResidue(project.path, (p) => setProgress(p))
      setReport(r)
      setPhase("done")
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
    a.download = `body-residue-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileScan className="size-5" />
            清理 body 老 frontmatter 残骸
          </DialogTitle>
          <DialogDescription>
            扫描所有页 body 头部，识别并剖除老格式 frontmatter 残骸（如 `***` + title: ...）。先 zip 备份。
          </DialogDescription>
        </DialogHeader>

        {phase === "confirming" && (
          <div className="space-y-3 text-sm">
            <p>本次清理将：</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>识别 body 起点的老 frontmatter 残骸（<code>---</code>/<code>***</code>/```` ``` + --- ````）</li>
              <li>从严匹配：≥3 行字段结构 + 明确终止符 + 无 markdown 标题穿插</li>
              <li>抢救残骸里的 <code>sources</code> / <code>tags</code> / <code>aliases</code> 三类 list 字段，merge 到现有 frontmatter（去重）</li>
              <li>识别不确定的页面进 uncertain 列表，等你手动审核（不会动文件）</li>
            </ul>
            <p className="text-amber-700 dark:text-amber-400">
              ⚠️ 已自动 zip 备份到 <code>.llm-wiki/backups/body-residue-*.zip</code>，可解压恢复。
            </p>
            <p className="text-xs text-muted-foreground">
              前置依赖：所有页面必须已是 schema_version=1（即先跑过 "Schema v1 一次性迁移"）。
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
            <p className="text-muted-foreground">请先点击 "迁移 Wiki 到 Schema v1" 完成全库迁移后再试。</p>
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
              <Stat label="总文件" value={report.total} />
              <Stat label="已清理" value={report.cleaned} color="text-emerald-600" />
              <Stat label="不确定" value={report.uncertain.length} color={report.uncertain.length > 0 ? "text-amber-600" : ""} />
            </div>
            <div className="grid grid-cols-3 gap-3 rounded-md border p-3">
              <Stat label="抢救 sources" value={report.sources_rescued} />
              <Stat label="抢救 tags" value={report.tags_rescued} />
              <Stat label="抢救 aliases" value={report.aliases_rescued} />
            </div>
            <div className="text-xs text-muted-foreground break-all">备份位置：{report.backup_path}</div>
            {report.uncertain.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <div className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                  不确定项（{report.uncertain.length} 项，需手动审核）
                </div>
                <div className="max-h-60 overflow-auto text-xs space-y-2">
                  {report.uncertain.slice(0, 50).map((u, i) => (
                    <div key={i} className="rounded border bg-background/50 p-2">
                      <div className="font-mono break-all">{u.path}</div>
                      <div className="text-muted-foreground">原因: {u.reason}</div>
                      <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded bg-muted/50 p-1 text-[11px]">
{u.preview}
                      </pre>
                    </div>
                  ))}
                  {report.uncertain.length > 50 && (
                    <div className="text-muted-foreground">…仅显示前 50 项，下载 JSON 查看全部</div>
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
