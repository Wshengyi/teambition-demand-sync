#!/usr/bin/env bash
# Convenience runner. Set TB_SYNC_CONFIG to point at your config file
# and TB_SYNC_LOG to a log file if you want tail-able output.
set -eu

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

: "${TB_SYNC_CONFIG:=$ROOT/config/tb_sync.config.json}"
export TB_SYNC_CONFIG

if [ -n "${TB_SYNC_LOG:-}" ]; then
  exec node "$ROOT/scripts/tb_sync.js" >> "$TB_SYNC_LOG" 2>&1
else
  exec node "$ROOT/scripts/tb_sync.js"
fi
