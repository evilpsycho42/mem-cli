# mem-cli (Agent Notes)

## Before committing

- Run automated tests: `npm test`
- Run manual e2e quality/perf sanity (requires local embeddings model + `node-llama-cpp`):
  - `MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-video-retrieval.sh`
- Run e2e performance suite (requires local embeddings model + `node-llama-cpp`):
  - `MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-performance.sh`
  - Record the overall score + per-dataset scores; track score deltas across changes to validate performance improvements and catch regressions.

## Before publishing to npm

- Re-run: `npm test`
- Re-run: `MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-video-retrieval.sh`
- Re-run: `MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-performance.sh`
- Ensure `npm pack` looks sane (only `dist/`, `README.md`, `LICENSE` are shipped).
