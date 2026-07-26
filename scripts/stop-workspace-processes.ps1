param(
  [Parameter(Mandatory = $true)]
  [string]$Root
)

$ErrorActionPreference = "Stop"
$resolvedRoot = (Resolve-Path -LiteralPath $Root).Path.TrimEnd(
  [IO.Path]::DirectorySeparatorChar,
  [IO.Path]::AltDirectorySeparatorChar
)
$rootPrefix = $resolvedRoot + [IO.Path]::DirectorySeparatorChar
Write-Host "Scanning workspace processes under $resolvedRoot"

# 仅终止可执行文件位于当前工作区内的桌面进程与原生 sidecar。
Get-Process -Name "ani-tracker-tauri", "qbittorrent-nox", "torrent-core" -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -and $_.Path.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)
  } |
  ForEach-Object {
    Write-Host ("Stopping process {0}: {1}" -f $_.Id, $_.ProcessName)
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
