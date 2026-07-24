#!/usr/bin/env bash
set -euo pipefail

# 使用 vcpkg 交叉编译 Android 版 Boost.System 与 OpenSSL，libtorrent 仍由 CMake 锁定到 2.1.0。
if [[ -z "${VCPKG_ROOT:-}" || ! -x "${VCPKG_ROOT}/vcpkg" ]]; then
  echo "VCPKG_ROOT 必须指向已 bootstrap 的 vcpkg" >&2
  exit 1
fi
if [[ -z "${ANDROID_NDK_HOME:-}" || ! -d "${ANDROID_NDK_HOME}" ]]; then
  echo "ANDROID_NDK_HOME 必须指向 Android NDK 目录" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
install_root="${repo_root}/.cache/android-torrent/vcpkg_installed"

mkdir -p "${install_root}"
"${VCPKG_ROOT}/vcpkg" install \
  boost-system:arm64-android \
  openssl:arm64-android \
  --x-install-root="${install_root}"

echo "Android 原生依赖已准备：${install_root}/arm64-android"
