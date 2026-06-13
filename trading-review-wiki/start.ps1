# Trading Review Wiki - 启动脚本
# 用法：右键 -> 使用 PowerShell 运行，或在终端执行  .\start.ps1

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Trading Review Wiki - 开发模式启动中" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "工作目录：$PSScriptRoot" -ForegroundColor DarkGray
Write-Host "首次启动需编译 Rust 后端（约 1-2 分钟），后续启动有缓存会快很多。" -ForegroundColor DarkGray
Write-Host "应用窗口弹出后即可使用。关闭窗口将自动停止本脚本。" -ForegroundColor DarkGray
Write-Host ""

# ============================================================
# 确保 protoc 可用（lancedb 向量库的编译依赖）
# ============================================================
$ProtocVersion = "28.3"
$ProtocCacheDir = Join-Path $PSScriptRoot ".cache\protoc"
$ProtocExe = Join-Path $ProtocCacheDir "bin\protoc.exe"

function Ensure-Protoc {
    # 1. 优先用 PATH 里已有的 protoc
    $existing = Get-Command protoc -ErrorAction SilentlyContinue
    if ($existing) {
        $env:PROTOC = $existing.Source
        Write-Host "已检测到 protoc：$($existing.Source)" -ForegroundColor DarkGray
        return
    }

    # 2. 已缓存则直接用
    if (Test-Path $ProtocExe) {
        $env:PROTOC = $ProtocExe
        Write-Host "使用本地缓存的 protoc：$ProtocExe" -ForegroundColor DarkGray
        return
    }

    # 3. 下载并解压
    Write-Host "未检测到 protoc，正在下载 v$ProtocVersion ..." -ForegroundColor Yellow
    $zipUrl = "https://github.com/protocolbuffers/protobuf/releases/download/v$ProtocVersion/protoc-$ProtocVersion-win64.zip"
    $zipPath = Join-Path $env:TEMP "protoc-$ProtocVersion-win64.zip"

    try {
        New-Item -ItemType Directory -Force -Path $ProtocCacheDir | Out-Null
        # 关闭进度条以加速 Invoke-WebRequest
        $ProgressPreference = 'SilentlyContinue'
        Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing
        Expand-Archive -Path $zipPath -DestinationPath $ProtocCacheDir -Force
        Remove-Item $zipPath -Force -ErrorAction SilentlyContinue
    } catch {
        Write-Host "下载 protoc 失败：$_" -ForegroundColor Red
        Write-Host "请手动安装 protoc 后重试：https://github.com/protocolbuffers/protobuf/releases" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }

    if (-not (Test-Path $ProtocExe)) {
        Write-Host "protoc 解压后未找到可执行文件：$ProtocExe" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }

    $env:PROTOC = $ProtocExe
    Write-Host "protoc 已就绪：$ProtocExe" -ForegroundColor Green
}

Ensure-Protoc

# ============================================================
# 清理残留端口（上次崩溃 / 强关后 socket 未释放会导致 dev server 起不来）
# ============================================================
function Stop-StalePort {
    param([int]$Port, [string]$Label)

    $conns = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Listen' }
    if (-not $conns) { return }

    $procIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        $proc = Get-Process -Id $procId -ErrorAction SilentlyContinue
        if (-not $proc) { continue }
        Write-Host "检测到 $Label 端口 $Port 被占用：PID=$procId ($($proc.ProcessName))，正在终止..." -ForegroundColor Yellow
        try {
            Stop-Process -Id $procId -Force -ErrorAction Stop
        } catch {
            Write-Host "  终止失败：$_" -ForegroundColor Red
        }
    }
    # 等 socket 释放
    Start-Sleep -Milliseconds 500
}

Stop-StalePort -Port 1420 -Label "Vite dev server"
Stop-StalePort -Port 19827 -Label "Clip server"

if (-not (Test-Path "node_modules")) {
    Write-Host "未检测到 node_modules，先执行 npm install ..." -ForegroundColor Yellow
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "npm install 失败，已中止。" -ForegroundColor Red
        Read-Host "按回车退出"
        exit 1
    }
}

npm run tauri dev
$exitCode = $LASTEXITCODE

Write-Host ""
if ($exitCode -eq 0) {
    Write-Host "应用已正常退出。" -ForegroundColor Green
} else {
    Write-Host "应用异常退出（exit code: $exitCode）。" -ForegroundColor Red
}
Read-Host "按回车关闭窗口"
