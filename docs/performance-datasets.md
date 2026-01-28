# e2e-performance datasets

`scripts/e2e-performance.sh` runs a small, repeatable retrieval benchmark intended to represent “daily agent” memory usage across common domains:

- coding
- automation tasks
- design tasks
- finance / investment
- personal work management
- user preference
- community management

## Dataset sources (trusted + popular)

### Stack Exchange (Q&A → “FAQ retrieval”)

For most domains we use **Stack Exchange** because it’s:

- widely-used and high-signal Q&A content
- directly relevant to “agent searches my memory for the right answer”
- accessible via the official Stack Exchange API

We build a small retrieval task by:

1) downloading *top-voted questions with an accepted answer* (per site),
2) indexing the accepted answer as a memory document,
3) using the question title as the query, and
4) scoring whether the accepted answer is retrieved in top-k.

Sites used:

- `stackoverflow` → coding
- `askubuntu` → automation tasks
- `ux` → design tasks
- `money` → finance/investment
- `pm` (Project Management) → personal work management
- `meta.stackoverflow` → community management

### MovieLens (ratings → “user preference retrieval”)

For user preference, we use **MovieLens (ml-latest-small)**:

- widely-used preference dataset (GroupLens)
- good proxy for “user likes/dislikes” memories

We index a sampled subset of user/movie ratings as documents, then generate queries like:

- “What *{genre}* movies does user *{id}* like?”

Relevant docs are that user’s high-rated movies in that genre.

## Keeping it fast

Defaults are intentionally small so the suite is runnable locally with `node-llama-cpp`:

- Stack Exchange: `MEM_CLI_E2E_PERF_STACK_N=25` per site
- MovieLens: `MEM_CLI_E2E_PERF_MOVIELENS_DOCS=200`, `MEM_CLI_E2E_PERF_MOVIELENS_QUERIES=30`

All datasets are cached under `.cache/e2e-performance/` by default.
