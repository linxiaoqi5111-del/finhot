# FinHot 定时任务监控 (monitor)

对本机运行的 FinHot 链路（抓取 → 打分/富集 → 部署公网）做周期性自检。发现异常时弹一条
**macOS 桌面通知**，并始终写出机器可读的 `monitor-health.json`。

## 检查项

| #   | 检查               | 说明                                                                        |
| --- | ------------------ | --------------------------------------------------------------------------- |
| 1   | rss-proxy (:2233)  | `http://localhost:2233/api/public/manifest` 返回 200                        |
| 2   | embedding (:8077)  | `http://localhost:8077/v1/models` 返回 200                                  |
| 3   | devweb LaunchAgent | `com.finhot.devweb` 已加载且有存活 PID                                      |
| 4   | 缓存新鲜度         | 各平台（推特/雪球/微博/微信）最新 feed `updatedAt` 是否赶上最近一个调度时段 |
| 5   | 自动部署           | devweb 日志里最近一次部署是成功，而非 `Auto-deploy failed`（如 ETIMEDOUT）  |

新鲜度的"调度时段"与 `apps/desktop/plugins/vite/rss-proxy.ts` 里的 `planRefreshAt` 一致
（北京时间，UTC+8 固定）：

- 雪球/微博/推特：09:30–15:00 每 30 分钟 + 21:30 + 08:30
- 微信（公众号）：仅 21:30 + 08:30

只有当某个时段已过去 `MARKET_GRACE_MIN`/`WECHAT_GRACE_MIN` 分钟（留出抓取+部署时间）后，
才要求对应平台的缓存赶上；所以正常运行不会误报。

## 手动运行

```bash
python3 finhot/monitor/monitor.py          # 跑一次，打印摘要 + 写 health.json
python3 finhot/monitor/monitor.py --json   # 打印完整 health.json
python3 finhot/monitor/monitor.py --notify # 异常时弹 macOS 通知（LaunchAgent 用这个）
```

退出码：全绿 = 0，有失败 = 1。

## 常驻（LaunchAgent，每 10 分钟）

```bash
cp finhot/monitor/com.finhot.monitor.plist ~/Library/LaunchAgents/
launchctl unload ~/Library/LaunchAgents/com.finhot.monitor.plist 2>/dev/null
launchctl load   ~/Library/LaunchAgents/com.finhot.monitor.plist
launchctl start  com.finhot.monitor      # 立即跑一次
```

- 运行日志：`/tmp/finhot-monitor.log`
- 健康状态：`apps/desktop/.finhot-cache/monitor-health.json`
- 通知去重状态：`/tmp/finhot-monitor-state.json`

## 通知去重

为避免每 10 分钟刷屏：仅当**失败项集合发生变化**，或同一问题持续超过
`RENOTIFY_SEC`（默认 1 小时）时才再次通知；从异常恢复到全绿时会弹一条"已恢复"。

## 可调参数（monitor.py 顶部）

- `MARKET_GRACE_MIN` / `WECHAT_GRACE_MIN`：时段过后多久才要求缓存赶上
- `FRESH_TOLERANCE_MIN`：时钟/取整容差
- `RENOTIFY_SEC`：同一问题再次通知的最小间隔
- `FINHOT_REPO` 环境变量：仓库根路径（默认 `/Users/a77/khazix-skills`）
