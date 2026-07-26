#!/usr/bin/env bash
set -euo pipefail

build_root="${1:-src-tauri/gen/apple/build}"
output_path="${2:-${build_root}/ani-tracker-ios-arm64-unsigned.ipa}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "[ios-package] 未签名 IPA 只能在 macOS 上封装" >&2
  exit 1
fi

app_path=""
while IFS= read -r -d '' candidate; do
  if [[ -d "${candidate}/_CodeSignature" || -f "${candidate}/embedded.mobileprovision" ]]; then
    continue
  fi
  if codesign -d "${candidate}" >/dev/null 2>&1; then
    continue
  fi
  executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "${candidate}/Info.plist" 2>/dev/null || true)"
  if [[ -z "${executable_name}" || ! -f "${candidate}/${executable_name}" ]]; then
    continue
  fi
  architectures="$(lipo -archs "${candidate}/${executable_name}" 2>/dev/null || true)"
  if [[ " ${architectures} " == *" arm64 "* && " ${architectures} " != *" x86_64 "* ]]; then
    app_path="${candidate}"
    break
  fi
done < <(find "${build_root}" -type d -name '*.app' -print0)

if [[ -z "${app_path}" ]]; then
  echo "[ios-package] 未找到未签名 ARM64 设备 App：${build_root}" >&2
  exit 1
fi

staging_root="$(mktemp -d "${TMPDIR:-/tmp}/ani-ios-ipa.XXXXXX")"
cleanup() {
  rm -rf "${staging_root}"
}
trap cleanup EXIT

mkdir -p "${staging_root}/Payload" "$(dirname "${output_path}")"
ditto "${app_path}" "${staging_root}/Payload/$(basename "${app_path}")"
ditto -c -k --sequesterRsrc --keepParent "${staging_root}/Payload" "${output_path}"

echo "[ios-package] 未签名 ARM64 IPA 已生成：${output_path}"
