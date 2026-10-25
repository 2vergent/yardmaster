#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p logs temp

# Stop a leftover nginx from THIS folder only; other projects' nginx stay up.
if [ -f logs/nginx.pid ]; then
  kill "$(cat logs/nginx.pid)" 2>/dev/null || true
fi

# macOS/Linux use the system nginx; -p/-e keep its files inside this folder.
exec nginx -p "$SCRIPT_DIR/" -e "$SCRIPT_DIR/logs/error.log" -c conf/nginx.conf -g "daemon off;"