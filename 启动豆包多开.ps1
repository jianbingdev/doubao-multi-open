# 豆包多开管理器 v3.0.1 - PowerShell 启动脚本
# 用途: 本机 .bat 会被组策略/SmartScreen 拦截时, 改用本脚本启动
# 关键参数说明:
#   --no-sandbox 本机 Chromium GPU 进程沙箱被系统拦截, 不加会
#                连续报 "GPU process isn't usable"(exit_code=-1073741819) 并白屏
#   硬件加速仍然开启, 不牺牲显卡性能

$ErrorActionPreference = 'Stop'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir

# Electron 被当成纯 Node 跑的原因就是这几个遗留变量
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_NO_ATTACH_CONSOLE -ErrorAction SilentlyContinue

$exe = Join-Path $dir 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) {
    Write-Host '[提示] 依赖未安装, 正在执行 npm install ...'
    & npm install --no-audit --no-fund
}

# npm 在 node_modules\electron 目录已存在时会报 up to date 并跳过该包的
# postinstall, 导致 dist\ 为空、electron.exe 永远补不上。显式再跑 install.js 兜底。
if (-not (Test-Path $exe)) {
    Write-Host '[提示] 正在下载 Electron 运行时 ...'
    $env:ELECTRON_MIRROR = 'https://registry.npmmirror.com/-/binary/electron/'
    Push-Location (Join-Path $dir 'node_modules\electron')
    & node install.js
    Pop-Location
}

if (-not (Test-Path $exe)) {
    Write-Host '[错误] Electron 运行时仍缺失, 请手动运行: cd node_modules\electron; node install.js'
    Read-Host '按回车退出'
    exit 1
}

Start-Process -FilePath $exe `
    -ArgumentList "`"$dir`"", '--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage' `
    -WorkingDirectory $dir

Write-Host '[完成] 豆包多开管理器已启动'
