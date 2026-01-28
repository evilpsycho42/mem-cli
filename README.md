# mem-cli

A portable CLI-based memory tool for agents. Stores memory as Markdown plus a local SQLite index.

## Quickstart

```bash
mem init --public
mem init --token "my-token-123"

mem add short User prefers dark mode --public
cat <<'EOF' | mem add long --token "my-token-123" --stdin
## Preferences
- Likes concise answers
EOF

mem search dark mode --public
mem summary --token "my-token-123"
```

## Semantic search (local embeddings)

Hybrid search runs fully local using `node-llama-cpp` + `sqlite-vec`.
Configure the embedding model in `~/.mem-cli/settings.json` (created by `mem init`).

```bash
# Edit settings.json, e.g. ~/.mem-cli/settings.json:
# {
#   "embeddings": {
#     "modelPath": "/path/to/model.gguf",
#     "cacheDir": "~/.mem-cli/model-cache"
#   }
# }

# Optional: force CPU on macOS if Metal/GPU causes issues
export NODE_LLAMA_CPP_GPU=off

mem search "retirement savings" --public
mem search "rainy day money" --public
```
