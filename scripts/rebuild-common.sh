#!/usr/bin/env bash

PLATFORM=""
ARCH=""
PNPM_COMMAND=""
REBUILD_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$REBUILD_SCRIPT_DIR/.." && pwd)"

# 输出带分隔符的构建步骤日志。
step() {
  printf '\n==> %s\n' "$1"
}

# 将目标路径规范化，供删除边界检查使用。
resolve_path() {
  local target="$1"
  local parent
  local name
  parent="$(dirname -- "$target")"
  name="$(basename -- "$target")"
  if [[ -d "$parent" ]]; then
    printf '%s/%s\n' "$(cd -- "$parent" && pwd -P)" "$name"
  else
    printf '%s\n' "$target"
  fi
}

# 拒绝删除工作区之外的路径。
assert_workspace_path() {
  local target
  target="$(resolve_path "$1")"
  case "$target" in
    "$ROOT"/*) ;;
    *)
      echo "Refusing to remove path outside workspace: $target" >&2
      exit 1
      ;;
  esac
}

# 安全删除工作区内的单个绝对路径。
remove_workspace_target() {
  local target="$1"
  [[ -e "$target" || -L "$target" ]] || return 0
  assert_workspace_path "$target"
  echo "Removing $target"
  rm -rf -- "$target"
}

# 安全删除工作区内的单个相对路径。
remove_workspace_item() {
  remove_workspace_target "$ROOT/$1"
}

# 通过 Node 识别宿主平台和架构，避免依赖 MSYS 的 uname 名称。
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

# 选择当前平台可执行的 pnpm 命令。
resolve_pnpm_command() {
  local candidate
  local candidates=(pnpm)
  if [[ "$PLATFORM" == "win32" ]]; then
    candidates=(pnpm.cmd pnpm)
  fi
  for candidate in "${candidates[@]}"; do
    if command -v "$candidate" >/dev/null 2>&1; then
      PNPM_COMMAND="$candidate"
      return 0
    fi
  done
  echo "pnpm is required but was not found in PATH" >&2
  exit 1
}

# 使用已解析的平台命令运行 pnpm。
run_pnpm() {
  "$PNPM_COMMAND" "$@"
}

# 在 Windows 下仅终止属于当前工作区的 Electron 和开发服务进程。
stop_windows_processes() {
  local root_windows="$ROOT"
  local helper_windows="$REBUILD_SCRIPT_DIR/stop-workspace-processes.ps1"
  if command -v cygpath >/dev/null 2>&1; then
    root_windows="$(cygpath -w "$ROOT")"
    helper_windows="$(cygpath -w "$helper_windows")"
  fi
  if ! command -v powershell.exe >/dev/null 2>&1; then
    echo "powershell.exe is required for --kill-app on Windows" >&2
    exit 1
  fi
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass \
    -File "$helper_windows" -Root "$root_windows"
}

# 按平台终止当前工作区的桌面开发进程。
stop_workspace_processes() {
  if [[ "$PLATFORM" == "win32" ]]; then
    stop_windows_processes
    return
  fi
  pkill -f "$ROOT/.*/electron" 2>/dev/null || true
  pkill -f "electron-vite.*$ROOT" 2>/dev/null || true
  pkill -f "$ROOT/.*/qbittorrent-nox" 2>/dev/null || true
  pkill -f "$ROOT/.*/torrent-core" 2>/dev/null || true
}

# 清理 TypeScript 和 Vite 意外生成的源码区文件。
clean_generated_typescript_files() {
  rm -f -- electron.vite.config.js electron.vite.config.d.ts ./*.tsbuildinfo
  if [[ -d src ]]; then
    find src \( -name '*.js' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) \
      ! -path 'src/renderer/src/vite-env.d.ts' \
      -delete
  fi
}

# 准备当前平台的 libVLC 开发运行时和原生模块。
prepare_desktop_runtime() {
  if [[ "$PLATFORM" == "darwin" ]]; then
    step "Preparing macOS libVLC runtime and Electron native modules"
    run_pnpm run prepare:mac-libvlc-dev
    return
  fi

  step "Preparing Windows libVLC runtime and Electron native modules"
  run_pnpm run prepare:win-libvlc-dev
}

# 编译、打包并校验当前平台的 torrent-core。
prepare_desktop_torrent_core() {
  step "Building portable torrent-core for $PLATFORM-$ARCH"
  run_pnpm run prepare:desktop-torrent-core-dev -- --arch "$ARCH"
}

# 在清理任何产物前验证当前平台原生构建工具链。
verify_native_build_prerequisites() {
  step "Checking native build prerequisites for $PLATFORM-$ARCH"
  run_pnpm run prepare:desktop-torrent-core-dev -- --arch "$ARCH" --check-only
}

# 初始化工作目录和跨平台命令。
initialize_rebuild_environment() {
  cd "$ROOT"
  detect_platform
  resolve_pnpm_command
  step "Detected platform $PLATFORM-$ARCH"
}

# 执行类型检查、生产构建和桌面运行时准备。
build_project() {
  step "Running typecheck"
  run_pnpm run typecheck
  prepare_desktop_torrent_core
  step "Building production output"
  ANI_TORRENT_CORE_SOURCE_ROOT="$ROOT/artifacts/torrent-core" "$PNPM_COMMAND" build
  prepare_desktop_runtime
}

# 按用户选择启动预览、开发服务或直接结束。
run_selected_mode() {
  case "$RUN_MODE" in
    preview)
      step "Starting Electron preview"
      run_pnpm preview
      ;;
    dev)
      step "Starting Electron dev server"
      run_pnpm dev
      ;;
    none)
      step "Done"
      ;;
  esac
}
