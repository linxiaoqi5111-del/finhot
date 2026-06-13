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
  migrateWikiSchemaV1,
  type MigrateReport,
  type MigrateProgress,
} from "@/lib/migrate-schema-v1"
import { Loader2, CheckCircle2, AlertTriangle, ArrowUpCircle } from "lucide-react"

type Phase = "idle" | "confirming" | "running" | "done" | "error"

interface MigrateSchemaDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MigrateSchemaDialog({ open, onOpenChange }: MigrateSchemaDialogProps) {
  const project = useWikiStore((s) => s.project)
  const [phase, setPhase] = useState<Phase>("confirming")
  const [progress, setProgress] = useState<MigrateProgress | null>(null)
  const [report, setReport] = useState<MigrateReport | null>(null)
  const [error, setError] = useState<string | null>(null)

  function handleClose(next: boolean) {
    if (phase === "running") return // block close during run
    if (!next) {
      // Reset state when closing
      setPhase("confirming")
      setProgress(null)
      setReport(null)
      setError(null)
    }
    onOpenChange(next)
  }

  async function runMigration() {
    if (!project) {
      setError("请先打开一个项目")
      setPhase("error")
      return
    }
    setPhase("running")
    setError(null)
    setReport(null)
    try {
      const r = await migrateWikiSchemaV1(project.path, (p) => setProgress(p))
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
    a.download = `migrate-schema-v1-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="size-5" />
            迁移 Wiki 到 Schema v1
          </DialogTitle>
          <DialogDescription>
            将现有 wiki 所有页面的 frontmatter 升级为 Schema v1。先自动 zip 备份到 .llm-wiki/backups/。
          </DialogDescription>
        </DialogHeader>

        {phase === "confirming" && (
          <div className="space-y-3 text-sm">
            <p>本次迁移将对所有 wiki/**/*.md 执行：</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>去除错误的 ```yaml frontmatter 包裹</li>
              <li>type 归一化（市场模式/进化/预测 → 模式 等）</li>
              <li>补 schema_version / last_reviewed / confidence / status 等必填字段</li>
              <li>清洗 sources 字段（去 LLM 回复前缀、去 .md 后缀）</li>
              <li>股票页根据 PG 数据库覆写 code</li>
              <li>时间戳补秒：2026-04-23 → 2026-04-23 00:00:00</li>
            </ul>
            <p className="text-amber-700 dark:text-amber-400">
              ⚠️ 该操作会改写所有页面 frontmatter。已自动 zip 备份到 .llm-wiki/backups/，如有问题可解压恢复。
            </p>
          </div>
        )}

        {phase === "running" && (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin text-primary" />
              {progress
                ? `正在处理 ${progress.current}/${progress.total} — ${progress.path}`
                : "正在备份并枚举文件…"}
            </div>
            {progress && (
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all"
                  style={{
                    width: `${Math.round((progress.current / Math.max(progress.total, 1)) * 100)}%`,
                  }}
                />
              </div>
            )}
          </div>
        )}

        {phase === "done" && report && (
          <div className="space-y-3 text-sm">
            <div className="flex items-center gap-2 font-semibold text-emerald-600">
              <CheckCircle2 className="size-5" />
              迁移完成
            </div>
            <div className="grid grid-cols-3 gap-3 rounded-md border p-3">
              <Stat label="总文件" value={report.total} />
              <Stat label="已迁移" value={report.migrated} color="text-emerald-600" />
              <Stat label="失败" value={report.errors.length} color={report.errors.length > 0 ? "text-destructive" : ""} />
            </div>
            <div className="text-xs text-muted-foreground break-all">
              备份位置：{report.backup_path}
            </div>
            {report.stocks_without_code.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <div className="mb-2 flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                  <AlertTriangle className="size-4" />
                  以下股票在 PG 数据库中未找到代码（需人工补填）：
                </div>
                <div className="max-h-32 overflow-auto text-xs">
                  {report.stocks_without_code.map((n) => (
                    <div key={n}>• {n}</div>
                  ))}
                </div>
              </div>
            )}
            {report.errors.length > 0 && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                <div className="mb-2 text-sm font-medium text-destructive">
                  失败明细（{report.errors.length} 项）
                </div>
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
              <Button variant="outline" onClick={() => handleClose(false)}>
                取消
              </Button>
              <Button onClick={runMigration} disabled={!project}>
                确认迁移
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button disabled>
              <Loader2 className="mr-2 size-4 animate-spin" />
              迁移中…
            </Button>
          )}
          {phase === "done" && (
            <>
              <Button variant="outline" onClick={downloadReport}>
                下载报告 JSON
              </Button>
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
