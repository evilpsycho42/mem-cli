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

## Enable semantic search (fully local)

`mem search` is always **hybrid** (keyword + vector). Vector search works when local embeddings are available.

1. Open `~/.mem-cli/settings.json` (created by `mem init`) and set an embedding model:

```json
{
  "embeddings": {
    "modelPath": "/absolute/path/to/your-embedding-model.gguf",
    "cacheDir": "~/.mem-cli/model-cache"
  }
}
```

2. Reindex the workspace you care about:

```bash
mem reindex --public
mem state --public --json | cat
```

Notes:
- `embeddings.cacheDir` is where remote models (e.g. `hf:...`) are downloaded/cached.
- If embeddings fail to load, mem-cli prints an error and falls back to keyword-only search.
- On macOS, if GPU/Metal causes issues: `export NODE_LLAMA_CPP_GPU=off`

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
