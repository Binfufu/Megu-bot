# JM 边车服务启动脚本（Windows）：自动设好 PYTHONPATH 后前台运行
# 用法：.\run.ps1
# 前置：本目录下 .venv 已装 requirements.txt；vendor\ 下已克隆两个上游仓库。
$ErrorActionPreference = "Stop"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Here

$Python = Join-Path $Here ".venv\Scripts\python.exe"
if (-not (Test-Path $Python)) {
    throw "找不到 .venv\Scripts\python.exe。请先：python -m venv .venv; .venv\Scripts\pip install -r requirements.txt"
}
$Upstreams = @(
    (Join-Path $Here "vendor\JMComic-Crawler-Python\src"),
    (Join-Path $Here "vendor\jm-view-server\src")
)
foreach ($p in $Upstreams) {
    if (-not (Test-Path $p)) {
        throw "缺少上游依赖目录：$p（请按 README 在 vendor\ 下克隆两个上游仓库）"
    }
}
$env:PYTHONPATH = (@($Here) + $Upstreams) -join ";"
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUNBUFFERED = "1"
Write-Host "启动 jm-service（Ctrl+C 停止）..."
& $Python -m jm_service
exit $LASTEXITCODE
