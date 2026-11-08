param(
    [ValidateRange(1024, 65535)] [int] $Port = 8765,
    [switch] $NoBrowser
)
$ErrorActionPreference = 'Stop'
$gxBase = "http://127.0.0.1:$Port"
$gxReady = $false
try {
    $gxHealth = Invoke-RestMethod -Uri "$gxBase/api/health" -TimeoutSec 2
    if ($gxHealth.app -eq 'guanxiang-chinese-sky') {
        if ($gxHealth.version -ge 2) { $gxReady = $true }
        else {
            # v0.1 still running in the background holds the port; replace it.
            Stop-Process -Id $gxHealth.pid -ErrorAction SilentlyContinue
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
    $gxProcess = Start-Process -FilePath $gxPython -ArgumentList $gxArgs -WindowStyle Hidden -PassThru
    for ($gxTry = 0; $gxTry -lt 60; $gxTry++) {
        Start-Sleep -Milliseconds 250
        try {
            $gxHealth = Invoke-RestMethod -Uri "$gxBase/api/health" -TimeoutSec 1
            if ($gxHealth.app -eq 'guanxiang-chinese-sky' -and $gxHealth.version -ge 2) { $gxReady = $true; break }
        } catch {}
        if ($gxProcess.HasExited) { break }
    }
    if (-not $gxReady) {
        if (-not $gxProcess.HasExited) { Stop-Process -Id $gxProcess.Id -ErrorAction SilentlyContinue }
        throw '中文星空服务未能启动；检查端口是否已占用，或使用 -Port 8766。'
    }
}
Write-Output "控制台：$gxBase/"
Write-Output "OBS 浏览器来源：$gxBase/program"
if (-not $NoBrowser) { Start-Process $gxBase }
