# mem (mem-cli)

A tiny, local “memory” tool for agents:
- Store memories as plain Markdown files
- Search them fast (hybrid keyword + semantic embeddings)
- Keep everything on disk (no server)

## Install

```bash
npm i -g @kky42/mem-cli
```

If npm fails with `EEXIST .../bin/mem`:

```bash
which mem
rm "$(which mem)"   # or: npm i -g --force @kky42/mem-cli
```

## Try it in 60 seconds (public workspace)

```bash
mem init --public

mem add short "I am Kevin." --public
echo "Prefer low-cost index funds for stock exposure." | mem add long --public --stdin

mem search "equity allocation" --public
mem state --public
```

What gets created:
- `~/.mem-cli/public/MEMORY.md` (long-term memory)
- `~/.mem-cli/public/memory/YYYY-MM-DD.md` (daily notes)
- `~/.mem-cli/public/index.db` (local search index)

You can also edit the Markdown files directly; run `mem reindex --public` afterwards.

## Private workspace (token-protected)

```bash
mem init --token "my-token-123"
mem add short "User prefers concise answers." --token "my-token-123"
mem search "preferences" --token "my-token-123"
```

Keep your token somewhere safe (password manager / env var). mem-cli only stores a hash and **cannot recover a lost token**.

## Semantic search (local embeddings)

`mem search` is always **hybrid** (keyword + semantic).

- Default embedding model: **Qwen3-Embedding-0.6B (GGUF)** via `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`
- Model cache dir: `~/.mem-cli/model-cache`
- If embeddings can’t load (e.g. `node-llama-cpp` missing), mem-cli falls back to keyword-only search.

macOS note:
- `node-llama-cpp` uses Metal by default on macOS (including integrated GPUs). If Metal causes issues, run with `export NODE_LLAMA_CPP_GPU=off`.

## Daemon (fast repeated queries)

By default, `mem add|search|reindex` runs via a background daemon so the embeddings model stays loaded (no model load per CLI call).

- Disable: `MEM_CLI_DAEMON=0`
- Idle shutdown: `MEM_CLI_DAEMON_IDLE_MS=600000` (ms; default 10 min)
- Stop now (advanced): `mem __daemon --shutdown`

## E2E performance (agent scenarios)

Run:

```bash
bash scripts/e2e-performance.sh
```

To measure end-to-end `mem search` latency (CLI + daemon overhead), run:

```bash
bash scripts/e2e-performance-v2.sh
```

To benchmark `mem reindex` time on large synthetic workspaces, run:

```bash
bash scripts/e2e-reindex-performance.sh
```

Latest recorded scores (v0.1.4, 2026-01-28, Qwen3-Embedding-0.6B-Q8_0.gguf):

Test device:
- MacBook Pro (Apple M1 Max, 32GB RAM)

| Metric | Value |
| --- | --- |
| Overall score | 0.917 |
| Avg query latency | 20ms |
| P95 query latency | 22ms |

| Dataset | Scenario | Docs | Queries | R@1 | R@5 | R@10 | MRR@10 | Score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stackoverflow | coding | 25 | 25 | 80.0% | 100.0% | 100.0% | 0.880 | 0.940 |
| askubuntu | automation_tasks | 25 | 25 | 96.0% | 100.0% | 100.0% | 0.973 | 0.987 |
| ux | design_tasks | 25 | 25 | 84.0% | 92.0% | 100.0% | 0.885 | 0.942 |
| money | finance_investment | 25 | 25 | 80.0% | 96.0% | 100.0% | 0.869 | 0.935 |
| pm | personal_work_management | 25 | 25 | 76.0% | 100.0% | 100.0% | 0.863 | 0.932 |
| meta.stackoverflow | community_management | 25 | 25 | 80.0% | 96.0% | 100.0% | 0.875 | 0.938 |
| movielens | user_preference | 200 | 30 | 33.3% | 83.3% | 100.0% | 0.554 | 0.777 |

Reindex benchmark (v0.1.4, 2026-01-29, synthetic docs; daemon off; mock embeddings):

| Docs | Approx bytes | Indexed chunks | `mem reindex` wall time |
| ---: | ---: | ---: | ---: |
| 1000 | 766112 | 1000 | 1.18s |
| 10000 | 7669077 | 10000 | 43.74s |

Notes:
- The benchmark is cached + size-limited to run locally; timings depend on hardware.
- `e2e-performance.sh` calls `dist/core/*` directly (no CLI spawn / daemon overhead). For end-to-end latency, use `e2e-performance-v2.sh`.
- See `docs/performance-datasets.md` and `docs/performance_records.md` for dataset definitions + history.

## Configuration

All configuration lives in one place:
- `~/.mem-cli/settings.json` (shared by all workspaces)

Settings are read on each `mem` command (daemon included), so runtime settings take effect immediately.

Some settings affect how the index is built (e.g. `chunking.*`, `embeddings.modelPath`) and require rebuilding the index **per workspace**:
- `mem reindex --public`
- `mem reindex --token ...` (repeat for each token workspace)
- `mem reindex --all` (rebuilds all workspaces on disk)

`mem reindex` is safe to run any time; it will no-op when the workspace index is already up to date.

If you don’t run `mem reindex`, the next `mem search` / `mem add` in that workspace will auto-detect the mismatch and rebuild (the first run may be slower).

`mem reindex --public` only rebuilds the public workspace; private token workspaces keep their existing index until you reindex (or use them and let auto-rebuild happen).

If you don’t have a private workspace token, you can’t run `mem ... --token` for that workspace (tokens can’t be recovered; create a new token workspace and move the Markdown files if needed).

Note: mem-cli records the embedding model in the index and won’t run “new model” queries against “old model” vectors — it will rebuild the workspace first.

## Use with an agent (Codex skill)

This repo includes a Codex skill at `skills/mem-cli/SKILL.md`. To install it:

```bash
mkdir -p ~/.codex/skills/mem-cli
cp skills/mem-cli/SKILL.md ~/.codex/skills/mem-cli/SKILL.md
```

Then the agent can use `mem` for:
- Writing memories: `mem add short|long`
- Retrieval before answering: `mem search`
