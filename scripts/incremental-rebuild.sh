#!/usr/bin/env bash
set -euo pipefail

RUN_MODE="preview"
KILL_APP=0

# 输出脚本参数说明。
usage() {
  cat <<'EOF'
Usage: bash scripts/incremental-rebuild.sh [options]

Options:
  --run preview|dev|none   Run mode after build. Default: preview
  --kill-app               Best-effort stop of workspace Electron processes
  -h, --help               Show this help

This incremental rebuild keeps node_modules and the pnpm store, but clears build
outputs and tool caches that can keep stale Electron/Vite/TypeScript artifacts.
Windows must run this script from Git Bash or another Bash environment.
Native builds require CMake 3.24+, Ninja, and a platform C++ toolchain.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      if [[ $# -lt 2 ]]; then
        echo "--run requires a value" >&2
        exit 1
      fi
      RUN_MODE="$2"
      shift 2
      ;;
    --kill-app)
      KILL_APP=1
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

if [[ "$RUN_MODE" != "preview" && "$RUN_MODE" != "dev" && "$RUN_MODE" != "none" ]]; then
  echo "--run must be preview, dev, or none" >&2
  exit 1
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/rebuild-common.sh
source "$SCRIPT_DIR/rebuild-common.sh"

# 清理常规工具缓存，但保留已完成摘要校验的 libVLC 下载归档。
clean_workspace_cache() {
  local cache_root="$ROOT/.cache"
  [[ -d "$cache_root" ]] || return 0
  while IFS= read -r -d '' target; do
    [[ "$(basename -- "$target")" == "libvlc" ]] && continue
    remove_workspace_target "$target"
  done < <(find "$cache_root" -mindepth 1 -maxdepth 1 -print0)
}

initialize_rebuild_environment

if [[ "$KILL_APP" == "1" ]]; then
  step "Stopping workspace Electron processes"
  stop_workspace_processes
fi

if [[ ! -d node_modules ]]; then
  echo "node_modules not found. Run bash scripts/clean-rebuild.sh first to install dependencies." >&2
  exit 1
fi

verify_native_build_prerequisites

step "Cleaning build output directories"
for path in out dist release .build; do
  remove_workspace_item "$path"
done

step "Cleaning dependency tool caches"
for path in node_modules/.vite node_modules/.cache .vite; do
  remove_workspace_item "$path"
done
clean_workspace_cache

step "Cleaning generated TypeScript/Vite files"
clean_generated_typescript_files

build_project
run_selected_mode
