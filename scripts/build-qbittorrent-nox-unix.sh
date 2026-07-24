#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
platform=""
arch=""
vcpkg_root="${VCPKG_ROOT:-${repo_root}/.vcpkg}"
qt_root="${QT_ROOT_DIR:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --) shift ;;
    --platform) platform="${2:-}"; shift 2 ;;
    --arch) arch="${2:-}"; shift 2 ;;
    --vcpkg-root) vcpkg_root="${2:-}"; shift 2 ;;
    --qt-root) qt_root="${2:-}"; shift 2 ;;
    *) echo "未知参数：$1" >&2; exit 1 ;;
  esac
done

if [[ "${platform}" != "darwin" && "${platform}" != "linux" ]]; then
  echo "--platform 必须为 darwin 或 linux" >&2
  exit 1
fi
if [[ "${arch}" != "x64" && "${arch}" != "arm64" ]]; then
  echo "--arch 必须为 x64 或 arm64" >&2
  exit 1
fi
if [[ ! -x "${vcpkg_root}/vcpkg" ]]; then
  echo "未找到已 bootstrap 的 vcpkg：${vcpkg_root}/vcpkg" >&2
  exit 1
fi
if [[ -z "${qt_root}" || ! -d "${qt_root}" ]]; then
  echo "QT_ROOT_DIR 或 --qt-root 必须指向 Qt 6.8.3" >&2
  exit 1
fi

qtpaths_command="${qt_root}/bin/qtpaths"
if [[ ! -x "${qtpaths_command}" ]]; then
  qtpaths_command="${qt_root}/bin/qtpaths6"
fi
if [[ ! -x "${qtpaths_command}" ]]; then
  echo "未找到 Qt 版本工具：${qt_root}/bin/qtpaths 或 qtpaths6" >&2
  exit 1
fi
qt_version="$("${qtpaths_command}" --qt-version)"
if [[ "${qt_version}" != "6.8.3" ]]; then
  echo "Qt 版本必须为 6.8.3，当前为 ${qt_version}" >&2
  exit 1
fi

target="${platform}-${arch}"
triplets_root="${repo_root}/native/qbittorrent-nox/triplets"
manifest_root="${repo_root}/native/torrent-dependencies"
dependency_include="${repo_root}/native/qbittorrent-nox/cmake/ensure-openssl-targets.cmake"
case "${target}" in
  darwin-x64) triplet="x64-osx-static"; osx_arch="x86_64" ;;
  darwin-arm64) triplet="arm64-osx-static"; osx_arch="arm64" ;;
  linux-x64) triplet="x64-linux-static"; osx_arch="" ;;
  *) echo "不支持的 qBittorrent 构建目标：${target}" >&2; exit 1 ;;
esac

cache_root="${repo_root}/.cache/qbittorrent-build"
target_root="${cache_root}/${target}"
source_root="${cache_root}/sources"
libtorrent_build="${target_root}/libtorrent-build"
libtorrent_install="${target_root}/libtorrent-install"
qbittorrent_build="${target_root}/qbittorrent-build"
bundle_input="${target_root}/bundle-input"
installed_root="${vcpkg_root}/installed/${triplet}"

echo "[qbittorrent-build] 准备固定版本源码 target=${target}"
node "${repo_root}/scripts/prepare-qbittorrent-build-sources.mjs" --cache-root "${cache_root}"

echo "[qbittorrent-build] 准备静态依赖 triplet=${triplet}"
"${vcpkg_root}/vcpkg" install \
  "--triplet=${triplet}" \
  "--x-manifest-root=${manifest_root}" \
  "--x-install-root=${vcpkg_root}/installed" \
  "--overlay-triplets=${triplets_root}"

libtorrent_options=(
  -G Ninja
  "-DCMAKE_BUILD_TYPE=Release"
  "-DCMAKE_TOOLCHAIN_FILE=${vcpkg_root}/scripts/buildsystems/vcpkg.cmake"
  "-DVCPKG_TARGET_TRIPLET=${triplet}"
  "-DVCPKG_OVERLAY_TRIPLETS=${triplets_root}"
  "-DCMAKE_INSTALL_PREFIX=${libtorrent_install}"
  "-DCMAKE_CXX_STANDARD=20"
  "-DCMAKE_POSITION_INDEPENDENT_CODE=ON"
  "-DBUILD_SHARED_LIBS=OFF"
  "-Ddeprecated-functions=OFF"
  "-Dbuild_tests=OFF"
  "-Dbuild_examples=OFF"
  "-Dbuild_tools=OFF"
  "-Dpython-bindings=OFF"
  "-DOPENSSL_USE_STATIC_LIBS=TRUE"
)
if [[ "${platform}" == "darwin" ]]; then
  libtorrent_options+=(
    "-DCMAKE_OSX_ARCHITECTURES=${osx_arch}"
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"
  )
fi

echo "[qbittorrent-build] 编译 libtorrent 2.0.13"
cmake -S "${source_root}/libtorrent" -B "${libtorrent_build}" "${libtorrent_options[@]}"
cmake --build "${libtorrent_build}" --parallel
cmake --install "${libtorrent_build}"

qbittorrent_options=(
  -G Ninja
  "-DCMAKE_BUILD_TYPE=Release"
  "-DCMAKE_TOOLCHAIN_FILE=${vcpkg_root}/scripts/buildsystems/vcpkg.cmake"
  "-DVCPKG_TARGET_TRIPLET=${triplet}"
  "-DVCPKG_OVERLAY_TRIPLETS=${triplets_root}"
  "-DCMAKE_PROJECT_INCLUDE=${dependency_include}"
  "-DCMAKE_PREFIX_PATH=${libtorrent_install};${qt_root}"
  "-DLibtorrentRasterbar_DIR=${libtorrent_install}/lib/cmake/LibtorrentRasterbar"
  "-DQt6LinguistTools_DIR=${qt_root}/lib/cmake/Qt6LinguistTools"
  "-DGUI=OFF"
  "-DWEBUI=ON"
  "-DSTACKTRACE=OFF"
  "-DTESTING=OFF"
  "-DSYSTEMD=OFF"
  "-DOPENSSL_USE_STATIC_LIBS=TRUE"
)
if [[ "${platform}" == "darwin" ]]; then
  qbittorrent_options+=(
    "-DCMAKE_OSX_ARCHITECTURES=${osx_arch}"
    "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0"
  )
fi

echo "[qbittorrent-build] 编译 qBittorrent Enhanced Edition 5.2.1.10"
cmake -S "${source_root}/qbittorrent" -B "${qbittorrent_build}" "${qbittorrent_options[@]}"
cmake --build "${qbittorrent_build}" --parallel

# 目标目录固定在仓库缓存区，允许安全重建且不会污染源码资源。
rm -rf "${bundle_input}"
mkdir -p "${bundle_input}"

if [[ "${platform}" == "darwin" ]]; then
  app_path="${qbittorrent_build}/qbittorrent-nox.app"
  if [[ ! -d "${app_path}" ]]; then
    echo "未找到 macOS qBittorrent-nox.app：${app_path}" >&2
    exit 1
  fi
  cp -R "${app_path}" "${bundle_input}/qbittorrent-nox.app"
  "${qt_root}/bin/macdeployqt" "${bundle_input}/qbittorrent-nox.app" -always-overwrite

  codesign --force --deep --sign - "${bundle_input}/qbittorrent-nox.app"
else
  binary_path="${qbittorrent_build}/qbittorrent-nox"
  if [[ ! -x "${binary_path}" ]]; then
    echo "未找到 Linux qBittorrent-nox：${binary_path}" >&2
    exit 1
  fi
  cp "${binary_path}" "${bundle_input}/qbittorrent-nox"
  chmod 755 "${bundle_input}/qbittorrent-nox"
  mkdir -p "${bundle_input}/lib"

  # 仅复制 Qt 官方目录中的共享库，glibc、libstdc++ 等继续使用系统 ABI。
  while IFS= read -r dependency; do
    if [[ "${dependency}" == "${qt_root}"/* ]]; then
      cp -L "${dependency}" "${bundle_input}/lib/$(basename "${dependency}")"
    fi
  done < <(lddtree -l "${binary_path}")

  mkdir -p "${bundle_input}/sqldrivers" "${bundle_input}/tls"
  cp "${qt_root}/plugins/sqldrivers/libqsqlite.so" "${bundle_input}/sqldrivers/libqsqlite.so"
  cp "${qt_root}/plugins/tls/libqopensslbackend.so" "${bundle_input}/tls/libqopensslbackend.so"
  if [[ -f "${qt_root}/plugins/tls/libqcertonlybackend.so" ]]; then
    cp "${qt_root}/plugins/tls/libqcertonlybackend.so" "${bundle_input}/tls/libqcertonlybackend.so"
  fi

  patchelf --set-rpath '$ORIGIN/lib' "${bundle_input}/qbittorrent-nox"
  while IFS= read -r library; do
    patchelf --set-rpath '$ORIGIN' "${library}"
  done < <(find "${bundle_input}/lib" -type f -name '*.so*')
  while IFS= read -r plugin; do
    patchelf --set-rpath '$ORIGIN/../lib' "${plugin}"
  done < <(find "${bundle_input}" -mindepth 2 -type f -name '*.so')

fi

node "${repo_root}/scripts/package-qbittorrent-bundle.mjs" \
  --platform "${platform}" \
  --arch "${arch}" \
  --input "${bundle_input}" \
  --qt-version "${qt_version}" \
  --qt-root "${qt_root}" \
  --vcpkg-installed "${installed_root}"
node "${repo_root}/scripts/verify-qbittorrent-bundle.mjs" \
  --platform "${platform}" \
  --arch "${arch}"

echo "[qbittorrent-build] 构建完成 target=${target}"
