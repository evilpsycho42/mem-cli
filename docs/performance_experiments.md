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
| v0.1.2 defaults | 0.7 | 0.3 | 4 | 400 | 80 | 0.915 | 21ms | 23ms |
| larger chunks (old weights) | 0.7 | 0.3 | 2 | 800 | 160 | 0.921 | 20ms | 22ms |
| 100% semantic (best score) | 1.0 | 0.0 | 2 | 800 | 160 | 0.924 | 20ms | 23ms |
| v0.1.3 defaults (chosen) | 0.9 | 0.1 | 2 | 800 | 160 | 0.923 | 20ms | 22ms |

## Dataset score (key comparisons)

| Dataset | v0.1.2 defaults | v0.1.3 defaults | 100% semantic |
| --- | ---: | ---: | ---: |
| stackoverflow | 0.940 | 0.957 | 0.957 |
| askubuntu | 0.987 | 0.987 | 0.987 |
| ux | 0.942 | 0.950 | 0.950 |
| money | 0.935 | 0.910 | 0.910 |
| pm | 0.917 | 0.953 | 0.957 |
| meta.stackoverflow | 0.938 | 0.959 | 0.959 |
| movielens | 0.777 | 0.777 | 0.777 |

## Notes / takeaways

- Larger chunks (`800/160`) improved overall score and reduced indexing overhead vs many small chunks, but reduced the `money` dataset score in this run.
- 100% semantic edged out the best overall score, but we keep a small keyword weight (`0.9/0.1`) as a guardrail for exact-string searches (ids, codes, filenames).
- Candidate multiplier (`4 → 2`) did not change scores here; it slightly improved latency.
