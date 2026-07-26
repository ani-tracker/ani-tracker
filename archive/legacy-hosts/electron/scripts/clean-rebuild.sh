#!/usr/bin/env bash
set -euo pipefail

RUN_MODE="preview"
SKIP_STORE_PRUNE=0
KILL_APP=0

# 输出脚本参数说明。
usage() {
  cat <<'EOF'
Usage: bash scripts/clean-rebuild.sh [options]

Options:
  --run preview|dev|none   Run mode after build. Default: preview
  --skip-store-prune       Skip pnpm store prune
  --kill-app               Best-effort stop of workspace Electron processes
  -h, --help               Show this help

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
    --skip-store-prune)
      SKIP_STORE_PRUNE=1
      shift
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

initialize_rebuild_environment

if [[ "$KILL_APP" == "1" ]]; then
  step "Stopping workspace Electron processes"
  stop_workspace_processes
fi

verify_native_build_prerequisites

step "Cleaning generated directories"
for path in \
  node_modules out dist release .build \
  native/torrent-core/build/portable-release \
  "artifacts/torrent-core/$PLATFORM-$ARCH"; do
  remove_workspace_item "$path"
done

step "Cleaning generated TypeScript/Vite files"
clean_generated_typescript_files

if [[ "$SKIP_STORE_PRUNE" != "1" ]]; then
  step "Pruning pnpm store"
  run_pnpm store prune
fi

step "Installing dependencies"
run_pnpm install

build_project
run_selected_mode
