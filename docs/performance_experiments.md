# Performance experiments

This document compares `scripts/e2e-performance.sh` results under different **search** and **chunking** settings.

## Environment

- Date: 2026-01-28
- Model: `Qwen3-Embedding-0.6B-Q8_0.gguf` (local via `node-llama-cpp`)
- Dataset snapshot: same cached sources as `docs/performance_records.md` (Stack Exchange + MovieLens)

All runs used:

```bash
MEM_CLI_E2E_PERF_STACK_N=25
MEM_CLI_E2E_PERF_STACK_CACHE_N=28
MEM_CLI_E2E_PERF_MOVIELENS_DOCS=200
MEM_CLI_E2E_PERF_MOVIELENS_QUERIES=30
MEM_CLI_E2E_PERF_SEED=42
MEM_CLI_E2E_PERF_LIMIT=10
```

## Experiments (overall)

Score definition: `score = (R@10 + MRR@10) / 2` averaged across all queries.

| Experiment | vectorWeight | textWeight | candidateMultiplier | chunkTokens | chunkOverlap | Overall score | Avg query | P95 query |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline | 0.7 | 0.3 | 4 | 400 | 80 | 0.915 | 21ms | 23ms |
| 100% semantic | 1.0 | 0.0 | 4 | 400 | 80 | 0.918 | 20ms | 23ms |
| 100% keyword | 0.0 | 1.0 | 4 | 400 | 80 | 0.915 | 20ms | 23ms |
| smaller chunks | 0.7 | 0.3 | 4 | 200 | 40 | 0.914 | 20ms | 23ms |
| larger chunks | 0.7 | 0.3 | 4 | 800 | 160 | 0.921 | 20ms | 23ms |
| fewer candidates | 0.7 | 0.3 | 2 | 400 | 80 | 0.915 | 20ms | 22ms |

## Experiments (dataset score)

| Dataset | baseline | 100% semantic | 100% keyword | smaller chunks | larger chunks | fewer candidates |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| stackoverflow | 0.940 | 0.940 | 0.940 | 0.951 | 0.957 | 0.940 |
| askubuntu | 0.987 | 0.987 | 0.987 | 0.987 | 0.987 | 0.987 |
| ux | 0.942 | 0.942 | 0.942 | 0.929 | 0.950 | 0.942 |
| money | 0.935 | 0.935 | 0.935 | 0.931 | 0.910 | 0.935 |
| pm | 0.917 | 0.933 | 0.917 | 0.924 | 0.938 | 0.917 |
| meta.stackoverflow | 0.938 | 0.938 | 0.938 | 0.931 | 0.959 | 0.938 |
| movielens | 0.777 | 0.777 | 0.777 | 0.777 | 0.777 | 0.777 |

## Notes / takeaways

- **100% semantic** slightly improved overall score vs baseline (mainly via `pm`).
- **Larger chunks** improved overall score the most, but reduced `money` score in this run.
- **Candidate multiplier** (`4 → 2`) did not change scores here; it slightly improved p95 latency.

