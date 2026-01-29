# Performance records

This file tracks `scripts/e2e-performance.sh` (in-process) results across versions.

It also includes `scripts/e2e-performance-v2.sh` (daemon end-to-end) records so we can track real `mem search` latency including CLI spawn + daemon IPC overhead.

Why this exists:
- The benchmark uses *real* datasets (Stack Exchange + MovieLens). Upstream content can change over time.
- The runner caches downloaded datasets under `.cache/e2e-performance/`. Clearing the cache (or changing dataset code) can change results.
- To avoid confusion, each record includes the benchmark “dataset snapshot” metadata used at the time.

---

## v0.1.4 (2026-01-29) — daemon end-to-end (v2)

**Command**

```bash
MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-performance-v2.sh
```

**Defaults under test**
- Default embedding model: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`
- Search: `vectorWeight=0.9`, `textWeight=0.1`, `candidateMultiplier=2`, `limit=10`
- Chunking: `tokens=400`, `overlap=80`, `minChars=32`, `charsPerToken=4`
- Seed: `42`

**Dataset snapshot metadata**

Stack Exchange caches (top-voted questions with accepted answers; docs = accepted answers; queries = question titles):
- `stackoverflow` fetchedAt `2026-01-29T06:32:12.665Z` (cache items=30)
- `askubuntu` fetchedAt `2026-01-29T06:32:19.627Z` (cache items=30)
- `ux` fetchedAt `2026-01-29T06:32:23.931Z` (cache items=30)
- `money` fetchedAt `2026-01-29T06:32:28.529Z` (cache items=30)
- `pm` fetchedAt `2026-01-29T06:32:33.406Z` (cache items=30)
- `meta.stackoverflow` fetchedAt `2026-01-29T06:32:38.428Z` (cache items=28)

MovieLens:
- Source: `https://files.grouplens.org/datasets/movielens/ml-latest-small.zip`
- Cached zip SHA-256: `696d65a3dfceac7c45750ad32df2c259311949efec81f0f144fdfb91ebc9e436`

**Results**

Overall:
- score: `0.917`
- avg query: `70ms`
- p95 query: `78ms`

## v0.1.4 (2026-01-28)

**Command**

```bash
MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-performance.sh
```

**Defaults under test**
- Default embedding model: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`
- Search: `vectorWeight=0.9`, `textWeight=0.1`, `candidateMultiplier=2`, `limit=10`
- Chunking: `tokens=400`, `overlap=80`, `minChars=32`, `charsPerToken=4`
- Seed: `42`

**Dataset snapshot metadata**

Stack Exchange caches (top-voted questions with accepted answers; docs = accepted answers; queries = question titles):
- `stackoverflow` fetchedAt `2026-01-28T16:41:02.215Z` (cache items=30)
- `askubuntu` fetchedAt `2026-01-28T16:41:07.063Z` (cache items=30)
- `ux` fetchedAt `2026-01-28T16:41:10.136Z` (cache items=30)
- `money` fetchedAt `2026-01-28T16:41:13.629Z` (cache items=30)
- `pm` fetchedAt `2026-01-28T16:41:17.351Z` (cache items=30)
- `meta.stackoverflow` fetchedAt `2026-01-28T16:41:21.511Z` (cache items=28)

MovieLens:
- Source: `https://files.grouplens.org/datasets/movielens/ml-latest-small.zip`
- Cached zip SHA-256: `696d65a3dfceac7c45750ad32df2c259311949efec81f0f144fdfb91ebc9e436`

**Results**

Overall:
- score: `0.917`
- avg query: `20ms`
- p95 query: `22ms`

Per-dataset:

| Dataset | Scenario | Docs | Queries | R@1 | R@5 | R@10 | MRR@10 | Score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stackoverflow | coding | 25 | 25 | 80.0% | 100.0% | 100.0% | 0.880 | 0.940 |
| askubuntu | automation_tasks | 25 | 25 | 96.0% | 100.0% | 100.0% | 0.973 | 0.987 |
| ux | design_tasks | 25 | 25 | 84.0% | 92.0% | 100.0% | 0.885 | 0.942 |
| money | finance_investment | 25 | 25 | 80.0% | 96.0% | 100.0% | 0.869 | 0.935 |
| pm | personal_work_management | 25 | 25 | 76.0% | 100.0% | 100.0% | 0.863 | 0.932 |
| meta.stackoverflow | community_management | 25 | 25 | 80.0% | 96.0% | 100.0% | 0.875 | 0.938 |
| movielens | user_preference | 200 | 30 | 33.3% | 83.3% | 100.0% | 0.554 | 0.777 |

## v0.1.3 (2026-01-28)

**Command**

```bash
MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-performance.sh
```

**Defaults under test**
- Default embedding model: `hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf`
- Search: `vectorWeight=0.9`, `textWeight=0.1`, `candidateMultiplier=2`, `limit=10`
- Chunking: `tokens=800`, `overlap=160`, `minChars=32`, `charsPerToken=4`
- Seed: `42`

**Dataset snapshot metadata**

Stack Exchange caches (top-voted questions with accepted answers; docs = accepted answers; queries = question titles):
- `stackoverflow` fetchedAt `2026-01-28T16:41:02.215Z` (cache items=30)
- `askubuntu` fetchedAt `2026-01-28T16:41:07.063Z` (cache items=30)
- `ux` fetchedAt `2026-01-28T16:41:10.136Z` (cache items=30)
- `money` fetchedAt `2026-01-28T16:41:13.629Z` (cache items=30)
- `pm` fetchedAt `2026-01-28T16:41:17.351Z` (cache items=30)
- `meta.stackoverflow` fetchedAt `2026-01-28T16:41:21.511Z` (cache items=28)

MovieLens:
- Source: `https://files.grouplens.org/datasets/movielens/ml-latest-small.zip`
- Cached zip SHA-256: `696d65a3dfceac7c45750ad32df2c259311949efec81f0f144fdfb91ebc9e436`

**Results**

Overall:
- score: `0.923`
- avg query: `20ms`
- p95 query: `22ms`

Per-dataset:

| Dataset | Scenario | Docs | Queries | R@1 | R@5 | R@10 | MRR@10 | Score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stackoverflow | coding | 25 | 25 | 84.0% | 100.0% | 100.0% | 0.913 | 0.957 |
| askubuntu | automation_tasks | 25 | 25 | 96.0% | 100.0% | 100.0% | 0.973 | 0.987 |
| ux | design_tasks | 25 | 25 | 84.0% | 100.0% | 100.0% | 0.900 | 0.950 |
| money | finance_investment | 25 | 25 | 80.0% | 92.0% | 96.0% | 0.859 | 0.910 |
| pm | personal_work_management | 25 | 25 | 84.0% | 100.0% | 100.0% | 0.907 | 0.953 |
| meta.stackoverflow | community_management | 25 | 25 | 88.0% | 100.0% | 100.0% | 0.918 | 0.959 |
| movielens | user_preference | 200 | 30 | 33.3% | 83.3% | 100.0% | 0.554 | 0.777 |

## v0.1.2 (2026-01-28)

**Command**

```bash
MEM_CLI_MODEL=/Users/kky/Dev/mem-cli/models/Qwen3-Embedding-0.6B-Q8_0.gguf bash scripts/e2e-performance.sh
```

**Model**
- `Qwen3-Embedding-0.6B-Q8_0.gguf` (via `node-llama-cpp`)

**Benchmark config (defaults)**
- Stack Exchange: `MEM_CLI_E2E_PERF_STACK_N=25` (per site)
- MovieLens: `MEM_CLI_E2E_PERF_MOVIELENS_DOCS=200`, `MEM_CLI_E2E_PERF_MOVIELENS_QUERIES=30`
- MovieLens query generation: `MEM_CLI_E2E_PERF_MOVIELENS_USER_POOL=20`, `MEM_CLI_E2E_PERF_MOVIELENS_MIN_LIKED=3`, `MEM_CLI_E2E_PERF_MOVIELENS_MIN_RELEVANT=2`
- Seed: `MEM_CLI_E2E_PERF_SEED=42`
- Search params: `limit=10`, `vectorWeight=0.7`, `textWeight=0.3`, `candidateMultiplier=4`
- Chunking: `tokens=400`, `overlap=80`

**Dataset snapshot metadata**

Stack Exchange caches (top-voted questions with accepted answers; docs = accepted answers; queries = question titles):
- `stackoverflow` fetchedAt `2026-01-28T16:41:02.215Z` (cache items=30)
- `askubuntu` fetchedAt `2026-01-28T16:41:07.063Z` (cache items=30)
- `ux` fetchedAt `2026-01-28T16:41:10.136Z` (cache items=30)
- `money` fetchedAt `2026-01-28T16:41:13.629Z` (cache items=30)
- `pm` fetchedAt `2026-01-28T16:41:17.351Z` (cache items=30)
- `meta.stackoverflow` fetchedAt `2026-01-28T16:41:21.511Z` (cache items=28)

MovieLens:
- Source: `https://files.grouplens.org/datasets/movielens/ml-latest-small.zip`
- Cached zip SHA-256: `696d65a3dfceac7c45750ad32df2c259311949efec81f0f144fdfb91ebc9e436`

**Results**

Overall:
- score: `0.915`
- avg query: `20ms`
- p95 query: `25ms`

Per-dataset:

| Dataset | Scenario | Docs | Queries | R@1 | R@5 | R@10 | MRR@10 | Score |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| stackoverflow | coding | 25 | 25 | 80.0% | 100.0% | 100.0% | 0.880 | 0.940 |
| askubuntu | automation_tasks | 25 | 25 | 96.0% | 100.0% | 100.0% | 0.973 | 0.987 |
| ux | design_tasks | 25 | 25 | 84.0% | 92.0% | 100.0% | 0.885 | 0.942 |
| money | finance_investment | 25 | 25 | 80.0% | 96.0% | 100.0% | 0.869 | 0.935 |
| pm | personal_work_management | 25 | 25 | 72.0% | 100.0% | 100.0% | 0.833 | 0.917 |
| meta.stackoverflow | community_management | 25 | 25 | 80.0% | 96.0% | 100.0% | 0.875 | 0.938 |
| movielens | user_preference | 200 | 30 | 33.3% | 83.3% | 100.0% | 0.554 | 0.777 |
