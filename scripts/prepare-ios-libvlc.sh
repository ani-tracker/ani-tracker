#!/usr/bin/env bash
set -euo pipefail

# 下载并校验供 Tauri Swift 插件使用的 MobileVLCKit XCFramework。
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "iOS MobileVLCKit 只能在 macOS 上准备" >&2
  exit 1
fi
for command in curl shasum tar xcrun; do
  if ! command -v "${command}" >/dev/null 2>&1; then
    echo "缺少 iOS MobileVLCKit 准备命令：${command}" >&2
    exit 1
  fi
done

readonly version="3.7.3"
readonly archive_name="MobileVLCKit-3.7.3-319ed2c0-79128878.tar.xz"
readonly archive_sha256="0d04059906962ddc9a7bd1ebaa12e1f9ae85eb2466116a97a2f46886dd27a0a9"
readonly archive_url="https://download.videolan.org/pub/cocoapods/prod/${archive_name}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "${repo_root}/scripts/verify-ios-xcframework.sh"
cache_root="${repo_root}/.cache/ios-libvlc/${version}"
archive_path="${cache_root}/${archive_name}"
extract_root="${cache_root}/extract"
framework_root="${repo_root}/crates/tauri-plugin-ani-player/ios/Frameworks"
output_path="${framework_root}/MobileVLCKit.xcframework"

mkdir -p "${cache_root}" "${framework_root}"
if [[ ! -f "${archive_path}" ]]; then
  curl --fail --location --retry 3 --output "${archive_path}" "${archive_url}"
fi

actual_sha256="$(shasum -a 256 "${archive_path}" | awk '{print $1}')"
if [[ "${actual_sha256}" != "${archive_sha256}" ]]; then
  echo "MobileVLCKit 归档校验失败：${actual_sha256}" >&2
  exit 1
fi

rm -rf "${extract_root}"
mkdir -p "${extract_root}"
tar -xJf "${archive_path}" -C "${extract_root}"
source_path="$(find "${extract_root}" -type d -name 'MobileVLCKit.xcframework' -print -quit)"
if [[ -z "${source_path}" || ! -f "${source_path}/Info.plist" ]]; then
  echo "MobileVLCKit XCFramework 归档结构无效" >&2
  exit 1
fi

rm -rf "${output_path}"
cp -R "${source_path}" "${output_path}"
verify_ios_xcframework "${output_path}" MobileVLCKit 16.0
echo "iOS MobileVLCKit ${version} 已准备：${output_path}"
