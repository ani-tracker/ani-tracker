#!/usr/bin/env bash
set -euo pipefail

# 生成供 Tauri Swift 插件使用的设备/模拟器 AniTorrentCore XCFramework。
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS torrent-core 只能在 macOS 上构建" >&2
  exit 1
fi
if [[ -z "${VCPKG_ROOT:-}" || ! -x "${VCPKG_ROOT}/vcpkg" ]]; then
  echo "VCPKG_ROOT 必须指向已 bootstrap 的 vcpkg" >&2
  exit 1
fi
for command in cmake xcodebuild; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "缺少 iOS torrent-core 构建命令：${command}" >&2
    exit 1
  fi
done

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_root="${repo_root}/native/torrent-core"
manifest_root="${repo_root}/native/torrent-dependencies"
cache_root="${repo_root}/.cache/ios-torrent"
dependency_root="${cache_root}/vcpkg_installed"
framework_root="${repo_root}/crates/tauri-plugin-ani-torrent/ios/Frameworks"
output_path="${framework_root}/AniTorrentCore.xcframework"

dependency_install_root() {
  local triplet="$1"
  case "${triplet}" in
    arm64-ios)
      printf '%s/device' "${dependency_root}"
      ;;
    arm64-ios-simulator)
      printf '%s/simulator' "${dependency_root}"
      ;;
    *)
      echo "不支持的 iOS vcpkg triplet：${triplet}" >&2
      return 1
      ;;
  esac
}

dependency_prefix() {
  local triplet="$1"
  printf '%s/%s' "$(dependency_install_root "${triplet}")" "${triplet}"
}

validate_dependencies() {
  local triplet="$1"
  local prefix
  prefix="$(dependency_prefix "${triplet}")"
  local missing=0
  for relative_path in \
    include/boost/version.hpp \
    include/openssl/ssl.h \
    lib/libcrypto.a \
    lib/libssl.a; do
    if [[ ! -f "${prefix}/${relative_path}" ]]; then
      echo "iOS torrent-core 依赖缺失 triplet=${triplet} path=${prefix}/${relative_path}" >&2
      missing=1
    fi
  done
  if [[ "${missing}" -ne 0 ]]; then
    return 1
  fi
  echo "iOS torrent-core 依赖已就绪 triplet=${triplet} prefix=${prefix}"
}

build_slice() {
  local name="$1"
  local sdk="$2"
  local triplet="$3"
  local build_root="${cache_root}/build/${name}"
  local prefix
  prefix="$(dependency_prefix "${triplet}")"

  cmake -S "${source_root}" -B "${build_root}" -G Xcode \
    -DCMAKE_SYSTEM_NAME=iOS \
    -DCMAKE_OSX_SYSROOT="${sdk}" \
    -DCMAKE_OSX_ARCHITECTURES=arm64 \
    -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
    -DCMAKE_PREFIX_PATH="${prefix}" \
    -DBOOST_ROOT="${prefix}" \
    -DBoost_INCLUDE_DIR="${prefix}/include" \
    -DOPENSSL_ROOT_DIR="${prefix}" \
    -DOPENSSL_USE_STATIC_LIBS=TRUE \
    -DANI_FETCH_LIBTORRENT=ON \
    -DANI_BUILD_SIDECAR=OFF \
    -DANI_BUILD_ANDROID_JNI=OFF \
    -DANI_BUILD_APPLE_FRAMEWORK=ON
  cmake --build "${build_root}" --config Release --target AniTorrentCore
}

mkdir -p "${dependency_root}" "${framework_root}"
for triplet in arm64-ios arm64-ios-simulator; do
  triplet_install_root="$(dependency_install_root "${triplet}")"
  "${VCPKG_ROOT}/vcpkg" install \
    --triplet="${triplet}" \
    --x-manifest-root="${manifest_root}" \
    --x-install-root="${triplet_install_root}"
  validate_dependencies "${triplet}"
done

build_slice device iphoneos arm64-ios
build_slice simulator iphonesimulator arm64-ios-simulator

device_framework="${cache_root}/build/device/Release-iphoneos/AniTorrentCore.framework"
simulator_framework="${cache_root}/build/simulator/Release-iphonesimulator/AniTorrentCore.framework"
if [[ ! -f "${device_framework}/AniTorrentCore" || ! -f "${simulator_framework}/AniTorrentCore" ]]; then
  echo "AniTorrentCore framework 切片不完整" >&2
  exit 1
fi

rm -rf "${output_path}"
xcodebuild -create-xcframework \
  -framework "${device_framework}" \
  -framework "${simulator_framework}" \
  -output "${output_path}"

echo "iOS torrent-core 已生成：${output_path}"
