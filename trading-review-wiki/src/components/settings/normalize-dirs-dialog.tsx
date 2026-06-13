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
  normalizeWikiDirs,
  type NormalizeReport,
  type NormalizeProgress,
} from "@/lib/normalize-dirs"
import { verifyAllSchemaV1 } from "@/lib/precondition"
import { Loader2, CheckCircle2, AlertTriangle, FolderTree } from "lucide-react"

type Phase = "confirming" | "checking" | "running" | "done" | "error" | "blocked"

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function NormalizeDirsDialog({ open, onOpenChange }: Props) {
  const project = useWikiStore((s) => s.project)
  const [phase, setPhase] = useState<Phase>("confirming")
  const [progress, setProgress] = useState<NormalizeProgress | null>(null)
  const [report, setReport] = useState<NormalizeReport | null>(null)
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
      const r = await normalizeWikiDirs(project.path, (p) => setProgress(p))
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
    a.download = `normalize-dirs-report-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="size-5" />
            归一化 Wiki 目录结构
          </DialogTitle>
          <DialogDescription>
            把所有散乱目录（进化/市场模式/analysis/concept 等）合并到 9 个 canonical 中文目录。先 zip 备份。
          </DialogDescription>
        </DialogHeader>

        {phase === "confirming" && (
          <div className="space-y-3 text-sm">
            <p>本次归一化将：</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>合并散乱目录到 canonical：个股档案→股票、concept→概念、市场模式/进化/预测/市场环境→模式、people→人物、analysis/synthesis/comparisons→总结、queries→查询、sources→源文档</li>
              <li>跨目录重名 → 比较 frontmatter <code>updated</code>，保留较新；旧版移到 <code>wiki/.conflicts/</code></li>
              <li>frontmatter <code>type</code> 强制覆写为目录对应 canonical type</li>
              <li>所有 <code>[[type/name]]</code> wikilink 同步替换（避开代码块内）</li>
              <li>清理空目录与 LLM 残留垃圾目录（如 "好的，以下是完整的 [[策略/"）</li>
            </ul>
            <p className="text-amber-700 dark:text-amber-400">
              ⚠️ 移动 + 改写不可逆。已自动 zip 备份到 <code>.llm-wiki/backups/normalize-dirs-*.zip</code>。
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
                ? `${progress.phase === "type-overwrite" ? "覆写 type" : "处理"} ${progress.current}/${progress.total} — ${progress.path}`
                : "正在备份 + 移动文件 + 替换 wikilink…"}
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
              归一化完成
            </div>
            <div className="grid grid-cols-3 gap-3 rounded-md border p-3">
              <Stat label="移动文件" value={report.moved_files.length} color="text-emerald-600" />
              <Stat label="冲突归档" value={report.conflicts.length} color={report.conflicts.length > 0 ? "text-amber-600" : ""} />
              <Stat label="wikilink 替换" value={report.wikilinks_updated_total} />
            </div>
            <div className="grid grid-cols-3 gap-3 rounded-md border p-3">
              <Stat label="合并目录" value={report.dirs_merged.length} />
              <Stat label="删除空目录" value={report.dirs_removed.length} />
              <Stat label="失败" value={report.errors.length} color={report.errors.length > 0 ? "text-destructive" : ""} />
            </div>
            <div className="text-xs text-muted-foreground break-all">备份位置：{report.backup_path}</div>
            {report.conflicts.length > 0 && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
                <div className="mb-2 text-sm font-medium text-amber-700 dark:text-amber-300">
                  跨目录重名冲突（{report.conflicts.length} 项，旧版已归档至 .conflicts/）
                </div>
                <div className="max-h-40 overflow-auto text-xs space-y-1">
                  {report.conflicts.map((c, i) => (
                    <div key={i} className="break-all">
                      <span className="font-mono text-emerald-700 dark:text-emerald-400">保留</span> {c.kept_rel}
                      （updated={c.kept_updated}） · <span className="font-mono">归档</span> {c.archived_to_rel}（updated={c.loser_updated}）
                    </div>
                  ))}
                </div>
              </div>
            )}
            {report.uncategorized.length > 0 && (
              <div className="rounded-md border border-blue-300 bg-blue-50 p-3 dark:border-blue-800 dark:bg-blue-950/30">
                <div className="mb-2 text-sm font-medium text-blue-700 dark:text-blue-300">
                  未识别项（{report.uncategorized.length} 项，需手动审核）
                </div>
                <div className="max-h-32 overflow-auto text-xs">
                  {report.uncategorized.map((p, i) => (
                    <div key={i} className="break-all font-mono">{p}</div>
                  ))}
                </div>
              </div>
            )}
            {report.errors.length > 0 && (
              <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3">
                <div className="mb-2 text-sm font-medium text-destructive">失败明细（{report.errors.length} 项）</div>
                <div className="max-h-40 overflow-auto text-xs">
                  {report.errors.map((e, i) => (
                    <div key={i} className="mb-1 break-all">
                      <span className="font-mono">{e[0]}</span> — {e[1]}
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
              <Button onClick={run} disabled={!project}>开始归一化</Button>
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
