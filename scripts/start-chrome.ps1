$ErrorActionPreference = "Stop"

$projectRoot = Split-Path $PSScriptRoot -Parent
$profileDir = Join-Path $projectRoot ".linkedin-chrome-profile"
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"

if (-not (Test-Path $chrome)) {
  Write-Error "Chrome not found at $chrome"
}

New-Item -ItemType Directory -Force -Path $profileDir | Out-Null

Write-Host ""
Write-Host "Starting Chrome with remote debugging (port 9222)..." -ForegroundColor Cyan
Write-Host "Profile: $profileDir"
Write-Host ""
Write-Host "1. Log into LinkedIn in the Chrome window that opens" -ForegroundColor Yellow
Write-Host "2. In a NEW terminal, run:" -ForegroundColor Yellow
Write-Host "   npx ts-node src/index.ts --csv=./prospects.csv" -ForegroundColor Green
Write-Host ""
Write-Host "Keep this Chrome window open while the script runs." -ForegroundColor Gray
Write-Host ""

Start-Process -FilePath $chrome -ArgumentList @(
  "--remote-debugging-port=9222",
  "--user-data-dir=$profileDir",
  "https://www.linkedin.com/feed/"
)
