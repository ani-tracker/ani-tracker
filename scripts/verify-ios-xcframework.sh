#!/usr/bin/env bash

# 校验 XCFramework 的设备/模拟器切片，并验证 Swift 可以导入目标模块。
verify_ios_xcframework() {
  local xcframework_path="$1"
  local module_name="$2"
  local deployment_target="$3"

  if [[ ! -f "${xcframework_path}/Info.plist" ]]; then
    echo "XCFramework 清单缺失 module=${module_name} path=${xcframework_path}" >&2
    return 1
  fi

  local device_framework
  local simulator_framework
  device_framework="$(find "${xcframework_path}" -type d -name "${module_name}.framework" ! -path '*simulator*' -print -quit)"
  simulator_framework="$(find "${xcframework_path}" -type d -name "${module_name}.framework" -path '*simulator*' -print -quit)"
  if [[ -z "${device_framework}" || -z "${simulator_framework}" ]]; then
    echo "XCFramework 缺少设备或模拟器切片 module=${module_name}" >&2
    return 1
  fi

  verify_ios_framework_slice "${device_framework}" "${module_name}" iphoneos \
    "arm64-apple-ios${deployment_target}"
  verify_ios_framework_slice "${simulator_framework}" "${module_name}" iphonesimulator \
    "arm64-apple-ios${deployment_target}-simulator"
  echo "iOS XCFramework 模块校验通过 module=${module_name}"
}

# 校验单个 framework 的二进制、module map 和 Swift 导入能力。
verify_ios_framework_slice() {
  local framework_path="$1"
  local module_name="$2"
  local sdk="$3"
  local target="$4"
  local module_map="${framework_path}/Modules/module.modulemap"
  if [[ ! -f "${framework_path}/${module_name}" || ! -f "${module_map}" ]]; then
    echo "iOS framework 切片不完整 module=${module_name} sdk=${sdk} path=${framework_path}" >&2
    return 1
  fi

  local sdk_path
  local probe_source
  sdk_path="$(xcrun --sdk "${sdk}" --show-sdk-path)"
  probe_source="$(mktemp "${TMPDIR:-/tmp}/ani-${module_name}-XXXXXX.swift")"
  printf 'import %s\n' "${module_name}" >"${probe_source}"
  if ! xcrun --sdk "${sdk}" swiftc \
    -target "${target}" \
    -sdk "${sdk_path}" \
    -F "$(dirname "${framework_path}")" \
    -typecheck "${probe_source}"; then
    rm -f "${probe_source}"
    echo "Swift 无法导入 iOS framework module=${module_name} sdk=${sdk}" >&2
    return 1
  fi
  rm -f "${probe_source}"
}
