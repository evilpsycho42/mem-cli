#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_JS="$ROOT/dist/index.js"

if [[ ! -f "$CLI_JS" ]]; then
  echo "[info] dist/ missing; building..."
  (cd "$ROOT" && npm run build)
fi

MODEL_PATH="${MEM_CLI_MODEL:-}"
if [[ -z "$MODEL_PATH" ]]; then
  if [[ -f "$ROOT/models/Qwen3-Embedding-0.6B-Q8_0.gguf" ]]; then
    MODEL_PATH="$ROOT/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
  else
    MODEL_PATH="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
  fi
fi

export MEM_CLI_MODEL="$MODEL_PATH"
export MEM_CLI_E2E_PERF_V2_CACHE_DIR="${MEM_CLI_E2E_PERF_V2_CACHE_DIR:-$ROOT/.cache/e2e-performance-v2}"

# Keep daemon alive for the full run.
export MEM_CLI_DAEMON="${MEM_CLI_DAEMON:-1}"
export MEM_CLI_DAEMON_IDLE_MS="${MEM_CLI_DAEMON_IDLE_MS:-1800000}"

mkdir -p "$MEM_CLI_E2E_PERF_V2_CACHE_DIR"

node "$ROOT/scripts/e2e-performance-v2.js"

