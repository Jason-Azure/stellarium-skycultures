param(
    [ValidateRange(1024, 65535)] [int] $Port = 8765,
    [switch] $NoBrowser
)
$ErrorActionPreference = 'Stop'
$gxBase = "http://127.0.0.1:$Port"
$gxReady = $false
$gxSavedState = $null
try {
    $gxHealth = Invoke-RestMethod -Uri "$gxBase/api/health" -TimeoutSec 2
    if ($gxHealth.app -eq 'guanxiang-chinese-sky') {
        if ($gxHealth.build -eq '2.0.1' -and $gxHealth.root -eq $PSScriptRoot) { $gxReady = $true }
        else {
            # Only replace this application's verified listener, preserving v2 live state.
            $gxListener = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop)
            $gxOldProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($gxHealth.pid)"
            if (-not ($gxListener.OwningProcess -contains [int]$gxHealth.pid) -or
                $gxOldProcess.Name -notmatch '^python(w)?\.exe$' -or
                $gxOldProcess.CommandLine -notmatch 'server\.py') {
                throw '现有进程与中文星空服务不匹配，未停止它。'
            }
            if ($gxHealth.version -ge 2) { $gxSavedState = Invoke-RestMethod -Uri "$gxBase/api/state" -TimeoutSec 3 }
            Stop-Process -Id $gxHealth.pid -ErrorAction Stop
            Start-Sleep -Milliseconds 600
        }
    }
} catch {}
if (-not $gxReady) {
    $gxPythonChoices = @(
        (Join-Path $PSScriptRoot '.venv\Scripts\python.exe'),
        ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\.venv\Scripts\python.exe'))),
        ([IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\.venv\Scripts\python.exe')))
    )
    $gxPython = $gxPythonChoices | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $gxPython) {
        $gxPython = (Get-Command python -ErrorAction Stop).Source
    }
    $gxServer = Join-Path $PSScriptRoot 'server.py'
    $gxArgs = @('-X', 'utf8', ('"' + $gxServer + '"'), '--port', "$Port")
    $gxProcess = Start-Process -FilePath $gxPython -ArgumentList $gxArgs -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru
    for ($gxTry = 0; $gxTry -lt 60; $gxTry++) {
        Start-Sleep -Milliseconds 250
        try {
            $gxHealth = Invoke-RestMethod -Uri "$gxBase/api/health" -TimeoutSec 1
            if ($gxHealth.app -eq 'guanxiang-chinese-sky' -and $gxHealth.build -eq '2.0.1') { $gxReady = $true; break }
        } catch {}
        if ($gxProcess.HasExited) { break }
    }
    if (-not $gxReady) {
        if (-not $gxProcess.HasExited) { Stop-Process -Id $gxProcess.Id -ErrorAction SilentlyContinue }
        throw '中文星空服务未能启动；检查端口是否已占用，或使用 -Port 8766。'
    }
}
if ($gxSavedState) {
    $gxStateJson = $gxSavedState | ConvertTo-Json -Depth 8
    Invoke-RestMethod -Uri "$gxBase/api/state" -Method Post -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($gxStateJson)) | Out-Null
}
Write-Output "控制台：$gxBase/"
Write-Output "OBS 浏览器来源：$gxBase/program"
if (-not $NoBrowser) { Start-Process $gxBase }
