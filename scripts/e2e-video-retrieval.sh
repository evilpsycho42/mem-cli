#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI_JS="$ROOT/dist/index.js"

if [[ ! -f "$CLI_JS" ]]; then
  echo "[info] dist/ missing; building..."
  (cd "$ROOT" && npm run build)
fi

HOME_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mem-cli-home-XXXXXX")"
cleanup() {
  rm -rf "$HOME_DIR"
}
trap cleanup EXIT

export HOME="$HOME_DIR"

MODEL_PATH="${MEM_CLI_MODEL:-}"
if [[ -z "$MODEL_PATH" ]]; then
  if [[ -f "$ROOT/models/Qwen3-Embedding-0.6B-Q8_0.gguf" ]]; then
    MODEL_PATH="$ROOT/models/Qwen3-Embedding-0.6B-Q8_0.gguf"
  else
    MODEL_PATH="hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
  fi
fi

mkdir -p "$HOME_DIR/.mem-cli"
cat >"$HOME_DIR/.mem-cli/settings.json" <<EOF
{
  "version": 2,
  "chunking": { "tokens": 400, "overlap": 80, "minChars": 32, "charsPerToken": 4 },
  "embeddings": {
    "modelPath": "$MODEL_PATH",
    "cacheDir": "~/.mem-cli/model-cache",
    "batchMaxTokens": 8000,
    "approxCharsPerToken": 1,
    "cacheLookupBatchSize": 400,
    "queryInstructionTemplate": "Instruct: Given a memory search query, retrieve relevant memory snippets that answer the query\\nQuery: {query}"
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

echo "[step 1/4] init public workspace"
node "$CLI_JS" init --public >/dev/null
WS="$HOME_DIR/.mem-cli/public"

echo "[step 2/4] smoke test add commands"
node "$CLI_JS" add short --public "smoke: unrelated memory about gardening and cooking" >/dev/null
echo "smoke: unrelated long memory about keyboards and monitors" | node "$CLI_JS" add long --public --stdin >/dev/null

echo "[step 3/4] write multilingual retrieval corpus"
CORPUS_DIR="$WS/memory/corpus-video"
mkdir -p "$CORPUS_DIR"

cat >"$CORPUS_DIR/doc-01.md" <<'EOF'
这家公司提供高质量的视频转码和实时流媒体服务。
EOF
cat >"$CORPUS_DIR/doc-02.md" <<'EOF'
我们正在优化视频播放的延迟和清晰度。
EOF
cat >"$CORPUS_DIR/doc-03.md" <<'EOF'
该平台支持点播和直播两种视频场景。
EOF
cat >"$CORPUS_DIR/doc-04.md" <<'EOF'
The platform offers real-time video streaming with low latency.
EOF
cat >"$CORPUS_DIR/doc-05.md" <<'EOF'
Video transcoding and adaptive bitrate are core features of this service.
EOF
cat >"$CORPUS_DIR/doc-06.md" <<'EOF'
This product focuses on improving video playback quality.
EOF
cat >"$CORPUS_DIR/doc-07.md" <<'EOF'
系统可以根据网络情况动态调整视频码率。
EOF
cat >"$CORPUS_DIR/doc-08.md" <<'EOF'
用户在弱网环境下也能流畅观看视频。
EOF
cat >"$CORPUS_DIR/doc-09.md" <<'EOF'
The system dynamically adjusts bitrate based on network conditions.
EOF
cat >"$CORPUS_DIR/doc-10.md" <<'EOF'
Users can watch videos smoothly even on poor connections.
EOF
cat >"$CORPUS_DIR/doc-11.md" <<'EOF'
低延迟直播对于在线活动非常重要。
EOF
cat >"$CORPUS_DIR/doc-12.md" <<'EOF'
Low-latency live streaming is critical for online events.
EOF
cat >"$CORPUS_DIR/doc-13.md" <<'EOF'
后端服务需要处理高并发请求。
EOF
cat >"$CORPUS_DIR/doc-14.md" <<'EOF'
The backend infrastructure must scale under heavy traffic.
EOF
cat >"$CORPUS_DIR/doc-15.md" <<'EOF'
我今天中午吃了一碗牛肉面。
EOF
cat >"$CORPUS_DIR/doc-16.md" <<'EOF'
上海的天气最近有点潮湿。
EOF
cat >"$CORPUS_DIR/doc-17.md" <<'EOF'
I bought a new keyboard for my laptop.
EOF
cat >"$CORPUS_DIR/doc-18.md" <<'EOF'
The cat is sleeping on the sofa.
EOF

echo "[step 4/4] reindex + evaluate retrieval quality"
node "$CLI_JS" reindex --public >/dev/null
STATE_JSON="$(node "$CLI_JS" state --public --json)"
VECTOR_READY="$(node -e 'const fs=require("fs");const raw=fs.readFileSync(0,"utf8");const v=JSON.parse(raw).vectorReady;process.stdout.write(v?"true":"false");' <<<"$STATE_JSON")"
if [[ "$VECTOR_READY" != "true" ]]; then
  echo "[error] vector index is unavailable (embeddings failed or sqlite-vec not ready)."
  echo "[hint] Ensure node-llama-cpp is installed and MEM_CLI_MODEL points to a valid embedding model."
  exit 1
fi

export MEM_CLI_E2E_HOME="$HOME_DIR"
export MEM_CLI_E2E_CLI="$CLI_JS"

node <<'NODE'
const { spawnSync } = require("node:child_process");
const assert = require("node:assert/strict");

const homeDir = process.env.MEM_CLI_E2E_HOME;
const cli = process.env.MEM_CLI_E2E_CLI;
assert.ok(homeDir, "MEM_CLI_E2E_HOME missing");
assert.ok(cli, "MEM_CLI_E2E_CLI missing");

function run(args) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, HOME: homeDir },
    encoding: "utf8"
  });
  const elapsedMs = Date.now() - started;
  if (res.status !== 0) {
    console.error(res.stderr || res.stdout);
    process.exit(res.status || 1);
  }
  return { elapsedMs, stdout: res.stdout };
}

function search(query) {
  const { elapsedMs, stdout } = run(["search", query, "--public", "--json"]);
  const parsed = JSON.parse(stdout);
  return { elapsedMs, results: parsed.results || [] };
}

const docs = [
  { id: "01", group: "A", lang: "zh" },
  { id: "02", group: "A", lang: "zh" },
  { id: "03", group: "A", lang: "zh" },
  { id: "04", group: "A", lang: "en" },
  { id: "05", group: "A", lang: "en" },
  { id: "06", group: "A", lang: "en" },
  { id: "07", group: "B", lang: "zh" },
  { id: "08", group: "B", lang: "zh" },
  { id: "09", group: "B", lang: "en" },
  { id: "10", group: "B", lang: "en" },
  { id: "11", group: "C", lang: "zh" },
  { id: "12", group: "C", lang: "en" },
  { id: "13", group: "D", lang: "zh" },
  { id: "14", group: "D", lang: "en" },
  { id: "15", group: "E", lang: "zh" },
  { id: "16", group: "E", lang: "zh" },
  { id: "17", group: "E", lang: "en" },
  { id: "18", group: "E", lang: "en" }
];

const byPath = new Map(docs.map((d) => [`memory/corpus-video/doc-${d.id}.md`, d]));
const relevant = new Set(docs.filter((d) => ["A", "B", "C"].includes(d.group)).map((d) => d.id));
const negatives = new Set(docs.filter((d) => d.group === "E").map((d) => d.id));

function evaluate(query, expectCrossLang) {
  const { elapsedMs, results } = search(query);
  console.log(`\n[query] ${query}`);
  console.log(`[time] ${elapsedMs}ms`);

  const top = results.slice(0, 10).map((r) => ({
    file: r.file_path,
    score: Number(r.score ?? 0),
    doc: byPath.get(String(r.file_path || ""))
  }));

  for (const [i, entry] of top.entries()) {
    const label = entry.doc ? `${entry.doc.group}${entry.doc.id}(${entry.doc.lang})` : "other";
    console.log(`${String(i + 1).padStart(2, " ")}. ${label}  ${entry.file}  score=${entry.score.toFixed(4)}`);
  }

  const top8Docs = top.slice(0, 8).map((e) => e.doc).filter(Boolean);
  const relevantHits = top8Docs.filter((d) => relevant.has(d.id)).length;
  assert.ok(
    relevantHits >= 6,
    `expected >=6 relevant (A/B/C) docs in top 8, got ${relevantHits}`
  );

  const top10Docs = top.map((e) => e.doc).filter(Boolean);
  const negativeHits = top10Docs.filter((d) => negatives.has(d.id)).map((d) => d.id);
  assert.equal(negativeHits.length, 0, `expected no E negatives in top 10, got ${negativeHits.join(",")}`);

  const hasCrossLang = top8Docs.some((d) => d.lang === expectCrossLang);
  assert.ok(hasCrossLang, `expected at least one ${expectCrossLang} doc in top 8`);
}

evaluate(
  "How does the system handle low-latency video streaming and playback quality?",
  "zh"
);
evaluate("这个系统是如何保证视频直播低延迟和播放质量的？", "en");

console.log("\n[ok] retrieval quality checks passed");
NODE

echo ""
echo "[ok] done (temp HOME=$HOME_DIR)"
