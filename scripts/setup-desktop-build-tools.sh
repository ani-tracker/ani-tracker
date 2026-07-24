#!/usr/bin/env bash
set -euo pipefail

CHECK_ONLY=0
PLATFORM=""
ARCH=""

# 输出工具链安装脚本的参数说明。
usage() {
  cat <<'EOF'
Usage: bash scripts/setup-desktop-build-tools.sh [options]

Options:
  --check-only   Only verify prerequisites; do not install anything
  -h, --help     Show this help

Windows must run this script from Git Bash. System UAC or Xcode prompts may
still require confirmation.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check-only)
      CHECK_ONLY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

# 输出带分隔符的安装步骤日志。
step() {
  printf '\n==> %s\n' "$1"
}

# 检查脚本自身依赖并识别当前桌面平台。
detect_platform() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node is required but was not found in PATH" >&2
    exit 1
  fi
  PLATFORM="$(node -p "process.platform")"
  ARCH="$(node -p "process.arch")"
  if [[ "$PLATFORM" != "darwin" && "$PLATFORM" != "win32" ]]; then
    echo "Unsupported platform: $PLATFORM" >&2
    exit 1
  fi
}

# 调用项目原生构建器执行最终工具链验证。
verify_toolchain() {
  node scripts/prepare-desktop-torrent-core-dev.mjs \
    --arch "$ARCH" \
    --check-only
}

# 判断项目原生构建器是否已具备全部先决条件。
toolchain_is_ready() {
  verify_toolchain >/dev/null 2>&1
}

# 使用 winget 安装 VS 2022 C++、CMake 和 Ninja 工具链。
install_windows_toolchain() {
  if ! command -v winget.exe >/dev/null 2>&1; then
    echo "winget.exe is required. Install Microsoft App Installer, then rerun this script." >&2
    exit 1
  fi

  step "Installing Visual Studio 2022 Build Tools"
  winget.exe install \
    --id Microsoft.VisualStudio.2022.BuildTools \
    --exact \
    --source winget \
    --force \
    --accept-package-agreements \
    --accept-source-agreements \
    --override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.VC.CMake.Project --add Microsoft.VisualStudio.Component.Windows11SDK.26100"
}

# 定位 Homebrew，并将其命令目录加入当前脚本环境。
activate_homebrew() {
  local brew_command=""
  if command -v brew >/dev/null 2>&1; then
    brew_command="$(command -v brew)"
  elif [[ -x /opt/homebrew/bin/brew ]]; then
    brew_command="/opt/homebrew/bin/brew"
  elif [[ -x /usr/local/bin/brew ]]; then
    brew_command="/usr/local/bin/brew"
  fi
  [[ -n "$brew_command" ]] || return 1
  eval "$("$brew_command" shellenv)"
}

# 安装 Homebrew 及项目需要的 macOS 原生依赖。
install_mac_toolchain() {
  if ! xcode-select -p >/dev/null 2>&1; then
    step "Requesting Xcode Command Line Tools installation"
    xcode-select --install 2>/dev/null || true
    echo "Complete the macOS Xcode Command Line Tools prompt, then rerun this script." >&2
    exit 2
  fi

  if ! activate_homebrew; then
    if ! command -v curl >/dev/null 2>&1; then
      echo "curl is required to install Homebrew" >&2
      exit 1
    fi
    step "Installing Homebrew"
    NONINTERACTIVE=1 /bin/bash -c \
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    activate_homebrew || {
      echo "Homebrew installation completed but brew could not be located" >&2
      exit 1
    }
  fi

  step "Installing CMake, Ninja, Boost, and OpenSSL"
  brew install cmake ninja boost openssl@3
}

detect_platform
step "Detected platform $PLATFORM-$ARCH"

if toolchain_is_ready; then
  step "Native build toolchain is ready"
  verify_toolchain
  exit 0
fi

if [[ "$CHECK_ONLY" == "1" ]]; then
  step "Native build prerequisites are missing"
  verify_toolchain
  exit 1
fi

if [[ "$PLATFORM" == "win32" ]]; then
  install_windows_toolchain
else
  install_mac_toolchain
fi

step "Verifying installed native build toolchain"
verify_toolchain
step "Desktop build tools are ready"
