#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function readFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function decodeHtmlEntities(input) {
  if (!input) return "";

  const named = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'",
    "&nbsp;": " "
  };

  let s = String(input);
  s = s.replace(/&(amp|lt|gt|quot|nbsp);|&#39;/g, (m) => named[m] ?? m);
  s = s.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const code = Number.parseInt(hex, 16);
    if (!Number.isFinite(code)) return _;
    try {
      return String.fromCodePoint(code);
    } catch {
      return _;
    }
  });
  s = s.replace(/&#([0-9]+);/g, (_, dec) => {
    const code = Number.parseInt(dec, 10);
    if (!Number.isFinite(code)) return _;
    try {
      return String.fromCodePoint(code);
    } catch {
      return _;
    }
  });
  return s;
}

function htmlToText(html) {
  if (!html) return "";
  let s = String(html);

  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/p\s*>/gi, "\n\n");
  s = s.replace(/<p\s*>/gi, "");
  s = s.replace(/<li\s*>/gi, "- ");
  s = s.replace(/<\/li\s*>/gi, "\n");
  s = s.replace(/<\/(h[1-6]|pre|code|blockquote)\s*>/gi, "\n\n");
  s = s.replace(/<(h[1-6]|pre|code|blockquote)[^>]*>/gi, "");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeHtmlEntities(s);
  s = s.replace(/[ \t]+\n/g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function truncateText(text, maxChars) {
  if (!text) return "";
  const s = String(text).trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars).trim()}\n`;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": "mem-cli-e2e-performance"
    }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status} ${res.statusText} for ${url}\n${body.slice(0, 300)}`);
  }
  return res.json();
}

async function fetchStackExchangeTopAccepted({ site, maxItems, cacheFile }) {
  if (exists(cacheFile)) {
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
    if (
      cached?.version === 1 &&
      cached?.site === site &&
      Array.isArray(cached?.items) &&
      cached.items.length >= maxItems
    ) {
      return cached.items.slice(0, maxItems);
    }
  }

  const items = [];
  const seenQuestionIds = new Set();
  const pageSize = 100;

  // Keep fetching top-voted questions until we have enough with accepted answers + non-trivial bodies.
  for (let page = 1; page <= 10 && items.length < maxItems; page += 1) {
    const url =
      `https://api.stackexchange.com/2.3/questions` +
      `?order=desc&sort=votes&site=${encodeURIComponent(site)}` +
      `&pagesize=${pageSize}&page=${page}` +
      `&filter=default`;
    const data = await fetchJson(url);
    const q = Array.isArray(data?.items) ? data.items : [];
    for (const entry of q) {
      const qid = entry?.question_id;
      const aid = entry?.accepted_answer_id;
      const title = entry?.title;
      if (!qid || !aid || !title) continue;
      if (seenQuestionIds.has(qid)) continue;
      seenQuestionIds.add(qid);
      items.push({
        question_id: qid,
        accepted_answer_id: aid,
        title: String(title),
        link: entry?.link ? String(entry.link) : null
      });
      if (items.length >= maxItems) break;
    }

    const backoff = Number(data?.backoff);
    if (Number.isFinite(backoff) && backoff > 0) {
      await sleep(backoff * 1000);
    }
    const quotaRemaining = Number(data?.quota_remaining);
    if (Number.isFinite(quotaRemaining) && quotaRemaining <= 0) break;
  }

  const answerIds = items.map((it) => it.accepted_answer_id);
  const answerBodies = new Map();

  for (let i = 0; i < answerIds.length; i += 100) {
    const batch = answerIds.slice(i, i + 100);
    const url =
      `https://api.stackexchange.com/2.3/answers/${batch.join(";")}` +
      `?order=desc&sort=activity&site=${encodeURIComponent(site)}` +
      `&filter=withbody`;
    const data = await fetchJson(url);
    const answers = Array.isArray(data?.items) ? data.items : [];
    for (const ans of answers) {
      const id = ans?.answer_id;
      const body = ans?.body;
      if (!id || !body) continue;
      answerBodies.set(id, htmlToText(body));
    }

    const backoff = Number(data?.backoff);
    if (Number.isFinite(backoff) && backoff > 0) {
      await sleep(backoff * 1000);
    }
    const quotaRemaining = Number(data?.quota_remaining);
    if (Number.isFinite(quotaRemaining) && quotaRemaining <= 0) break;
  }

  const withBodies = items
    .map((it) => ({
      ...it,
      answer: truncateText(answerBodies.get(it.accepted_answer_id) || "", 1600)
    }))
    .filter((it) => it.answer && it.answer.length >= 200);

  const payload = {
    version: 1,
    site,
    fetchedAt: new Date().toISOString(),
    items: withBodies
  };
  writeFile(cacheFile, JSON.stringify(payload, null, 2) + "\n");

  return withBodies.slice(0, maxItems);
}

function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = t;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleInPlace(arr, rand) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function parseCsv(text) {
  const lines = String(text).split(/\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { header: [], rows: [] };
  const header = parseCsvLine(lines[0]).map((v) => v.replace(/\r$/, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i += 1) {
    rows.push(parseCsvLine(lines[i]).map((v) => v.replace(/\r$/, "")));
  }
  return { header, rows };
}

function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === "\"") {
        const next = line[i + 1];
        if (next === "\"") {
          cur += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === "\"") {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

async function ensureMovieLensExtracted({ cacheDir }) {
  const datasetDir = path.join(cacheDir, "datasets", "movielens");
  const zipPath = path.join(datasetDir, "ml-latest-small.zip");
  const extractedRoot = path.join(datasetDir, "ml-latest-small");
  const moviesCsv = path.join(extractedRoot, "movies.csv");
  const ratingsCsv = path.join(extractedRoot, "ratings.csv");

  fs.mkdirSync(datasetDir, { recursive: true });

  if (!exists(zipPath)) {
    const url = "https://files.grouplens.org/datasets/movielens/ml-latest-small.zip";
    const res = await fetch(url, { headers: { "user-agent": "mem-cli-e2e-performance" } });
    if (!res.ok) throw new Error(`failed to download MovieLens: HTTP ${res.status} ${res.statusText}`);
    const buf = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(zipPath, buf);
  }

  if (!exists(moviesCsv) || !exists(ratingsCsv)) {
    fs.mkdirSync(extractedRoot, { recursive: true });
    const unzip = spawnSync("unzip", ["-q", "-o", zipPath, "-d", datasetDir], { encoding: "utf8" });
    if (unzip.status !== 0) {
      throw new Error(`failed to unzip MovieLens (status=${unzip.status}): ${unzip.stderr || unzip.stdout}`);
    }
  }

  assert.ok(exists(moviesCsv), `missing ${moviesCsv}`);
  assert.ok(exists(ratingsCsv), `missing ${ratingsCsv}`);

  return { moviesCsv, ratingsCsv };
}

async function loadMovieLensPreferenceDataset({ cacheDir, maxDocs, maxQueries, seed }) {
  const { moviesCsv, ratingsCsv } = await ensureMovieLensExtracted({ cacheDir });
  const moviesRaw = fs.readFileSync(moviesCsv, "utf8");
  const ratingsRaw = fs.readFileSync(ratingsCsv, "utf8");

  const movies = parseCsv(moviesRaw);
  const ratings = parseCsv(ratingsRaw);

  const idxMovieId = movies.header.indexOf("movieId");
  const idxTitle = movies.header.indexOf("title");
  const idxGenres = movies.header.indexOf("genres");
  assert.ok(idxMovieId >= 0 && idxTitle >= 0 && idxGenres >= 0, "movies.csv header mismatch");

  const movieById = new Map();
  for (const row of movies.rows) {
    const id = row[idxMovieId];
    if (!id) continue;
    movieById.set(id, {
      title: row[idxTitle] || "",
      genres: row[idxGenres] || ""
    });
  }

  const idxUserId = ratings.header.indexOf("userId");
  const idxRatingMovieId = ratings.header.indexOf("movieId");
  const idxRating = ratings.header.indexOf("rating");
  const idxTs = ratings.header.indexOf("timestamp");
  assert.ok(idxUserId >= 0 && idxRatingMovieId >= 0 && idxRating >= 0 && idxTs >= 0, "ratings.csv header mismatch");

  const allRatings = ratings.rows
    .map((r) => ({
      userId: r[idxUserId],
      movieId: r[idxRatingMovieId],
      rating: Number(r[idxRating]),
      timestamp: r[idxTs]
    }))
    .filter((r) => r.userId && r.movieId && Number.isFinite(r.rating));

  const rand = mulberry32(seed);
  const userPoolSize = readInt("MEM_CLI_E2E_PERF_MOVIELENS_USER_POOL", 20);
  const minLikedForQuery = readInt("MEM_CLI_E2E_PERF_MOVIELENS_MIN_LIKED", 3);
  const minRelevantForQuery = readInt("MEM_CLI_E2E_PERF_MOVIELENS_MIN_RELEVANT", 2);

  const byUserAll = new Map();
  for (const r of allRatings) {
    if (!byUserAll.has(r.userId)) byUserAll.set(r.userId, []);
    byUserAll.get(r.userId).push(r);
  }

  const usersByVolume = Array.from(byUserAll.entries())
    .map(([userId, ratings]) => ({ userId, ratings }))
    .sort((a, b) => b.ratings.length - a.ratings.length);

  const userPool = usersByVolume.slice(0, Math.max(1, userPoolSize));
  shuffleInPlace(userPool, rand);

  for (const u of userPool) {
    shuffleInPlace(u.ratings, rand);
  }

  const cursors = new Map(userPool.map((u) => [u.userId, 0]));
  const picked = [];

  while (picked.length < maxDocs) {
    let progressed = false;
    for (const u of userPool) {
      if (picked.length >= maxDocs) break;
      const idx = cursors.get(u.userId) ?? 0;
      const row = u.ratings[idx];
      if (!row) continue;
      cursors.set(u.userId, idx + 1);
      picked.push(row);
      progressed = true;
    }
    if (!progressed) break;
  }

  const docs = picked.map((r) => {
    const movie = movieById.get(r.movieId) || { title: "", genres: "" };
    const title = movie.title || `movie ${r.movieId}`;
    const genres = movie.genres || "unknown";
    const sentiment =
      r.rating >= 4 ? "liked" : r.rating <= 2 ? "disliked" : "felt neutral about";
    const id = `u${r.userId}-m${r.movieId}`;
    return {
      id,
      fileName: `${id}.md`,
      userId: r.userId,
      movieId: r.movieId,
      rating: r.rating,
      genres,
      content:
        [
          `User ${r.userId} ${sentiment} \"${title}\".`,
          `Rating: ${r.rating}`,
          `Genres: ${genres}`,
          `Timestamp: ${r.timestamp}`
        ].join("\n") + "\n"
    };
  });

  // Build preference-style queries: "What <genre> movies does user X like?"
  const byUser = new Map();
  for (const d of docs) {
    if (!byUser.has(d.userId)) byUser.set(d.userId, []);
    byUser.get(d.userId).push(d);
  }

  const pairToRelevant = new Map();

  for (const [userId, userDocs] of byUser.entries()) {
    const liked = userDocs.filter((d) => d.rating >= 4);
    if (liked.length < minLikedForQuery) continue;
    for (const d of liked) {
      for (const g of String(d.genres || "").split("|")) {
        const genre = g.trim();
        if (!genre || genre === "(no genres listed)") continue;
        const key = `${userId}|${genre}`;
        if (!pairToRelevant.has(key)) pairToRelevant.set(key, new Set());
        pairToRelevant.get(key).add(d.fileName);
      }
    }
  }

  const candidates = Array.from(pairToRelevant.entries())
    .map(([key, files]) => {
      const [userId, genre] = key.split("|");
      return { userId, genre, relevantFileNames: Array.from(files) };
    })
    .filter((c) => c.relevantFileNames.length >= minRelevantForQuery);

  shuffleInPlace(candidates, rand);

  const queries = candidates.slice(0, maxQueries).map((c) => {
    const safeGenre = c.genre.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
    return {
      id: `user-${c.userId}-${safeGenre || "genre"}`,
      text: `What ${c.genre} movies does user ${c.userId} like?`,
      relevantFileNames: c.relevantFileNames
    };
  });

  return { docs, queries };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1))));
  return sorted[idx];
}

function computeRetrievalMetrics({ evaluated }) {
  const k1 = 1;
  const k5 = 5;
  const k10 = 10;

  let hit1 = 0;
  let hit5 = 0;
  let hit10 = 0;
  let mrr10 = 0;

  for (const e of evaluated) {
    const rank = e.firstRelevantRank;
    if (rank !== null && rank <= k1) hit1 += 1;
    if (rank !== null && rank <= k5) hit5 += 1;
    if (rank !== null && rank <= k10) hit10 += 1;
    if (rank !== null && rank <= k10) mrr10 += 1 / rank;
  }

  const n = evaluated.length || 1;
  const recall1 = hit1 / n;
  const recall5 = hit5 / n;
  const recall10 = hit10 / n;
  const mrrAt10 = mrr10 / n;
  const score = (recall10 + mrrAt10) / 2;

  return { recall1, recall5, recall10, mrrAt10, score };
}

function padRight(s, n) {
  const str = String(s);
  if (str.length >= n) return str;
  return str + " ".repeat(n - str.length);
}

function fmtPct(x) {
  return `${(x * 100).toFixed(1)}%`;
}

function fmtMs(x) {
  if (!Number.isFinite(x)) return "-";
  return `${Math.round(x)}ms`;
}

async function main() {
  const root = path.join(__dirname, "..");
  const cacheDir = process.env.MEM_CLI_E2E_PERF_CACHE_DIR || path.join(root, ".cache", "e2e-performance");
  const modelPath = process.env.MEM_CLI_MODEL || "";

  const stackN = readInt("MEM_CLI_E2E_PERF_STACK_N", 25);
  const stackCacheN = readInt("MEM_CLI_E2E_PERF_STACK_CACHE_N", Math.max(60, stackN));
  const movielensDocs = readInt("MEM_CLI_E2E_PERF_MOVIELENS_DOCS", 200);
  const movielensQueries = readInt("MEM_CLI_E2E_PERF_MOVIELENS_QUERIES", 30);
  const seed = readInt("MEM_CLI_E2E_PERF_SEED", 42);

  const limit = readInt("MEM_CLI_E2E_PERF_LIMIT", 10);
  const vectorWeight = readFloat("MEM_CLI_E2E_PERF_VECTOR_WEIGHT", 0.9);
  const textWeight = readFloat("MEM_CLI_E2E_PERF_TEXT_WEIGHT", 0.1);
  const candidateMultiplier = readFloat("MEM_CLI_E2E_PERF_CANDIDATE_MULTIPLIER", 2);

  const chunkTokens = readInt("MEM_CLI_E2E_PERF_CHUNK_TOKENS", 400);
  const chunkOverlap = readInt("MEM_CLI_E2E_PERF_CHUNK_OVERLAP", 80);
  const chunkMinChars = readInt("MEM_CLI_E2E_PERF_CHUNK_MIN_CHARS", 32);
  const chunkCharsPerToken = readInt("MEM_CLI_E2E_PERF_CHUNK_CHARS_PER_TOKEN", 4);

  assert.ok(modelPath.trim(), "MEM_CLI_MODEL is required (set MEM_CLI_MODEL or run via scripts/e2e-performance.sh)");

  const prevHome = process.env.HOME;
  const homeDir = mkdtemp("mem-cli-perf-home-");
  const tmpRoot = mkdtemp("mem-cli-perf-ws-");

  process.env.HOME = homeDir;

  try {
    const modelCacheDir = path.join(cacheDir, "model-cache");
    fs.mkdirSync(modelCacheDir, { recursive: true });
    writeFile(
      path.join(homeDir, ".mem-cli", "settings.json"),
      JSON.stringify(
        {
          version: 2,
          chunking: {
            tokens: chunkTokens,
            overlap: chunkOverlap,
            minChars: chunkMinChars,
            charsPerToken: chunkCharsPerToken
          },
          embeddings: {
            modelPath,
            cacheDir: modelCacheDir,
            batchMaxTokens: 8000,
            approxCharsPerToken: 1,
            cacheLookupBatchSize: 400,
            queryInstructionTemplate:
              "Instruct: Given a memory search query, retrieve relevant memory snippets that answer the query\nQuery: {query}"
          },
          search: {
            limit,
            vectorWeight,
            textWeight,
            candidateMultiplier,
            maxCandidates: 200,
            snippetMaxChars: 700
          },
          summary: { days: 7, maxChars: 8000, full: false },
          debug: { vector: false }
        },
        null,
        2
      ) + "\n"
    );

    // Lazy require so `scripts/e2e-performance.sh` can build first.
    const { ensureSettings } = require(path.join(root, "dist", "core", "settings.js"));
    const { getEmbeddingProvider, buildQueryInstruction } = require(path.join(root, "dist", "core", "embeddings.js"));
    const { openDb, reindexWorkspace } = require(path.join(root, "dist", "core", "index.js"));
    const { searchHybrid } = require(path.join(root, "dist", "core", "search.js"));

    const settings = ensureSettings();
    const provider = await getEmbeddingProvider(settings);

    const datasets = [
      { id: "stackoverflow", scenario: "coding", kind: "stackexchange", site: "stackoverflow" },
      { id: "askubuntu", scenario: "automation_tasks", kind: "stackexchange", site: "askubuntu" },
      { id: "ux", scenario: "design_tasks", kind: "stackexchange", site: "ux" },
      { id: "money", scenario: "finance_investment", kind: "stackexchange", site: "money" },
      { id: "pm", scenario: "personal_work_management", kind: "stackexchange", site: "pm" },
      { id: "meta_stackoverflow", scenario: "community_management", kind: "stackexchange", site: "meta.stackoverflow" },
      { id: "movielens", scenario: "user_preference", kind: "movielens" }
    ];

    const results = [];
    const allQueryTimes = [];
    const startedAll = Date.now();

    for (const ds of datasets) {
      const wsPath = path.join(tmpRoot, ds.id);
      const memoryDir = path.join(wsPath, "memory", `corpus-${ds.id}`);
      fs.mkdirSync(memoryDir, { recursive: true });

      let docs = [];
      let queries = [];

      if (ds.kind === "stackexchange") {
        const cacheFile = path.join(cacheDir, "datasets", "stackexchange", `${ds.site}.json`);
        const maxFetch = Math.max(stackCacheN, stackN);
        const items = await fetchStackExchangeTopAccepted({
          site: ds.site,
          maxItems: maxFetch,
          cacheFile
        });
        const picked = items.slice(0, stackN);

        docs = picked.map((it) => ({
          id: String(it.question_id),
          fileName: `${it.question_id}.md`,
          content: `${it.answer}\n`
        }));
        queries = picked.map((it) => ({
          id: String(it.question_id),
          text: it.title,
          relevantFileNames: [`${it.question_id}.md`]
        }));
      } else if (ds.kind === "movielens") {
        const loaded = await loadMovieLensPreferenceDataset({
          cacheDir,
          maxDocs: movielensDocs,
          maxQueries: movielensQueries,
          seed
        });
        docs = loaded.docs.map((d) => ({
          id: d.id,
          fileName: d.fileName,
          content: d.content
        }));
        queries = loaded.queries;
      } else {
        throw new Error(`unknown dataset kind: ${ds.kind}`);
      }

      for (const d of docs) {
        writeFile(path.join(memoryDir, d.fileName), d.content);
      }

      const db = openDb(wsPath);

      const indexStarted = Date.now();
      await reindexWorkspace(db, wsPath, { embeddingProvider: provider });
      const indexMs = Date.now() - indexStarted;

      const chunkCount = db.prepare("SELECT COUNT(*) as c FROM chunks").get().c;

      const evaluated = [];
      const queryTimes = [];
      for (const q of queries) {
        const qStarted = Date.now();
        const queryVec = await provider.embedQuery(
          buildQueryInstruction(q.text, settings.embeddings.queryInstructionTemplate)
        );
        const hits = await searchHybrid({
          db,
          query: q.text,
          queryVec,
          limit: settings.search.limit,
          vectorWeight: settings.search.vectorWeight,
          textWeight: settings.search.textWeight,
          candidateMultiplier: settings.search.candidateMultiplier,
          maxCandidates: settings.search.maxCandidates,
          snippetMaxChars: settings.search.snippetMaxChars,
          model: provider.modelPath
        });
        const qMs = Date.now() - qStarted;
        queryTimes.push(qMs);
        allQueryTimes.push(qMs);

        const relevant = new Set(q.relevantFileNames);
        let firstRank = null;
        for (let i = 0; i < hits.length; i += 1) {
          const fp = hits[i]?.file_path;
          const base = fp ? path.basename(String(fp)) : "";
          if (relevant.has(base)) {
            firstRank = i + 1;
            break;
          }
        }

        evaluated.push({
          id: q.id,
          firstRelevantRank: firstRank,
          timeMs: qMs
        });
      }

      const metrics = computeRetrievalMetrics({ evaluated });
      const avgQueryMs = queryTimes.reduce((a, b) => a + b, 0) / Math.max(1, queryTimes.length);
      const p95QueryMs = percentile(queryTimes, 0.95);

      db.close();

      results.push({
        id: ds.id,
        scenario: ds.scenario,
        docs: docs.length,
        queries: queries.length,
        chunks: chunkCount,
        indexMs,
        avgQueryMs,
        p95QueryMs,
        ...metrics
      });
    }

    const totalMs = Date.now() - startedAll;
    const totalQueries = results.reduce((sum, r) => sum + r.queries, 0);
    const overallScore = results.reduce((sum, r) => sum + r.score * r.queries, 0) / Math.max(1, totalQueries);
    const overallAvgQueryMs = allQueryTimes.reduce((sum, ms) => sum + ms, 0) / Math.max(1, allQueryTimes.length);
    const overallP95QueryMs = percentile(allQueryTimes, 0.95);

    console.log("");
    console.log("[mem-cli] e2e performance summary");
    console.log(`model: ${modelPath}`);
    console.log(`seed: ${seed}`);
    console.log(`cache: ${cacheDir}`);
    console.log("");

    const header =
      [
        padRight("dataset", 18),
        padRight("scenario", 24),
        padRight("docs", 6),
        padRight("queries", 8),
        padRight("index", 8),
        padRight("avgQ", 8),
        padRight("p95Q", 8),
        padRight("R@1", 7),
        padRight("R@5", 7),
        padRight("R@10", 7),
        padRight("MRR@10", 8),
        padRight("score", 7)
      ].join(" ");
    console.log(header);
    console.log("-".repeat(header.length));

    for (const r of results) {
      console.log(
        [
          padRight(r.id, 18),
          padRight(r.scenario, 24),
          padRight(String(r.docs), 6),
          padRight(String(r.queries), 8),
          padRight(fmtMs(r.indexMs), 8),
          padRight(fmtMs(r.avgQueryMs), 8),
          padRight(fmtMs(r.p95QueryMs), 8),
          padRight(fmtPct(r.recall1), 7),
          padRight(fmtPct(r.recall5), 7),
          padRight(fmtPct(r.recall10), 7),
          padRight(r.mrrAt10.toFixed(3), 8),
          padRight(r.score.toFixed(3), 7)
        ].join(" ")
      );
    }

    console.log("");
    console.log(
      `overall: score=${overallScore.toFixed(3)} avgQ=${Math.round(overallAvgQueryMs)}ms p95Q=${Math.round(overallP95QueryMs)}ms total=${Math.round(totalMs / 1000)}s`
    );

    const jsonOut = {
      version: 1,
      generatedAt: new Date().toISOString(),
      model: modelPath,
      seed,
      config: {
        stackN,
        stackCacheN,
        movielensDocs,
        movielensQueries,
        limit,
        vectorWeight,
        textWeight,
        candidateMultiplier,
        chunking: {
          tokens: chunkTokens,
          overlap: chunkOverlap,
          minChars: chunkMinChars,
          charsPerToken: chunkCharsPerToken
        }
      },
      overall: {
        score: overallScore,
        avgQueryMs: overallAvgQueryMs,
        p95QueryMs: overallP95QueryMs,
        totalMs,
        totalDatasets: results.length,
        totalQueries
      },
      datasets: results
    };

    const outPath = process.env.MEM_CLI_E2E_PERF_OUT_JSON || path.join(cacheDir, "last-run.json");
    writeFile(outPath, JSON.stringify(jsonOut, null, 2) + "\n");
    console.log(`json: ${outPath}`);
  } finally {
    // Cleanup: avoid `process.exit()` to keep native cleanup stable (node-llama-cpp/ggml-metal).
    fs.rmSync(homeDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exitCode = 1;
});
