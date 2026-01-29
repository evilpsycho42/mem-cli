#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI=(node "$ROOT/dist/index.js")

if [[ ! -f "$ROOT/dist/index.js" ]]; then
  echo "[info] dist/ missing; building..."
  (cd "$ROOT" && npm run build)
fi

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mem-cli-home-XXXXXX")"
WS_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mem-cli-ws-XXXXXX")"
TOKEN="test-token-$(date +%s)"

cleanup() {
  "${CLI[@]}" __daemon --shutdown >/dev/null 2>&1 || true
  rm -rf "$HOME_DIR" "$WS_ROOT"
}
trap cleanup EXIT

export HOME="$HOME_DIR"

echo "[step 1/3] init workspace"
INIT_JSON="$("${CLI[@]}" init --token "$TOKEN" --path "$WS_ROOT" --json)"
WORKSPACE_DIR="$(node -e 'const fs=require("fs");const raw=fs.readFileSync(0,"utf8");console.log(JSON.parse(raw).workspace);' <<<"$INIT_JSON")"
SETTINGS_FILE="$(node -e 'const fs=require("fs");const raw=fs.readFileSync(0,"utf8");console.log(JSON.parse(raw).settingsFile);' <<<"$INIT_JSON")"

cat >"$SETTINGS_FILE" <<'EOF'
{
  "version": 2,
  "chunking": { "tokens": 400, "overlap": 80, "minChars": 32, "charsPerToken": 4 },
  "embeddings": {
    "modelPath": "__MODEL_PATH__",
    "cacheDir": "",
    "batchMaxTokens": 8000,
    "approxCharsPerToken": 1,
    "cacheLookupBatchSize": 400,
    "queryInstructionTemplate": "Instruct: Given a memory search query, retrieve relevant memory snippets that answer the query\nQuery: {query}"
  },
  "search": {
    "limit": 10,
    "vectorWeight": 0.7,
    "textWeight": 0.3,
    "candidateMultiplier": 4,
    "maxCandidates": 200,
    "snippetMaxChars": 700
  },
  "summary": { "days": 7, "maxChars": 8000, "full": false },
  "debug": { "vector": false }
}
EOF

MODEL_PATH="$ROOT/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
if [[ ! -f "$MODEL_PATH" ]]; then
  echo "[error] embedding model not found at $MODEL_PATH"
  exit 1
fi
perl -0777 -i -pe "s|__MODEL_PATH__|$MODEL_PATH|g" "$SETTINGS_FILE"

echo "[step 2/3] write stock/investing memories"
cat <<'EOF' | "${CLI[@]}" add long --token "$TOKEN" --stdin >/dev/null
## Investing
- Prefer low-cost index funds for stock exposure.
- Keep a diversified portfolio of stocks and bonds.
- Focus on long-term investing and dollar-cost averaging into equities.
EOF

cat <<'EOF' | "${CLI[@]}" add short --token "$TOKEN" --stdin >/dev/null
secret code: QQQ
EOF

cat <<'EOF' | "${CLI[@]}" add short --token "$TOKEN" --stdin >/dev/null
Compared index funds vs individual stocks; noted diversification reduces risk.
EOF

echo "[step 3/3] semantic searches with different wording"
run_query() {
  local q=("$@")
  echo ""
  echo "\$ mem search ${q[*]}"
  "${CLI[@]}" search "${q[@]}" --token "$TOKEN"
}

run_query equity exposure
run_query buy shares
run_query diversified portfolio

echo ""
echo "[ok] done (temp HOME=$HOME_DIR, workspace=$WS_ROOT)"
