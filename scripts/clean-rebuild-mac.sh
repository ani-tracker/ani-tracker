#!/usr/bin/env bash
set -euo pipefail

RUN_MODE="preview"
SKIP_STORE_PRUNE=0
KILL_APP=0

usage() {
  cat <<'EOF'
Usage: bash scripts/clean-rebuild-mac.sh [options]

Options:
  --run preview|dev|none   Run mode after build. Default: preview
  --skip-store-prune       Skip pnpm store prune
  --kill-app               Best-effort stop of workspace Electron processes
  -h, --help               Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --run)
      RUN_MODE="${2:-}"
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
ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT"

step() {
  printf '\n==> %s\n' "$1"
}

resolve_path() {
  local target="$1"
  local parent
  parent="$(dirname -- "$target")"
  local name
  name="$(basename -- "$target")"
  if [[ -d "$parent" ]]; then
    printf '%s/%s\n' "$(cd -- "$parent" && pwd -P)" "$name"
  else
    printf '%s\n' "$target"
  fi
}

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

remove_workspace_item() {
  local relative="$1"
  local target="$ROOT/$relative"
  [[ -e "$target" ]] || return 0
  assert_workspace_path "$target"
  echo "Removing $target"
  rm -rf -- "$target"
}

if [[ "$KILL_APP" == "1" ]]; then
  step "Stopping workspace Electron processes"
  pkill -f "$ROOT/.*/electron" 2>/dev/null || true
  pkill -f "electron-vite.*$ROOT" 2>/dev/null || true
fi

step "Cleaning generated directories"
for path in node_modules out dist release .build; do
  remove_workspace_item "$path"
done

step "Cleaning generated TypeScript/Vite files"
rm -f -- electron.vite.config.js electron.vite.config.d.ts ./*.tsbuildinfo

if [[ -d src ]]; then
  find src \( -name '*.js' -o -name '*.d.ts' -o -name '*.tsbuildinfo' \) \
    ! -path 'src/renderer/src/vite-env.d.ts' \
    -delete
fi

if [[ "$SKIP_STORE_PRUNE" != "1" ]]; then
  step "Pruning pnpm store"
  pnpm store prune
fi

step "Installing dependencies"
pnpm install

step "Running typecheck"
pnpm run typecheck

step "Building production output"
pnpm build

step "Preparing macOS libVLC runtime and Electron native modules"
pnpm run prepare:mac-libvlc-dev

case "$RUN_MODE" in
  preview)
    step "Starting Electron preview"
    pnpm preview
    ;;
  dev)
    step "Starting Electron dev server"
    pnpm dev
    ;;
  none)
    step "Done"
    ;;
esac
