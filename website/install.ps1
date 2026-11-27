# Valkyrie installer for Windows
#
#   irm https://tryvalkyrie.vercel.app/install.ps1 | iex
#
# Downloads the latest release from GitHub, checks its SHA-256 against the
# release's SHA256SUMS.txt, and runs the installer silently. Files downloaded
# this way don't carry the "from the internet" mark, so SmartScreen doesn't
# block the (not yet code-signed) installer.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repo = 'anmol110923/valkyrie'
$arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }

Write-Host '-> Finding the latest Valkyrie release...' -ForegroundColor Magenta
$rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ Accept = 'application/vnd.github+json' }
$version = $rel.tag_name.TrimStart('v')
$file = "Valkyrie-$version-win-$arch.exe"
$asset = $rel.assets | Where-Object { $_.name -eq $file }
$sums = $rel.assets | Where-Object { $_.name -eq 'SHA256SUMS.txt' }
if (-not $asset) { throw "The latest release has no $file." }
if (-not $sums) { throw "The latest release has no SHA256SUMS.txt." }

$tmp = Join-Path $env:TEMP $file
Write-Host "-> Downloading $file ($([math]::Round($asset.size / 1MB)) MB)..." -ForegroundColor Magenta
Invoke-WebRequest $asset.browser_download_url -OutFile $tmp -UseBasicParsing

Write-Host '-> Verifying checksum...' -ForegroundColor Magenta
$sumsFile = Join-Path $env:TEMP 'valkyrie-SHA256SUMS.txt'
Invoke-WebRequest $sums.browser_download_url -OutFile $sumsFile -UseBasicParsing
$expected = $null
foreach ($line in Get-Content $sumsFile) {
  $parts = $line.Trim() -split '\s+'
  if ($parts.Count -ge 2 -and $parts[1].TrimStart('*') -eq $file) { $expected = $parts[0].ToLower() }
}
Remove-Item $sumsFile -ErrorAction SilentlyContinue
$actual = (Get-FileHash $tmp -Algorithm SHA256).Hash.ToLower()
if (-not $expected -or $expected -ne $actual) {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  throw 'Checksum mismatch. The download may be corrupted; nothing was installed.'
}
Write-Host 'OK Checksum verified' -ForegroundColor Green

Get-Process Valkyrie -ErrorAction SilentlyContinue | Stop-Process -ErrorAction SilentlyContinue

Write-Host '-> Installing...' -ForegroundColor Magenta
Unblock-File $tmp
try {
  Start-Process -FilePath $tmp -ArgumentList '/S' -Wait
} catch {
  Remove-Item $tmp -ErrorAction SilentlyContinue
  if ($_.Exception.Message -notmatch 'Application Control|policy') { throw }
  # Smart App Control (Windows 11) or an organisation's WDAC/AppLocker policy only allows
  # code-signed apps. Valkyrie isn't code-signed yet, so explain instead of failing cryptically.
  $sac = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\CI\Policy' -Name VerifiedAndReputablePolicyState -ErrorAction SilentlyContinue).VerifiedAndReputablePolicyState
  Write-Host ''
  Write-Host 'Windows blocked the installer.' -ForegroundColor Yellow
  if ($sac -eq 1) {
    Write-Host 'Smart App Control is on. It only allows code-signed apps, and Valkyrie for Windows'
    Write-Host "isn't code-signed yet. Your download was fine (the checksum matched)."
    Write-Host ''
    Write-Host 'To install anyway, turn it off in: Windows Security > App & browser control >'
    Write-Host 'Smart App Control settings > Off. Then run this command again.'
    Write-Host 'Note: this lowers protection for the whole PC, and on some Windows versions it'
    Write-Host "can't be turned back on without resetting Windows. It's your call."
  } else {
    Write-Host 'An application control policy on this PC (often set by a work or school IT team)'
    Write-Host "only allows approved, code-signed apps. Valkyrie can't be installed here until it's code-signed."
  }
  Write-Host ''
  Write-Host 'A code-signed Windows build is planned: https://tryvalkyrie.vercel.app/#g-faq'
  return
}
Remove-Item $tmp -ErrorAction SilentlyContinue

$exe = Join-Path $env:LOCALAPPDATA 'Programs\valkyrie\Valkyrie.exe'
if (Test-Path $exe) {
  Write-Host "OK Valkyrie $version installed." -ForegroundColor Green
  Start-Process $exe
} else {
  Write-Host "OK Installer finished. Open Valkyrie from the Start menu." -ForegroundColor Green
}
