<#
.SYNOPSIS
  推远端前先探路：直连能过走直连，直连不行走代理；命令都带硬超时，不会空等。

.DESCRIPTION
  背景（2026-11-17）：GitHub 直连时好时坏 —— `git push` 可以是"不报错也不结束"，
  卡满 180 秒才被人手动杀掉。而"该用直连还是代理"每次靠猜，猜错就白等一轮。
  这个脚本把那条判断变成一次可测量的动作：

    1. 用 curl 分别探 https://github.com（直连 / 代理），各给 ProbeSeconds 秒；
    2. 谁通走谁（都通走直连，代理只是备胎），把两条路的耗时打出来；
    3. 推送整条命令带硬超时（PushSeconds）；超时或失败就换另一条再试一次；
    4. 两条都不通就明确报错，不猜、不在同一条路上试第三次。

  只用命令行级 `-c http.proxy=`，**不写 ~/.gitconfig** —— 全局代理会在代理关掉时
  把所有 GitHub 操作变成"连接被拒"，比卡住更难查。

.PARAMETER Remote
  远端名，默认 origin。

.PARAMETER Branch
  要推的分支，默认当前分支（detached 时退回 main）。

.PARAMETER Tag
  额外要推的 tag（可多个）。不给就只推分支。

.PARAMETER TagAtHead
  把指向 HEAD 的所有本地 tag 一起推（发版时用这个）。

.PARAMETER Proxy
  代理地址 host:port。不给就从系统设置读 ProxyServer，再没有就用 127.0.0.1:7897。

.PARAMETER PreferProxy
  两条都通时优先走代理（默认优先直连）。用于"直连能连但慢得离谱"。

.PARAMETER DryRun
  只探路并打印将要执行的推送（git push --dry-run），不改远端。

.PARAMETER ProbeSeconds
  单条路探测的超时秒数，默认 15（6 秒在墙上会被误判成"不通"：实测握手能到 10 秒以上）。

.PARAMETER PushSeconds
  整条推送命令的超时秒数，默认 120。

.EXAMPLE
  .\tools\git-push.ps1 -DryRun

.EXAMPLE
  .\tools\git-push.ps1 -TagAtHead
#>
[CmdletBinding()]
param(
  [string]$Remote = 'origin',
  [string]$Branch = '',
  [string[]]$Tag = @(),
  [switch]$TagAtHead,
  [string]$Proxy = '',
  [switch]$PreferProxy,
  [switch]$DryRun,
  [int]$ProbeSeconds = 15,
  [int]$PushSeconds = 120,
  [string]$RepoPath = ''
)

$ErrorActionPreference = 'Stop'
$env:GIT_TERMINAL_PROMPT = '0'

function Get-DefaultProxy {
  try {
    $s = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop).ProxyServer
    if ($s) {
      $first = ($s -split ';')[0]
      if ($first -match '=') { $first = ($first -split '=')[1] }
      if ($first -match '^\S+:\d+$') { return $first }
    }
  } catch { }
  return '127.0.0.1:7897'
}

function Test-Route {
  param([string]$Url, [string]$ProxyAddr, [int]$Seconds)
  if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { return $null }
  $argv = @('-sS', '-o', 'NUL', '--max-time', "$Seconds")
  if ($ProxyAddr) { $argv += @('--proxy', "http://$ProxyAddr") }
  $argv += $Url
  $sw = [Diagnostics.Stopwatch]::StartNew()
  # PS 5.1 里原生程序写 stderr（curl 超时就会写）在 EAP=Stop 下会把脚本干掉；
  # 这里临时降到 Continue，并且把 stderr 也吃掉 —— 我们只关心退出码。
  $oldEap = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & curl.exe @argv 2>&1 | Out-Null
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldEap
  }
  $code = $LASTEXITCODE
  $sw.Stop()
  return [pscustomobject]@{ ok = ($code -eq 0); ms = [int]$sw.ElapsedMilliseconds; code = $code }
}

function Invoke-Git {
  <#
    跑一条 git 命令，带硬超时。用 .NET Process 而不是 Start-Process：
    PS 5.1 的 Start-Process -PassThru 在带重定向时拿不到 ExitCode（会读成 null），
    于是"推送成功"也会被判成失败。ReadToEndAsync 同时避免缓冲区写满导致的死锁。
  #>
  param([string[]]$GitArgs, [string]$ProxyAddr, [int]$Seconds, [string]$WorkDir)
  $all = @()
  if ($ProxyAddr) {
    $all += @('-c', "http.proxy=http://$ProxyAddr", '-c', "https.proxy=http://$ProxyAddr")
  } else {
    $all += @('-c', 'http.proxy=', '-c', 'https.proxy=')
  }
  $all += $GitArgs
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'git'
  $psi.Arguments = (($all | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' ')
  $psi.WorkingDirectory = $WorkDir
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = [System.Diagnostics.Process]::Start($psi)
  $outTask = $proc.StandardOutput.ReadToEndAsync()
  $errTask = $proc.StandardError.ReadToEndAsync()
  $finished = $proc.WaitForExit($Seconds * 1000)
  $sw.Stop()
  if (-not $finished) {
    try { $proc.Kill() } catch { }
    return [pscustomobject]@{
      ok = $false; timeout = $true; code = $null; out = ''; err = "超时 $Seconds 秒，已杀掉"
      seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    }
  }
  $proc.WaitForExit()
  $out = ''
  $err = ''
  try { $out = $outTask.Result } catch { }
  try { $err = $errTask.Result } catch { }
  $code = $proc.ExitCode
  return [pscustomobject]@{
    ok = ($code -eq 0); timeout = $false; code = $code
    out = $out; err = $err; seconds = [math]::Round($sw.Elapsed.TotalSeconds, 1)
  }
}
# ---- 0. 定位仓库 ---------------------------------------------------------

# 脚本就在仓库的 tools\ 下；从别处调也认这个仓库，不认调用者的当前目录
if (-not $RepoPath) { $RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path }
$RepoRoot = (& git -C $RepoPath rev-parse --show-toplevel 2>&1 | Out-String).Trim()
if (-not $RepoRoot -or $RepoRoot -match 'fatal:') {
  Write-Host "找不到 git 仓库：$RepoPath" -ForegroundColor Red
  exit 2
}
Set-Location $RepoRoot
Write-Host ("仓库　{0}" -f $RepoRoot)

# ---- 1. 目标：分支 + tag ------------------------------------------------

if (-not $Branch) {
  $Branch = (& git rev-parse --abbrev-ref HEAD 2>&1 | Out-String).Trim()
  if (-not $Branch -or $Branch -eq 'HEAD') { $Branch = 'main' }
}
$tags = @($Tag | Where-Object { $_ })
if ($TagAtHead) {
  $atHead = @(& git tag --points-at HEAD 2>&1) | Where-Object { $_ -and $_ -notmatch '^fatal:' }
  $tags = @(($tags + $atHead) | Select-Object -Unique)
}
$versions = @($Branch) + $tags
$gitArgs = @('push')
if ($DryRun) { $gitArgs += '--dry-run' }
$gitArgs += $Remote
$gitArgs += $versions

# ---- 2. 探路 ------------------------------------------------------------

if (-not $Proxy) { $Proxy = Get-DefaultProxy }
$direct = Test-Route -Url 'https://github.com' -ProxyAddr '' -Seconds $ProbeSeconds
$viaProxy = Test-Route -Url 'https://github.com' -ProxyAddr $Proxy -Seconds $ProbeSeconds

function Format-Route($r) {
  if (-not $r) { return '未探（没有 curl）' }
  if ($r.ok) { return "✓ $($r.ms)ms" }
  return "✗ $($r.ms)ms"
}
Write-Host ("探路　直连 {0}　｜　代理 {1} {2}" -f (Format-Route $direct), $Proxy, (Format-Route $viaProxy))

$routes = @()
if ($direct -and $direct.ok) { $routes += [pscustomobject]@{ name = '直连'; proxy = ''; ms = $direct.ms } }
if ($viaProxy -and $viaProxy.ok) { $routes += [pscustomobject]@{ name = "代理 $Proxy"; proxy = $Proxy; ms = $viaProxy.ms } }
# 两条都通时按**探测耗时**排：握手就慢 4 秒的路，推起来通常也慢
$routes = @($routes | Sort-Object -Property ms)
if (-not $direct -and -not $viaProxy) {
  # 没有 curl：不猜，两条都试一次（各自带超时）
  $routes = @(
    [pscustomobject]@{ name = '直连（未探）'; proxy = '' },
    [pscustomobject]@{ name = "代理 $Proxy（未探）"; proxy = $Proxy }
  )
}
if ($routes.Count -eq 0) {
  Write-Host '两条路都不通（直连超时、代理也超时）。先确认 Clash 开着，或者换网络。' -ForegroundColor Red
  exit 2
}
if ($PreferProxy) {
  $routes = @($routes | Sort-Object -Property @{ Expression = { if ($_.proxy) { 0 } else { 1 } } })
}

Write-Host ("推送　git {0}" -f ($gitArgs -join ' '))

# ---- 3. 推送：第一条失败/超时就换另一条 ---------------------------------

$tried = @()
$done = $null
$doneRoute = $null
foreach ($route in $routes) {
  Write-Host ("走　　{0}" -f $route.name)
  $r = Invoke-Git -GitArgs $gitArgs -ProxyAddr $route.proxy -Seconds $PushSeconds -WorkDir $RepoRoot
  $tried += [pscustomobject]@{
    route = $route.name; seconds = $r.seconds; ok = $r.ok; timeout = $r.timeout
    code = $r.code; err = $r.err
  }
  if ($r.ok) { $done = $r; $doneRoute = $route; break }
  Write-Host ("　　　失败（{0}s，超时={1}，exit={2}）" -f $r.seconds, $r.timeout, $r.code) -ForegroundColor Yellow
}

Write-Host ''
foreach ($t in $tried) {
  $state = '失败'
  if ($t.ok) { $state = '成功' }
  Write-Host ("{0,-24} {1,6}s  {2}" -f $t.route, $t.seconds, $state)
}

if (-not $done) {
  $last = $tried[$tried.Count - 1]
  if ($last -and $last.err) {
    Write-Host ''
    Write-Host '最后一条的错误：' -ForegroundColor DarkGray
    Write-Host $last.err.Trim() -ForegroundColor DarkGray
  }
  Write-Host '两条路都没推上去。' -ForegroundColor Red
  exit 1
}

Write-Host ''
Write-Host ("完成：{0} → {1} {2}" -f $doneRoute.name, $Remote, ($versions -join ' ')) -ForegroundColor Green
if ($done.out) { Write-Host $done.out.Trim() }
if ($done.err) { Write-Host $done.err.Trim() -ForegroundColor DarkGray }
exit 0
