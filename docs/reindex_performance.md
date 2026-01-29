# Reindex performance (synthetic)

This report measures `mem reindex` wall-clock time on synthetic workspaces with many small Markdown files.

## Environment

- Date: 2026-01-29
- Device: MacBook Pro (Apple M1 Max, 32GB RAM)
- Daemon: disabled (`MEM_CLI_DAEMON=0`)
- Embeddings: mock (`MEM_CLI_EMBEDDINGS_MOCK=1`, dims=8, loadMs=0)
- Generator: 96 words/doc, seed=42

## How to reproduce

```bash
bash scripts/e2e-reindex-performance.sh
```

## Results

| Docs | Approx bytes | Indexed chunks | `mem reindex` wall time |
| ---: | ---: | ---: | ---: |
| 1000 | 766112 | 1000 | 1.18s |
| 10000 | 7669077 | 10000 | 43.74s |

## Notes

- This measures the current implementation (which does per-file DB work); many small files can be significantly slower than fewer larger files with the same total bytes.
