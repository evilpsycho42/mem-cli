---
name: mem-cli
description: Use the `mem` CLI (mem-cli) to manage agent memory stored as Markdown + a local SQLite index. Use when Codex needs to initialize a public/private memory workspace, add daily/long-term memories, run hybrid semantic+keyword search, reindex after settings/model changes, or troubleshoot search/embedding behavior via the global config at `~/.mem-cli/settings.json`.
---

# mem-cli (Agent Memory CLI)

## Quick start

1. Initialize a workspace:
   - Public (shared): `mem init --public`
   - Private (token-protected): `mem init --token "<token>"`

2. Add memories:
   - Daily log entry (timestamped `## HH:MM`): `mem add short "..." --public|--token "<token>"`
   - Long-term memory (`MEMORY.md`): `mem add long --stdin --public|--token "<token>"`

3. Search (always hybrid):
   - `mem search "query" --public|--token "<token>"`

## Storage model (what gets indexed)

- Long-term memory: `MEMORY.md` at the workspace root.
- Daily logs: `memory/YYYY-MM-DD.md` (each entry is a `## ...` section, e.g. `## 14:38`).
- Index DB: `index.db` in each workspace.

Chunking rule:
- Each Markdown `## ...` section becomes a searchable chunk (preamble before the first `##` is skipped).
- If a single `##` section is too large, it is sub-chunked using the configured overlap.

## Global configuration

All workspaces share one settings file:
- `~/.mem-cli/settings.json`

Important fields:
- `embeddings.modelPath`: Local `.gguf` path or remote spec (e.g. `hf:...`).
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
- If results look “too broad”: ensure your memories use `##` sections (chunking is `##`-based).
- If embeddings/model changed: run `mem reindex` (or any command will reindex when it detects a model mismatch).
- If vector search is unavailable, hybrid may fall back to slower in-process cosine similarity; verify `sqlite-vec` loads on your platform and the embedding model is accessible.
