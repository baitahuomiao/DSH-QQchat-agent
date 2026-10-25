# 关掉 DSH、重新拉起来、再验证插件活了。**本脚本自己就是被 schtasks 拉起的独立进程**，
# 所以杀掉 DSH 不会连带杀掉它（我们的 pwsh 工具调用是 DSH 的子进程，直接在里面杀会自杀）。
#
# 为什么不用 dshmarket 的 /dsh-market/restart：
#   restartLaunch() → dshArgv()：宿主 argv[1] 是 ...dsh-desktop-host/lib/index.js，
#   不匹配 /[\\/](?:bin\.(?:js|ts)|dsh)$/ → 退化成 { file: 'dsh', viaShell: true }，
#   而 dsh 不在 PATH（Get-Command dsh 为空）。结果是杀掉进程却拉不起来。
#   那个按钮只适用于 `dsh web` 这类 CLI 启动的宿主。
#
# 为什么不直接 Start-Process 从工具调用里启动：我们会被 Stop-Process 一起带走。

$ErrorActionPreference = 'Continue'
$exe = 'E:\deepseek\DeepSeek Harness.exe'
$plugin = 'E:\deepseek\qq-dsh-plugin'
$port = 19387
$log = 'E:\deepseek\qq-dsh-plugin\tools\restart-verify.log'

function Note([string]$text) {
  $line = ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $text)
  Add-Content -Path $log -Value $line -Encoding utf8
}

function PortOpen {
  try {
    return [bool](Test-NetConnection -ComputerName 127.0.0.1 -Port $port -InformationLevel Quiet -WarningAction SilentlyContinue)
  } catch {
    return $false
  }
}

function DshProcesses {
  Get-CimInstance Win32_Process -Filter "Name='DeepSeek Harness.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $exe }
}

Set-Content -Path $log -Value ('=== 重启 DSH ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===') -Encoding utf8

if (-not (Test-Path $exe)) {
  Note "找不到 $exe —— 中止，什么都没杀。"
  exit 1
}

# 先确认现在确实有进程要关，避免「关了个寂寞」
$before = @(DshProcesses)
Note ('当前 DSH 进程: ' + (($before | ForEach-Object { $_.ProcessId }) -join ','))

# 给当前对话留时间把最后一段话说完
Note '等 20 秒（让对话收尾），然后开始重启'
Start-Sleep -Seconds 20

# —— 1. 关闭 ——
Note '关闭 DSH 进程树'
$now = @(DshProcesses)
if ($now.Count -gt 0) {
  Note ('  停止 ' + $now.Count + ' 个进程: ' + (($now | ForEach-Object { $_.ProcessId }) -join ','))
  foreach ($proc in $now) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
} else {
  Note '  没有在跑的进程'
}

$freed = $false
for ($i = 0; $i -lt 60; $i++) {
  if (-not (PortOpen)) { $freed = $true; break }
  Start-Sleep -Milliseconds 500
}
Note ('  端口 ' + $port + ' 已释放: ' + $freed)

# 主进程死后可能留孤儿，再扫一遍
$left = @(DshProcesses)
foreach ($proc in $left) {
  Note ('  清理残留 ' + $proc.ProcessId)
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 3

# —— 2. 重新拉起 ——
Note '启动 DeepSeek Harness'
try {
  Start-Process -FilePath $exe -WorkingDirectory 'E:\deepseek'
} catch {
  Note ('  启动失败: ' + $_.Exception.Message + ' —— 请手动双击 E:\deepseek\DeepSeek Harness.exe')
  exit 1
}

# —— 3. 等就绪 ——
$up = $false
for ($i = 0; $i -lt 180; $i++) {
  Start-Sleep -Milliseconds 500
  if (PortOpen) { $up = $true; break }
}
Note ('  宿主端口起来了: ' + $up)
if (-not $up) {
  Note '  宿主没起来 —— 请手动双击 E:\deepseek\DeepSeek Harness.exe'
  exit 1
}
# 端口通后再等一会儿，让插件树挂完（qq-agent 要连 NapCat WS）
Start-Sleep -Seconds 12

# —— 4. 验证 ——
Note ''
Note '=== 验证 route.vision ==='
try {
  $out = (& node "$plugin\test\vision.route.mjs" 2>&1 | Out-String).Trim()
  Note $out
  if ($LASTEXITCODE -eq 0) {
    Note '✓ 通过：宿主已跑上新代码，识图路由可用'
    Note '接下来：刷新浏览器页面 → 左栏应有 QQ 图标'
  } else {
    Note ('✗ 未通过（exit ' + $LASTEXITCODE + '）—— 把这份日志发我')
  }
} catch {
  Note ('  验证脚本出错: ' + $_.Exception.Message)
}

Note '=== 结束 ==='
