# Stargazer local server
#
# Why this exists: browsers block getUserMedia and wasm loading on file://,
# so the app must be opened over http://127.0.0.1. This script uses only the
# .NET Framework bundled with Windows - no Node, no Python, no install.
#
# Usage: double-click "start.bat", or
#   powershell -NoProfile -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080] [-NoBrowser]
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 decodes scripts
# without a BOM as ANSI, and non-ASCII bytes here break the parser.

param(
  [int]$Port = 0,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'

$root = Join-Path $PSScriptRoot 'dist'
if (-not (Test-Path $root)) {
  Write-Host ''
  Write-Host 'ERROR: dist folder not found.' -ForegroundColor Red
  Write-Host 'Run this first in the project folder:  npm run build' -ForegroundColor Yellow
  Write-Host ''
  Read-Host 'Press Enter to exit'
  exit 1
}
$root = (Resolve-Path $root).Path

# ---- pick a free port
if ($Port -eq 0) {
  foreach ($candidate in 8080..8099) {
    try {
      $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $candidate)
      $probe.Start()
      $probe.Stop()
      $Port = $candidate
      break
    } catch {
      # port busy, try the next one
    }
  }
}
if ($Port -eq 0) {
  Write-Host 'ERROR: ports 8080-8099 are all in use. Pass -Port explicitly.' -ForegroundColor Red
  Read-Host 'Press Enter to exit'
  exit 1
}

$mime = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'text/javascript; charset=utf-8'
  '.mjs'  = 'text/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.wasm' = 'application/wasm'
  '.task' = 'application/octet-stream'
  '.bin'  = 'application/octet-stream'
  '.png'  = 'image/png'
  '.jpg'  = 'image/jpeg'
  '.svg'  = 'image/svg+xml'
  '.ico'  = 'image/x-icon'
  '.map'  = 'application/json'
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
$listener.Start()
$url = "http://127.0.0.1:$Port/"

Write-Host ''
Write-Host '  Stargazer is running' -ForegroundColor Green
Write-Host "  $url" -ForegroundColor Cyan
Write-Host ''
Write-Host '  Open it with Chrome or Edge (needs camera access).'
Write-Host '  Close this window to stop the server.'
Write-Host ''

if (-not $NoBrowser) {
  Start-Process $url
}

function Send-Response {
  param($Stream, [int]$Status, [string]$ContentType, [byte[]]$Body)
  $reason = 'OK'
  if ($Status -eq 404) { $reason = 'Not Found' }
  if ($Status -eq 403) { $reason = 'Forbidden' }
  $head = "HTTP/1.1 $Status $reason`r`nContent-Type: $ContentType`r`nContent-Length: $($Body.Length)`r`nCache-Control: no-store`r`nConnection: close`r`n`r`n"
  $hb = [System.Text.Encoding]::ASCII.GetBytes($head)
  $Stream.Write($hb, 0, $hb.Length)
  if ($Body.Length -gt 0) { $Stream.Write($Body, 0, $Body.Length) }
  $Stream.Flush()
}

while ($true) {
  $client = $null
  try {
    $client = $listener.AcceptTcpClient()
    $stream = $client.GetStream()
    $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 4096, $true)

    $requestLine = $reader.ReadLine()
    if ([string]::IsNullOrWhiteSpace($requestLine)) {
      continue
    }
    while ($true) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
      if ($line -eq '') { break }
    }

    $parts = $requestLine.Split(' ')
    $path = '/'
    if ($parts.Length -ge 2) { $path = $parts[1] }
    $path = $path.Split('?')[0]
    if ($path -eq '/') { $path = '/index.html' }
    $path = [System.Uri]::UnescapeDataString($path)

    $relative = $path.TrimStart('/').Replace('/', [System.IO.Path]::DirectorySeparatorChar)
    $full = [System.IO.Path]::GetFullPath((Join-Path $root $relative))

    if (-not $full.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) {
      $msg = [System.Text.Encoding]::UTF8.GetBytes('forbidden')
      Send-Response -Stream $stream -Status 403 -ContentType 'text/plain; charset=utf-8' -Body $msg
    } elseif (Test-Path $full -PathType Leaf) {
      $bytes = [System.IO.File]::ReadAllBytes($full)
      $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
      $ct = $mime[$ext]
      if (-not $ct) { $ct = 'application/octet-stream' }
      Send-Response -Stream $stream -Status 200 -ContentType $ct -Body $bytes
    } else {
      $msg = [System.Text.Encoding]::UTF8.GetBytes("not found: $path")
      Send-Response -Stream $stream -Status 404 -ContentType 'text/plain; charset=utf-8' -Body $msg
    }
  } catch {
    # one bad request must not kill the server
  } finally {
    if ($client) { $client.Close() }
  }
}
