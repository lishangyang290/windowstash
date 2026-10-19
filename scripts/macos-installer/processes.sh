#!/bin/sh
# Installer-owned helper. Never touch Chrome, LaunchAgents, or user data.
set -eu
app='/Applications/WindowStash Companion.app'

stop_installed_processes() {
  attempt=0
  while :; do
    snapshot=$(/bin/ps -ww -axo pid=,comm=) || return 1
    pids=$(printf '%s\n' "$snapshot" | /usr/bin/awk -v app="$app" '
      { pid=$1; sub(/^[[:space:]]*[0-9]+[[:space:]]+/, "") }
      $0 == app "/Contents/MacOS/windowstash-companion" ||
      $0 == app "/Contents/MacOS/windowstash-native-host" { print pid }
    ')
    [ -n "$pids" ] || return 0
    if [ "$attempt" -ge 10 ]; then
      echo 'WindowStash could not exit safely. Installation stopped; no forced termination.' >&2
      return 1
    fi
    for pid in $pids; do
      /bin/kill -TERM "$pid" 2>/dev/null || true
    done
    attempt=$((attempt + 1))
    /bin/sleep 1
  done
}
