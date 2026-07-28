#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
device_serial=""
build_mode="debug"
launch_after_install=false

# 打印脚本参数和常用调用示例。
usage() {
  cat <<'EOF'
用法：
  bash scripts/build-install-android.sh --device <设备序列号> [--debug|--release] [--launch]

参数：
  --device <序列号>  必填，使用 adb devices -l 查看
  --debug            构建 Debug APK（默认）
  --release          构建已签名 Release APK
  --launch           安装成功后启动 Ani Tracker
  -h, --help         显示帮助

示例：
  bash scripts/build-install-android.sh --device 6d7f3256 --launch
EOF
}

# 输出错误原因并终止脚本。
fail() {
  echo "[android-install] $*" >&2
  exit 1
}

# 校验构建或安装所需命令是否可执行。
require_command() {
  local command_name="$1"
  command -v "${command_name}" >/dev/null 2>&1 \
    || fail "缺少命令：${command_name}"
}

# 从本机常见位置补齐 Android SDK、NDK、JDK 和 vcpkg 环境。
configure_build_environment() {
  if [[ -z "${JAVA_HOME:-}" && "$(uname -s)" == "Darwin" && -x "/usr/libexec/java_home" ]]; then
    JAVA_HOME="$(/usr/libexec/java_home -v 17 2>/dev/null || true)"
  fi
  [[ -n "${JAVA_HOME:-}" && -x "${JAVA_HOME}/bin/java" ]] \
    || fail "未找到 JDK 17，请先设置 JAVA_HOME"

  local java_version
  java_version="$("${JAVA_HOME}/bin/java" -version 2>&1 | head -n 1)"
  [[ "${java_version}" == *'version "17.'* ]] \
    || fail "Android 构建要求 JDK 17，当前为：${java_version}"
  export JAVA_HOME

  if [[ -z "${ANDROID_HOME:-}" && -n "${ANDROID_SDK_ROOT:-}" ]]; then
    ANDROID_HOME="${ANDROID_SDK_ROOT}"
  fi
  if [[ -z "${ANDROID_HOME:-}" ]]; then
    local sdk_candidate
    for sdk_candidate in \
      "/usr/local/share/android-commandlinetools" \
      "/opt/homebrew/share/android-commandlinetools" \
      "${HOME:-}/Library/Android/sdk"; do
      if [[ -d "${sdk_candidate}/platforms" && -d "${sdk_candidate}/build-tools" ]]; then
        ANDROID_HOME="${sdk_candidate}"
        break
      fi
    done
  fi
  [[ -n "${ANDROID_HOME:-}" && -d "${ANDROID_HOME}/platforms" ]] \
    || fail "未找到 Android SDK，请先设置 ANDROID_HOME"
  ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-${ANDROID_HOME}}"
  export ANDROID_HOME ANDROID_SDK_ROOT

  if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
    local preferred_ndk="${ANDROID_HOME}/ndk/27.2.12479018"
    if [[ -d "${preferred_ndk}" ]]; then
      ANDROID_NDK_HOME="${preferred_ndk}"
    else
      local ndk_candidates=("${ANDROID_HOME}"/ndk/*)
      if [[ -d "${ndk_candidates[0]:-}" ]]; then
        ANDROID_NDK_HOME="${ndk_candidates[${#ndk_candidates[@]} - 1]}"
      fi
    fi
  fi
  [[ -n "${ANDROID_NDK_HOME:-}" && -d "${ANDROID_NDK_HOME}" ]] \
    || fail "未找到 Android NDK，请先设置 ANDROID_NDK_HOME"
  export ANDROID_NDK_HOME

  if [[ -z "${VCPKG_ROOT:-}" && -x "${repo_root}/.vcpkg/vcpkg" ]]; then
    VCPKG_ROOT="${repo_root}/.vcpkg"
  fi
  [[ -n "${VCPKG_ROOT:-}" && -x "${VCPKG_ROOT}/vcpkg" ]] \
    || fail "未找到 vcpkg，请先设置 VCPKG_ROOT"
  export VCPKG_ROOT
}

# 校验目标设备在线、已授权且支持当前 arm64 安装包。
validate_device() {
  local device_state
  device_state="$(adb -s "${device_serial}" get-state 2>/dev/null || true)"
  if [[ "${device_state}" != "device" ]]; then
    adb devices -l >&2
    fail "设备不可用或未授权：${device_serial}"
  fi

  local abi_list
  abi_list="$(adb -s "${device_serial}" shell getprop ro.product.cpu.abilist | tr -d '\r')"
  [[ ",${abi_list}," == *,arm64-v8a,* ]] \
    || fail "设备不支持 arm64-v8a：${abi_list:-未知架构}"
}

# 校验 Release 签名参数，避免构建到末尾才失败。
validate_release_signing() {
  [[ -n "${ANI_ANDROID_KEYSTORE_PATH:-}" ]] \
    || fail "Release 构建缺少环境变量：ANI_ANDROID_KEYSTORE_PATH"
  [[ -n "${ANI_ANDROID_KEYSTORE_PASSWORD:-}" ]] \
    || fail "Release 构建缺少环境变量：ANI_ANDROID_KEYSTORE_PASSWORD"
  [[ -n "${ANI_ANDROID_KEY_ALIAS:-}" ]] \
    || fail "Release 构建缺少环境变量：ANI_ANDROID_KEY_ALIAS"
  [[ -n "${ANI_ANDROID_KEY_PASSWORD:-}" ]] \
    || fail "Release 构建缺少环境变量：ANI_ANDROID_KEY_PASSWORD"
  [[ -f "${ANI_ANDROID_KEYSTORE_PATH}" ]] \
    || fail "Release keystore 不存在：${ANI_ANDROID_KEYSTORE_PATH}"
}

# 从本次构建目录中定位唯一的目标 APK。
resolve_apk_path() {
  local apk_dir="${repo_root}/src-tauri/gen/android/app/build/outputs/apk/universal/${build_mode}"
  local apk_candidates=("${apk_dir}"/*.apk)
  [[ ${#apk_candidates[@]} -eq 1 && -f "${apk_candidates[0]}" ]] \
    || fail "未找到唯一的 ${build_mode} APK：${apk_dir}"
  printf '%s\n' "${apk_candidates[0]}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --device)
      [[ $# -ge 2 && -n "$2" ]] || fail "--device 缺少设备序列号"
      device_serial="$2"
      shift 2
      ;;
    --debug)
      build_mode="debug"
      shift
      ;;
    --release)
      build_mode="release"
      shift
      ;;
    --launch)
      launch_after_install=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "未知参数：$1"
      ;;
  esac
done

[[ -n "${device_serial}" ]] || fail "必须通过 --device 指定目标设备"

require_command pnpm
require_command adb
configure_build_environment
validate_device
if [[ "${build_mode}" == "release" ]]; then
  validate_release_signing
fi

echo "[android-install] 设备：${device_serial}"
echo "[android-install] 模式：${build_mode}"
echo "[android-install] SDK：${ANDROID_HOME}"
echo "[android-install] NDK：${ANDROID_NDK_HOME}"

cd "${repo_root}"
if [[ "${build_mode}" == "release" ]]; then
  pnpm run package:tauri:android
else
  pnpm run package:tauri:android:debug
fi

apk_path="$(resolve_apk_path)"
echo "[android-install] 安装：${apk_path}"
adb -s "${device_serial}" install -r "${apk_path}"

if [[ "${launch_after_install}" == "true" ]]; then
  adb -s "${device_serial}" shell am start -n com.ani.tracker/.MainActivity >/dev/null
  echo "[android-install] Ani Tracker 已启动"
fi

echo "[android-install] 构建与安装完成"
