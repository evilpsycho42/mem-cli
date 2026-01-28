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

## Semantic search (local embeddings)

`mem search` is always **hybrid** (keyword + semantic).

- Default embedding model: **Qwen3-Embedding-0.6B (GGUF)** (downloaded automatically via `hf:...`)
- Model cache dir: `~/.mem-cli/model-cache`
- If embeddings can’t load (e.g. `node-llama-cpp` missing), mem-cli falls back to keyword-only search.

macOS note:
- `node-llama-cpp` uses Metal by default on macOS (including integrated GPUs). If Metal causes issues, run with `export NODE_LLAMA_CPP_GPU=off`.

## E2E performance (agent scenarios)

Run:

```bash
bash scripts/e2e-performance.sh
```

Latest recorded scores (v0.1.3, 2026-01-28, Qwen3-Embedding-0.6B-Q8_0.gguf):

| Metric | Value |
| --- | --- |
| Overall score | 0.923 |
| Avg query latency | 20ms |
| P95 query latency | 22ms |

| Dataset | Scenario | Docs | Queries | R@1 | R@5 | R@10 | MRR@10 | Score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stackoverflow | coding | 25 | 25 | 84.0% | 100.0% | 100.0% | 0.913 | 0.957 |
| askubuntu | automation_tasks | 25 | 25 | 96.0% | 100.0% | 100.0% | 0.973 | 0.987 |
| ux | design_tasks | 25 | 25 | 84.0% | 100.0% | 100.0% | 0.900 | 0.950 |
| money | finance_investment | 25 | 25 | 80.0% | 92.0% | 96.0% | 0.859 | 0.910 |
| pm | personal_work_management | 25 | 25 | 84.0% | 100.0% | 100.0% | 0.907 | 0.953 |
| meta.stackoverflow | community_management | 25 | 25 | 88.0% | 100.0% | 100.0% | 0.918 | 0.959 |
| movielens | user_preference | 200 | 30 | 33.3% | 83.3% | 100.0% | 0.554 | 0.777 |

Notes:
- The benchmark is cached + size-limited to run locally; timings depend on hardware.
- See `docs/performance-datasets.md` and `docs/performance_records.md` for dataset definitions + history.

## Configuration

All configuration lives in one place:
- `~/.mem-cli/settings.json` (shared by all workspaces)

After changing settings, run `mem reindex --public` (or `--token ...`) to rebuild the index.

## Use with an agent (Codex skill)

This repo includes a Codex skill at `skills/mem-cli/SKILL.md`. To install it:

```bash
mkdir -p ~/.codex/skills/mem-cli
cp skills/mem-cli/SKILL.md ~/.codex/skills/mem-cli/SKILL.md
```

Then the agent can use `mem` for:
- Writing memories: `mem add short|long`
- Retrieval before answering: `mem search`
