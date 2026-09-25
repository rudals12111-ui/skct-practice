param([switch]$Stop,[switch]$NoBrowser,[ValidateRange(1024,65535)][int]$Port=8787)
$ErrorActionPreference = 'Stop'
$appRoot = $PSScriptRoot
$pidFile = Join-Path $appRoot ('.server-pid-' + $Port + '.json')
$url = 'http://127.0.0.1:' + $Port + '/'
if ($Stop) {
  if (Test-Path -LiteralPath $pidFile) {
    $record = Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json
    $proc = Get-Process -Id $record.pid -ErrorAction SilentlyContinue
    if ($proc -and $proc.ProcessName -eq 'node' -and $proc.StartTime.ToUniversalTime().Ticks.ToString() -eq $record.started) {
      Stop-Process -Id $proc.Id
      Write-Host 'SKCT local server stopped.'
    }
    Remove-Item -LiteralPath $pidFile
  } else { Write-Host 'No server started by this launcher was found.' }
  exit 0
}
try {
  $existing = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 2
  if ($existing.Headers['X-App-Name'] -eq 'skct-local-practice' -or $existing.Content.Contains('<meta name="application-name" content="SKCT Local Practice">')) {
    if (-not $NoBrowser) { Start-Process $url }
    Write-Host ('SKCT is ready at ' + $url)
    exit 0
  }
  throw ('Port ' + $Port + ' is used by another application. Close it before starting SKCT.')
} catch {
  if ($_.Exception.Message -like 'Port *') { throw }
}
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else {
  # PATH may be incomplete: try the standard installer location, then the Codex runtime.
  @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $nodePath) { $nodePath = '' }
if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath)) { throw 'Node.js was not found. Install Node.js 20.16 or newer, then try START.cmd again.' }
$serverFile = Join-Path $appRoot 'server.mjs'
$proc = Start-Process -FilePath $nodePath -ArgumentList ('"' + $serverFile + '" --port=' + $Port) -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru
@{pid=$proc.Id;started=$proc.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json | Set-Content -LiteralPath $pidFile
for ($attempt=0; $attempt -lt 25; $attempt++) {
  Start-Sleep -Milliseconds 200
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1
    if ($response.Headers['X-App-Name'] -eq 'skct-local-practice') {
      if (-not $NoBrowser) { Start-Process $url }
      Write-Host 'SKCT practice opened. Use STOP.cmd when finished.'
      exit 0
    }
  } catch { }
}
throw 'Could not start SKCT. Run node server.mjs in this folder to see details.'
