# Performance experiments

This document compares `scripts/e2e-performance.sh` results under different **search** and **chunking** settings.

Note: `e2e-performance.sh` runs in-process (no CLI spawn / daemon overhead). To measure end-to-end `mem search` latency, use `scripts/e2e-performance-v2.sh` (expect higher avgQ/p95Q due to process + IPC overhead).

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
| v0.1.3 defaults (released) | 0.9 | 0.1 | 2 | 800 | 160 | 0.923 | 20ms | 22ms |
| v0.1.4 defaults (chosen) | 0.9 | 0.1 | 2 | 400 | 80 | 0.917 | 20ms | 22ms |

## Dataset score (key comparisons)

| Dataset | v0.1.2 defaults | v0.1.3 defaults | v0.1.4 defaults |
| --- | ---: | ---: | ---: |
| stackoverflow | 0.940 | 0.957 | 0.940 |
| askubuntu | 0.987 | 0.987 | 0.987 |
| ux | 0.942 | 0.950 | 0.942 |
| money | 0.935 | 0.910 | 0.935 |
| pm | 0.917 | 0.953 | 0.932 |
| meta.stackoverflow | 0.938 | 0.959 | 0.938 |
| movielens | 0.777 | 0.777 | 0.777 |

## Notes / takeaways

- Larger chunks (`800/160`) improved overall score and reduced indexing overhead vs many small chunks, but it also increased “mixed topic” chunks (more irrelevant context) and reduced the `money` dataset score in this run.
- For agent workflows, we prioritize **less irrelevant context + less prompt bloat** over a small score gain, so `v0.1.4` switches back to `chunkTokens=400` (with overlap `80`).
- We keep a small keyword weight (`0.9/0.1`) as a guardrail for exact-string searches (ids, codes, filenames).
- Candidate multiplier (`4 → 2`) did not change scores here; it slightly improved latency.

## Chunk size guidance (web)

There is no single “correct” chunk size, but common guidance converges on:

- **Start ~200–400 tokens** and adjust based on your data + query patterns.
  - Example: DataCamp notes 200–400 tokens as a common default range in popular tooling. (https://www.datacamp.com/tutorial/chunking-strategies-for-rag)
- **Use overlap ~10–25%** of the chunk size to preserve boundary context.
  - Example: Weaviate suggests overlap in the 10–20% range as a rule of thumb. (https://weaviate.io/blog/chunking-strategies-for-rag)
  - Example: Microsoft suggests starting at 512 tokens with ~25% overlap, then tuning. (https://learn.microsoft.com/en-us/azure/search/vector-search-how-to-chunk-documents)
- **Bigger chunks can improve recall but increase irrelevant context** (and can bloat agent prompts); smaller chunks can improve precision but increase chunk count + indexing work.
  - Example: LlamaIndex discusses this tradeoff (its defaults are larger than ours because it’s a general-purpose RAG framework). (https://docs.llamaindex.ai/en/stable/optimizing/basic_strategies/basic_strategies/)

Given our agent workflow constraints (low irrelevant context + limited prompt budget), we keep defaults at `chunkTokens=400` and `chunkOverlap=80` (20%), and rely on the perf suite to validate any future changes.

## Public benchmarks vs our score

Our `scripts/e2e-performance.sh` “score” is **not comparable** to public embedding leaderboards:

- Our score is `((R@10 + MRR@10) / 2)` on a small, size-limited **agent scenario** benchmark (Stack Exchange + MovieLens).
- Public embedding benchmarks (e.g. **MTEB**) report scores across many datasets and task types on a **different scale**.

If you want a public reference point for the *embedding model itself* (not mem-cli’s chunking/search/indexing pipeline), see:

- Qwen3 embedding blog: https://qwenlm.github.io/blog/qwen3-embedding/
- Hugging Face model card for Qwen3-Embedding-0.6B (includes MTEB tables): https://huggingface.co/Qwen/Qwen3-Embedding-0.6B

We treat MTEB as a “model quality” signal, and treat `e2e-performance` as a **regression/perf harness** for mem-cli defaults.
