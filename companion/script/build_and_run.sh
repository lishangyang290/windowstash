#!/bin/zsh
set -euo pipefail

mode="${1:-run}"
app="src-tauri/target/release/bundle/macos/WindowStash Companion.app"

case "$mode" in
  run)
    npm run tauri:build
    pkill -x "WindowStash Companion" 2>/dev/null || true
    open -n "$app"
    ;;
  debug)
    npm run tauri dev
    ;;
  logs)
    /usr/bin/log stream --style compact --predicate 'process == "WindowStash Companion"'
    ;;
  telemetry)
    /usr/bin/log show --last 10m --style compact --predicate 'process == "WindowStash Companion"'
    ;;
  verify)
    npm run lint
    npm run typecheck
    npm run test
    npm run tauri:build
    ;;
  *)
    echo "Usage: $0 {run|debug|logs|telemetry|verify}" >&2
    exit 2
    ;;
esac
