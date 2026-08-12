# ─── Build a shippable zip ────────────────────────────────────────────────────
# Two variants:
#   -SelfContained  (default) includes node_modules, so the recipient needs no npm
#                   and no network. Both dependencies are pure JavaScript, verified,
#                   so this is portable across machines.
#   -Lean           source only; the recipient runs `npm install` first.
#
#   powershell -File scripts\package-zip.ps1
#   powershell -File scripts\package-zip.ps1 -Lean
#
# Excluded either way: git metadata, memory files, machine-specific settings,
# installer backups and the session PDFs. Add the PDFs with -IncludePdfs.

param(
  [switch]$Lean,
  [switch]$IncludePdfs,
  [string]$OutDir = "$env:USERPROFILE\Desktop"
)

$ErrorActionPreference = "Stop"
$root  = Split-Path -Parent $PSScriptRoot
$stamp = Get-Date -Format "yyyy-MM-dd"
$name  = if ($Lean) { "DevCDP-$stamp-source" } else { "DevCDP-$stamp" }
$stage = Join-Path $env:TEMP "devcdp-package-$([guid]::NewGuid().ToString('N').Substring(0,8))"
$zip   = Join-Path $OutDir "$name.zip"

# What ships. Everything else is excluded by omission, which is safer than trying
# to enumerate what must be kept out.
$include = @(
  "index.js", "server.js", "package.json",
  "initialize_MCP.js", "initialize_MCP.bat", "debug-chrome.bat",
  "devcdp.settings.example.json",
  "Readme.md", "GETTING-STARTED.md", "BACKLOG.md",
  "src", "extension", "scripts", "docs", "test"
)
if (-not $Lean) { $include += "node_modules" }
if ($IncludePdfs) { $include += @("DevCDP-session-slides.pdf", "DevCDP-session-handout.pdf") }

Write-Output ""
Write-Output "  staging $name"
New-Item -ItemType Directory -Path $stage -Force | Out-Null

foreach ($item in $include) {
  $src = Join-Path $root $item
  if (-not (Test-Path $src)) { Write-Output "    skip (absent): $item"; continue }
  Copy-Item $src -Destination (Join-Path $stage $item) -Recurse -Force
  Write-Output "    + $item"
}

# Belt and braces: strip anything user-specific that a copy may have pulled in.
$purge = @("*.jsonl", "*.devcdp-backup-*", "*.devcdp-tmp-*", "devcdp.config.json", "devcdp.settings.json")
foreach ($pattern in $purge) {
  Get-ChildItem $stage -Recurse -Filter $pattern -Force -EA SilentlyContinue | ForEach-Object {
    Write-Output "    - removed $($_.Name)"
    Remove-Item $_.FullName -Force -Recurse -EA SilentlyContinue
  }
}
foreach ($dir in @(".devcdp", ".git")) {
  Get-ChildItem $stage -Recurse -Directory -Filter $dir -Force -EA SilentlyContinue | ForEach-Object {
    Write-Output "    - removed $dir/"
    Remove-Item $_.FullName -Recurse -Force -EA SilentlyContinue
  }
}

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -CompressionLevel Optimal
Remove-Item $stage -Recurse -Force -EA SilentlyContinue

$size = "{0:N1} MB" -f ((Get-Item $zip).Length / 1MB)
Write-Output ""
Write-Output "  $zip  ($size)"
Write-Output ""
if ($Lean) {
  Write-Output "  Recipient: unzip, run 'npm install', then initialize_MCP.bat"
} else {
  Write-Output "  Recipient: unzip, then double-click initialize_MCP.bat. No npm, no network needed."
}
Write-Output ""
