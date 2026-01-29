#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_JS="$ROOT/dist/index.js"

if [[ ! -f "$CLI_JS" ]]; then
  echo "[info] dist/ missing; building..."
  (cd "$ROOT" && npm run build)
fi

node "$ROOT/scripts/e2e-reindex-performance.js"

