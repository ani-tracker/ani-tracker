param(
    [string]$Arch = "x64",
    [string]$VcpkgRoot = $env:VCPKG_ROOT,
    [string]$QtRoot = $env:QT_ROOT_DIR
)

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $true
$repoRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($VcpkgRoot)) {
    $VcpkgRoot = Join-Path $repoRoot ".vcpkg"
}
if ([string]::IsNullOrWhiteSpace($QtRoot)) {
    throw "QT_ROOT_DIR 或 -QtRoot 必须指向 Qt 6.8.3"
}
if (-not (Test-Path $QtRoot -PathType Container)) {
    throw "未找到 Qt 根目录：$QtRoot"
}
if ($Arch -ne "x64") {
    throw "Windows qBittorrent-nox 当前仅支持 x64"
}

$vcpkgExecutable = Join-Path $VcpkgRoot "vcpkg.exe"
if (-not (Test-Path $vcpkgExecutable)) {
    throw "未找到已 bootstrap 的 vcpkg：$vcpkgExecutable"
}

$target = "win32-x64"
$triplet = "x64-windows-static-md"
$cacheRoot = Join-Path $repoRoot ".cache/qbittorrent-build"
$targetRoot = Join-Path $cacheRoot $target
$sourceRoot = Join-Path $cacheRoot "sources"
$libtorrentBuild = Join-Path $targetRoot "libtorrent-build"
$libtorrentInstall = Join-Path $targetRoot "libtorrent-install"
$qbittorrentBuild = Join-Path $targetRoot "qbittorrent-build"
$bundleInput = Join-Path $targetRoot "bundle-input"
$installedRoot = Join-Path $VcpkgRoot "installed/$triplet"
$toolchain = Join-Path $VcpkgRoot "scripts/buildsystems/vcpkg.cmake"
$manifestRoot = Join-Path $repoRoot "native/torrent-dependencies"
$dependencyInclude = Join-Path $repoRoot "native/qbittorrent-nox/cmake/ensure-openssl-targets.cmake"
$qtPaths = Join-Path $QtRoot "bin/qtpaths.exe"
if (-not (Test-Path $qtPaths)) {
    $qtPaths = Join-Path $QtRoot "bin/qtpaths6.exe"
}
if (-not (Test-Path $qtPaths)) {
    throw "未找到 Qt 版本工具：$QtRoot/bin/qtpaths.exe 或 qtpaths6.exe"
}
$qtVersion = (& $qtPaths --qt-version).Trim()
if ($qtVersion -ne "6.8.3") {
    throw "Qt 版本必须为 6.8.3，当前为 $qtVersion"
}

Write-Host "[qbittorrent-build] 准备固定版本源码 target=$target"
node (Join-Path $repoRoot "scripts/prepare-qbittorrent-build-sources.mjs") --cache-root $cacheRoot

Write-Host "[qbittorrent-build] 准备静态依赖 triplet=$triplet"
& $vcpkgExecutable install `
    "--triplet=$triplet" `
    "--x-manifest-root=$manifestRoot" `
    "--x-install-root=$(Join-Path $VcpkgRoot 'installed')"

Write-Host "[qbittorrent-build] 编译 libtorrent 2.0.13"
cmake -S (Join-Path $sourceRoot "libtorrent") -B $libtorrentBuild -G Ninja `
    "-DCMAKE_BUILD_TYPE=Release" `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    "-DVCPKG_TARGET_TRIPLET=$triplet" `
    "-DCMAKE_INSTALL_PREFIX=$libtorrentInstall" `
    "-DCMAKE_CXX_STANDARD=20" `
    "-DCMAKE_MSVC_RUNTIME_LIBRARY=MultiThreadedDLL" `
    "-DBUILD_SHARED_LIBS=OFF" `
    "-Ddeprecated-functions=OFF" `
    "-Dstatic_runtime=OFF" `
    "-Dbuild_tests=OFF" `
    "-Dbuild_examples=OFF" `
    "-Dbuild_tools=OFF" `
    "-Dpython-bindings=OFF" `
    "-DOPENSSL_USE_STATIC_LIBS=TRUE"
cmake --build $libtorrentBuild --parallel
cmake --install $libtorrentBuild

$libtorrentConfig = Join-Path $libtorrentInstall "lib/cmake/LibtorrentRasterbar"
$qtLinguistTools = Join-Path $QtRoot "lib/cmake/Qt6LinguistTools"
Write-Host "[qbittorrent-build] 编译 qBittorrent Enhanced Edition 5.2.1.10"
cmake -S (Join-Path $sourceRoot "qbittorrent") -B $qbittorrentBuild -G Ninja `
    "-DCMAKE_BUILD_TYPE=Release" `
    "-DCMAKE_TOOLCHAIN_FILE=$toolchain" `
    "-DVCPKG_TARGET_TRIPLET=$triplet" `
    "-DCMAKE_PROJECT_INCLUDE=$dependencyInclude" `
    "-DCMAKE_PREFIX_PATH=$libtorrentInstall;$QtRoot" `
    "-DLibtorrentRasterbar_DIR=$libtorrentConfig" `
    "-DQt6LinguistTools_DIR=$qtLinguistTools" `
    "-DGUI=OFF" `
    "-DWEBUI=ON" `
    "-DSTACKTRACE=OFF" `
    "-DTESTING=OFF" `
    "-DMSVC_RUNTIME_DYNAMIC=ON" `
    "-DOPENSSL_USE_STATIC_LIBS=TRUE"
cmake --build $qbittorrentBuild --parallel

# 目标始终位于仓库缓存目录，清理不会影响源码或用户资源。
if (Test-Path $bundleInput) {
    Remove-Item -Recurse -Force $bundleInput
}
New-Item -ItemType Directory -Force -Path $bundleInput | Out-Null

$binaryPath = Join-Path $qbittorrentBuild "qbittorrent-nox.exe"
if (-not (Test-Path $binaryPath)) {
    throw "未找到 Windows qBittorrent-nox.exe：$binaryPath"
}
$stagedBinary = Join-Path $bundleInput "qbittorrent-nox.exe"
Copy-Item $binaryPath $stagedBinary

$winDeployQt = Join-Path $QtRoot "bin/windeployqt.exe"
if (-not (Test-Path $winDeployQt)) {
    throw "未找到 windeployqt：$winDeployQt"
}
& $winDeployQt --release --compiler-runtime --no-translations $stagedBinary

# 无头版只保留 SQLite 与 Windows 原生 TLS 插件，避免引入 GUI 或动态 OpenSSL 运行库。
$sqlDriversDirectory = Join-Path $bundleInput "sqldrivers"
$sqlitePlugin = Join-Path $sqlDriversDirectory "qsqlite.dll"
$qtSqlitePlugin = Join-Path $QtRoot "plugins/sqldrivers/qsqlite.dll"
if (-not (Test-Path $qtSqlitePlugin)) {
    throw "Qt 安装中缺少 SQLite 插件：$qtSqlitePlugin"
}
New-Item -ItemType Directory -Force -Path $sqlDriversDirectory | Out-Null
Copy-Item -Force $qtSqlitePlugin $sqlitePlugin
Get-ChildItem -Path $sqlDriversDirectory -Filter "*.dll" |
    Where-Object { $_.Name -ne "qsqlite.dll" } |
    Remove-Item -Force

$tlsDirectory = Join-Path $bundleInput "tls"
$qtTlsDirectory = Join-Path $QtRoot "plugins/tls"
$schannelPlugin = Join-Path $qtTlsDirectory "qschannelbackend.dll"
if (-not (Test-Path $schannelPlugin)) {
    throw "Qt 安装中缺少 Schannel TLS 插件：$schannelPlugin"
}
New-Item -ItemType Directory -Force -Path $tlsDirectory | Out-Null
Copy-Item -Force $schannelPlugin (Join-Path $tlsDirectory "qschannelbackend.dll")
$certOnlyPlugin = Join-Path $qtTlsDirectory "qcertonlybackend.dll"
if (Test-Path $certOnlyPlugin) {
    Copy-Item -Force $certOnlyPlugin (Join-Path $tlsDirectory "qcertonlybackend.dll")
}
Get-ChildItem -Path $tlsDirectory -Filter "*.dll" |
    Where-Object { $_.Name -notin @("qcertonlybackend.dll", "qschannelbackend.dll") } |
    Remove-Item -Force

node (Join-Path $repoRoot "scripts/package-qbittorrent-bundle.mjs") `
    --platform win32 `
    --arch x64 `
    --input $bundleInput `
    --qt-version $qtVersion `
    --qt-root $QtRoot `
    --vcpkg-installed $installedRoot
node (Join-Path $repoRoot "scripts/verify-qbittorrent-bundle.mjs") `
    --platform win32 `
    --arch x64

Write-Host "[qbittorrent-build] 构建完成 target=$target"
