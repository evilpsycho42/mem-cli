---
name: mem-cli
description: Use the `mem` CLI (mem-cli) to manage agent memory stored as Markdown + a local SQLite index. Use when Codex needs to initialize a public/private memory workspace, add daily/long-term memories, and run search for retrieval.
---

# mem-cli (Agent Memory CLI)

## Agent safety rules

- Do **not** edit `~/.mem-cli/settings.json` (it affects all workspaces).
- Do **not** run `mem reindex` / `mem reindex --all`. If indexing seems stale or settings changed, ask the user to run reindex themselves.

## Quick start

1. Initialize a workspace:
   - Public (shared): `mem init --public`
   - Private (token-protected): `mem init --token "<token>"`

2. Add memories:
   - Daily log entry (appends raw Markdown text): `mem add short "..." --public|--token "<token>"`
   - Long-term memory (`MEMORY.md`): `mem add long --stdin --public|--token "<token>"`

3. Search (semantic):
   - `mem search "query" --public|--token "<token>"`

## Storage model (what gets indexed)

- Long-term memory: `MEMORY.md` at the workspace root.
- Daily logs: `memory/YYYY-MM-DD.md` (plain Markdown; no required structure).
- Index DB: `index.db` in each workspace.

## Debugging and troubleshooting

- Check workspace stats: `mem state --public` or `mem state --token "<token>"`
- If embeddings fail to load (missing `node-llama-cpp` / invalid model path), `mem search` will error. Ask the user to fix their local embeddings setup.
- If vector search is unavailable, semantic search may fall back to slower in-process cosine similarity; verify `sqlite-vec` loads on your platform and the embedding model is accessible.
- Daemon: by default, `mem add|search` runs via a background daemon to keep embeddings loaded. Disable with `MEM_CLI_DAEMON=0`. To reset (advanced), run `mem __daemon --shutdown`.
- macOS: `node-llama-cpp` uses Metal by default (including integrated GPUs). If Metal causes issues, use `export NODE_LLAMA_CPP_GPU=off`.
