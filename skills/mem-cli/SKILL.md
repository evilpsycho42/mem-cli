---
name: mem-cli
description: Use the `mem` CLI (mem-cli) to manage agent memory stored as Markdown + a local SQLite index. Use when Codex needs to initialize a public/private memory workspace, add daily/long-term memories, run hybrid semantic+keyword search (default Qwen3 embeddings), reindex after settings changes, or troubleshoot search/embedding behavior via the global config at `~/.mem-cli/settings.json`.
---

# mem-cli (Agent Memory CLI)

## Quick start

1. Initialize a workspace:
   - Public (shared): `mem init --public`
   - Private (token-protected): `mem init --token "<token>"`

2. Add memories:
   - Daily log entry (appends raw Markdown text): `mem add short "..." --public|--token "<token>"`
   - Long-term memory (`MEMORY.md`): `mem add long --stdin --public|--token "<token>"`

3. Search (always hybrid):
   - `mem search "query" --public|--token "<token>"`

## Storage model (what gets indexed)

- Long-term memory: `MEMORY.md` at the workspace root.
- Daily logs: `memory/YYYY-MM-DD.md` (plain Markdown; no required structure).
- Index DB: `index.db` in each workspace.

Chunking rule:
- Moltbot-style size-based chunking: accumulate lines until `chunking.tokens * chunking.charsPerToken` chars, then flush.
- `chunking.overlap` keeps tail context across chunks (line-based carry).

## Global configuration

All workspaces share one settings file:
- `~/.mem-cli/settings.json`

Default settings (tuned for agent use):
- Embeddings: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf` (downloaded + cached)
- Search: `vectorWeight=0.9`, `textWeight=0.1`, `candidateMultiplier=2`
- Chunking: `tokens=400`, `overlap=80` (size-based; approximate; chosen to reduce irrelevant context)

Important fields:
- `embeddings.modelPath`: Embedding model spec (local `.gguf` path or `hf:...`). Usually you can keep the default.
- `embeddings.cacheDir`: Where remote models are cached (this is NOT the embedding-cache for chunks).
- `chunking.*`: Controls max chunk size + overlap.
- `search.*`: Controls hybrid scoring weights and candidate limits.

After editing settings:
- Run `mem reindex --public|--token "<token>"` for the affected workspace (or just run `mem search ...` and let it auto-trigger if needed).

## How scoring works (hybrid)

Each result score is:
- `score = vectorWeight * vectorScore + textWeight * textScore`

Where:
- `vectorScore = 1 - cosineDistance(queryEmbedding, chunkEmbedding)`
- `textScore = 1 / (1 + bm25_rank)`

## Debugging and troubleshooting

- Check workspace + config path: `mem state --public` or `mem state --token "<token>"`
- If results look “too broad”: lower `chunking.tokens` or increase `chunking.overlap` in `~/.mem-cli/settings.json`, then run `mem reindex`.
- If embeddings/model changed: run `mem reindex` (or any command will reindex when it detects a model mismatch).
- If embeddings fail to load (missing `node-llama-cpp` / invalid model path), mem-cli prints an error and falls back to keyword-only indexing/search.
- If vector search is unavailable, hybrid may fall back to slower in-process cosine similarity; verify `sqlite-vec` loads on your platform and the embedding model is accessible.
- macOS: `node-llama-cpp` uses Metal by default (including integrated GPUs). If Metal causes issues, use `export NODE_LLAMA_CPP_GPU=off`.
