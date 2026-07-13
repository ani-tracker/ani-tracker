param(
  [ValidateSet("preview", "dev", "none")]
  [string]$Run = "preview",
  [switch]$SkipStorePrune,
  [switch]$KillApp
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $ScriptDir "..")).Path
$RootPrefix = $Root + [IO.Path]::DirectorySeparatorChar
Set-Location $Root

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message"
}

function Assert-WorkspacePath {
  param([string]$Path)
  if (-not $Path.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove path outside workspace: $Path"
  }
}

function Remove-WorkspaceItem {
  param([string]$RelativePath)

  $Path = Join-Path $Root $RelativePath
  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }

  $Resolved = Resolve-Path -LiteralPath $Path
  foreach ($Item in $Resolved) {
    Assert-WorkspacePath $Item.Path
    Write-Host "Removing $($Item.Path)"
    Get-ChildItem -LiteralPath $Item.Path -Recurse -Force -ErrorAction SilentlyContinue | ForEach-Object {
      try {
        $_.Attributes = "Normal"
      } catch {
        # Best-effort attribute reset for locked or special files.
      }
    }
    Remove-Item -LiteralPath $Item.Path -Recurse -Force
  }
}

function Invoke-Step {
  param(
    [string]$Message,
    [scriptblock]$Command
  )

  Write-Step $Message
  & $Command
}

if ($KillApp) {
  Write-Step "Stopping Electron processes under this workspace"
  Get-Process electron -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path.StartsWith($RootPrefix, [StringComparison]::OrdinalIgnoreCase) } |
    ForEach-Object {
      Write-Host "Stopping electron process $($_.Id)"
      Stop-Process -Id $_.Id -Force
    }
}

Write-Step "Cleaning generated directories"
@("node_modules", "out", "dist", "release", ".build") | ForEach-Object {
  Remove-WorkspaceItem $_
}

Write-Step "Cleaning generated TypeScript/Vite files"
@("electron.vite.config.js", "electron.vite.config.d.ts") | ForEach-Object {
  $Path = Join-Path $Root $_
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
  }
}

Get-ChildItem -LiteralPath $Root -File -Filter "*.tsbuildinfo" -Force -ErrorAction SilentlyContinue |
  ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force }

$KeepDts = Join-Path $Root "src\renderer\src\vite-env.d.ts"
if (Test-Path -LiteralPath (Join-Path $Root "src")) {
  Get-ChildItem -LiteralPath (Join-Path $Root "src") -Recurse -File -Force -Include "*.js", "*.d.ts", "*.tsbuildinfo" |
    Where-Object { $_.FullName -ne $KeepDts } |
    ForEach-Object {
      Assert-WorkspacePath $_.FullName
      Remove-Item -LiteralPath $_.FullName -Force
    }
}

if (-not $SkipStorePrune) {
  Invoke-Step "Pruning pnpm store" { pnpm.cmd store prune }
}

Invoke-Step "Installing dependencies" { pnpm.cmd install }
Invoke-Step "Running typecheck" { pnpm.cmd run typecheck }
Invoke-Step "Building production output" { pnpm.cmd build }

if ($Run -eq "preview") {
  Invoke-Step "Starting Electron preview" { pnpm.cmd preview }
} elseif ($Run -eq "dev") {
  Invoke-Step "Starting Electron dev server" { pnpm.cmd dev }
} else {
  Write-Step "Done"
}
