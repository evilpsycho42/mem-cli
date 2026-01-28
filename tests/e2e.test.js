const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

async function withTempHome(fn) {
  const prevHome = process.env.HOME;
  const homeDir = mkdtemp("mem-cli-home-");
  process.env.HOME = homeDir;
  try {
    return await fn(homeDir);
  } finally {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    fs.rmSync(homeDir, { recursive: true, force: true });
  }
}

function writeSettings(homeDir, overrides = {}) {
  const base = {
    version: 2,
    chunking: { tokens: 400, overlap: 80, minChars: 32, charsPerToken: 4 },
    embeddings: {
      modelPath: "/fake/test-model.gguf",
      cacheDir: "",
      batchMaxTokens: 8000,
      approxCharsPerToken: 1,
      cacheLookupBatchSize: 400,
      queryInstructionTemplate:
        "Instruct: Given a memory search query, retrieve relevant memory snippets that answer the query\nQuery: {query}"
    },
    search: {
      limit: 10,
      vectorWeight: 0.7,
      textWeight: 0.3,
      candidateMultiplier: 4,
      maxCandidates: 200,
      snippetMaxChars: 700
    },
    summary: { days: 7, maxChars: 8000, full: false },
    debug: { vector: false }
  };

  if (overrides.chunking) base.chunking = { ...base.chunking, ...overrides.chunking };
  if (overrides.embeddings) base.embeddings = { ...base.embeddings, ...overrides.embeddings };
  if (overrides.search) base.search = { ...base.search, ...overrides.search };
  if (overrides.summary) base.summary = { ...base.summary, ...overrides.summary };
  if (overrides.debug) base.debug = { ...base.debug, ...overrides.debug };

  writeFile(path.join(homeDir, ".mem-cli", "settings.json"), JSON.stringify(base, null, 2) + "\n");
}

function runCli({ homeDir, args }) {
  const cliPath = path.join(__dirname, "..", "dist", "index.js");
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: homeDir },
    encoding: "utf8"
  });
  return res;
}

function openDb(workspacePath) {
  // Require lazily so `npm run build` can overwrite dist between runs.
  // eslint-disable-next-line global-require
  return require("../dist/core/index.js").openDb(workspacePath);
}

function reindexWorkspace(db, workspacePath, options) {
  // eslint-disable-next-line global-require
  return require("../dist/core/index.js").reindexWorkspace(db, workspacePath, options);
}

function ensureIndexUpToDate(db, workspacePath, options) {
  // eslint-disable-next-line global-require
  return require("../dist/core/index.js").ensureIndexUpToDate(db, workspacePath, options);
}

function searchText(db, query, limit, model, snippetMaxChars = 700) {
  // eslint-disable-next-line global-require
  return require("../dist/core/search.js").searchText(db, query, limit, model, snippetMaxChars);
}

function searchVector(db, queryVec, limit, model, snippetMaxChars = 700) {
  // eslint-disable-next-line global-require
  return require("../dist/core/search.js").searchVector(db, queryVec, limit, model, snippetMaxChars);
}

function buildQueryInstruction(query) {
  // eslint-disable-next-line global-require
  return require("../dist/core/embeddings.js").buildQueryInstruction(query);
}

function searchHybrid(params) {
  // eslint-disable-next-line global-require
  return require("../dist/core/search.js").searchHybrid(params);
}

function readJson(res) {
  const raw = (res.stdout || "").trim();
  assert.ok(raw, `expected JSON output, got empty stdout (stderr=${res.stderr})`);
  return JSON.parse(raw);
}

test("workspace migration: legacy daily/ is moved to memory/", () => {
  const homeDir = mkdtemp("mem-cli-home-");
  const workspaceRoot = mkdtemp("mem-cli-workspace-");
  const token = "test-token-123";

  const initRes = runCli({
    homeDir,
    args: ["init", "--token", token, "--path", workspaceRoot, "--json"]
  });
  assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);

  const workspacePath = path.join(workspaceRoot, ".mem-cli");
  const memoryDir = path.join(workspacePath, "memory");
  const legacyDailyDir = path.join(workspacePath, "daily");
  assert.ok(fs.existsSync(memoryDir), "expected init to create memory/ dir");

  // Simulate pre-migration layout by renaming memory/ → daily/ (if it exists).
  fs.renameSync(memoryDir, legacyDailyDir);
  assert.ok(!fs.existsSync(memoryDir));
  assert.ok(fs.existsSync(legacyDailyDir));

  const stateRes = runCli({ homeDir, args: ["state", "--token", token, "--json"] });
  assert.equal(stateRes.status, 0, stateRes.stderr || stateRes.stdout);
  assert.ok(fs.existsSync(memoryDir), "expected migration to recreate memory/ dir");
  assert.ok(!fs.existsSync(legacyDailyDir), "expected migration to remove daily/ dir");
});

test("cli: add short/long writes raw Markdown (no injected headers) and keyword search works without embeddings", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/missing-model.gguf", cacheDir: "" } });

    const initRes = runCli({ homeDir, args: ["init", "--public", "--json"] });
    assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);
    const init = readJson(initRes);
    const workspacePath = init.workspace;
    assert.ok(workspacePath);

    const addShortRes = runCli({ homeDir, args: ["add", "short", "hello world", "--public"] });
    assert.equal(addShortRes.status, 0, addShortRes.stderr || addShortRes.stdout);

    const memoryDir = path.join(workspacePath, "memory");
    const dailyFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    assert.equal(dailyFiles.length, 1, "expected exactly one daily memory file");
    const dailyPath = path.join(memoryDir, dailyFiles[0]);
    const dailyContent = fs.readFileSync(dailyPath, "utf8");
    assert.equal(dailyContent.trim(), "hello world");
    assert.ok(!dailyContent.includes("## "), "expected no injected timestamp headings");
    assert.ok(!dailyContent.match(/^#\s/m), "expected no injected date headings");

    const addLongRes = runCli({ homeDir, args: ["add", "long", "alpha", "--public"] });
    assert.equal(addLongRes.status, 0, addLongRes.stderr || addLongRes.stdout);
    const addLong2Res = runCli({ homeDir, args: ["add", "long", "beta", "--public"] });
    assert.equal(addLong2Res.status, 0, addLong2Res.stderr || addLong2Res.stdout);

    const longPath = path.join(workspacePath, "MEMORY.md");
    const longContent = fs.readFileSync(longPath, "utf8");
    assert.equal(longContent, "alpha\n\nbeta\n");

    const searchRes = runCli({ homeDir, args: ["search", "hello", "--public", "--json"] });
    assert.equal(searchRes.status, 0, searchRes.stderr || searchRes.stdout);
    const out = readJson(searchRes);
    assert.ok(Array.isArray(out.results));
    assert.ok(out.results.length > 0, "expected at least one search hit");
    assert.ok(
      out.results.some((r) => String(r.file_path || "").startsWith("memory/")),
      "expected hit from daily memory file"
    );
  });
});

test("cli: CJK query returns no results when embeddings are unavailable (no FTS tokens)", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/missing-model.gguf", cacheDir: "" } });

    const initRes = runCli({ homeDir, args: ["init", "--public", "--json"] });
    assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);

    const addRes = runCli({
      homeDir,
      args: ["add", "short", "系统可以根据网络情况动态调整视频码率。", "--public"]
    });
    assert.equal(addRes.status, 0, addRes.stderr || addRes.stdout);

    const searchRes = runCli({
      homeDir,
      args: ["search", "这个系统是如何保证视频直播低延迟和播放质量的？", "--public", "--json"]
    });
    assert.equal(searchRes.status, 0, searchRes.stderr || searchRes.stdout);
    const out = readJson(searchRes);
    assert.ok(Array.isArray(out.results));
    assert.equal(out.results.length, 0, "expected no results without embeddings for CJK-only query");
  });
});

test("indexing only considers MEMORY.md + memory/**/*.md (not other .md files)", async () => {
  await withTempHome(async () => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeFile(path.join(workspacePath, "MEMORY.md"), "alpha\n");
    writeFile(path.join(workspacePath, "memory", "2026-01-01.md"), "# 2026-01-01\n\nkiwi\n");
    writeFile(path.join(workspacePath, "notes.md"), "SHOULD_NOT_BE_INDEXED secret-phrase\n");

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: null });

    const hits = searchText(db, "secret-phrase", 10);
    assert.equal(hits.length, 0, "notes.md should not be indexed");

    const alphaHits = searchText(db, "alpha", 10);
    assert.ok(alphaHits.length > 0, "expected keyword hit from MEMORY.md");
    assert.ok(alphaHits.some((h) => h.file_path === "MEMORY.md"));
    assert.ok(
      alphaHits.every((h) => h.file_path !== "memory.md"),
      "legacy memory.md should not be indexed"
    );

    const kiwiHits = searchText(db, "kiwi", 10);
    assert.ok(kiwiHits.length > 0, "expected keyword hit from memory/");
    assert.ok(
      kiwiHits.some((h) => h.file_path === "memory/2026-01-01.md"),
      "expected match from memory/2026-01-01.md"
    );

    db.close();
  });
});

test("chunking: overlap keeps tail context across chunks", async () => {
  await withTempHome(async (homeDir) => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeSettings(homeDir, { chunking: { tokens: 10, overlap: 5 } });
    const rel = "memory/2026-01-02.md";
    const abs = path.join(workspacePath, rel);
    writeFile(
      abs,
      [
        "# 2026-01-02",
        "",
        "line-1: apple",
        "line-2: banana",
        "line-3: cherry",
        "line-4: date",
        "line-5: elderberry",
        "line-6: fig",
        "line-7: grape",
        "line-8: honeydew"
      ].join("\n")
    );

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: null });

    const rows = db
      .prepare("SELECT content FROM chunks WHERE file_path = ? ORDER BY line_start, line_end, id")
      .all(rel);
    assert.ok(rows.length > 1, "expected multiple chunks");

    const first = rows[0].content;
    const second = rows[1].content;
    const lastLine = first.trim().split("\n").slice(-1)[0];
    assert.ok(lastLine, "expected last line to be non-empty");
    assert.ok(second.includes(lastLine), `expected overlap: second chunk should include \"${lastLine}\"`);

    db.close();
  });
});

test("chunking: splits overly long lines into max-sized segments", async () => {
  await withTempHome(async (homeDir) => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeSettings(homeDir, { chunking: { tokens: 5, overlap: 0 } });
    const rel = "memory/2026-01-03.md";
    const abs = path.join(workspacePath, rel);
    writeFile(abs, "a".repeat(65));

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: null });

    const maxChars = Math.max(32, 5 * 4);
    const rows = db
      .prepare("SELECT content FROM chunks WHERE file_path = ? ORDER BY line_start, line_end, id")
      .all(rel);
    assert.ok(rows.length > 1, "expected multiple chunks from long line");
    for (const row of rows) {
      assert.ok(
        row.content.length <= maxChars,
        `expected chunk length <= ${maxChars}, got ${row.content.length}`
      );
    }

    db.close();
  });
});

test("reindex: changing chunking.tokens does not break vec0 table rebuild", async () => {
  await withTempHome(async (homeDir) => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    const rel = "memory/2026-01-28.md";
    writeFile(
      path.join(workspacePath, rel),
      ["# 2026-01-28", "", "## 09:00", "hello world"].join("\n")
    );

    const provider = {
      modelPath: "/fake/reindex-model.gguf",
      embedQuery: async () => [1, 0, 0],
      embedBatch: async (texts) => texts.map(() => [1, 0, 0])
    };

    writeSettings(homeDir, { chunking: { tokens: 400, overlap: 80 } });
    let db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });
    db.close();

    // Simulate a new CLI invocation after changing chunking settings.
    writeSettings(homeDir, { chunking: { tokens: 300, overlap: 80 } });
    db = openDb(workspacePath);
    await ensureIndexUpToDate(db, workspacePath, { embeddingProvider: provider });

    const queryVec = await provider.embedQuery(buildQueryInstruction("hello"));
    const results = await searchVector(db, queryVec, 5, provider.modelPath);
    assert.ok(results.length > 0, "expected vector results after reindex");
    assert.equal(results[0].file_path, rel);
    db.close();
  });
});

test("chunking: does not split at headings (Moltbot-style size chunking)", async () => {
  await withTempHome(async () => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    const rel = "memory/2026-01-28.md";
    writeFile(
      path.join(workspacePath, rel),
      [
        "## 09:00",
        "secret code: QQQ",
        "",
        "## 09:05",
        "Discussed equity allocation and low-cost index funds."
      ].join("\n")
    );

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: null });

    const rows = db.prepare("SELECT content FROM chunks WHERE file_path = ?").all(rel);
    assert.equal(rows.length, 1, "expected headings to be part of the same chunk when under maxChars");
    assert.ok(String(rows[0].content).includes("secret code: QQQ"));
    assert.ok(String(rows[0].content).toLowerCase().includes("equity"));

    db.close();
  });
});

test("embeddings: embedding_cache avoids recomputing unchanged chunk embeddings", async () => {
  await withTempHome(async (homeDir) => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeSettings(homeDir, { chunking: { tokens: 20, overlap: 0 } });
    const rel = "memory/2026-01-04.md";
    writeFile(
      path.join(workspacePath, rel),
      ["# 2026-01-04", "", "cache me", "cache me too", "cache me three"].join("\n")
    );

    let embedCalls = 0;
    const provider = {
      modelPath: "/fake/model.gguf",
      embedQuery: async () => [0, 0, 0],
      embedBatch: async (texts) => {
        embedCalls += 1;
        return texts.map((t) => [t.length, 1, 0]);
      }
    };

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });
    assert.ok(embedCalls > 0, "expected embedBatch to be called on first index");

    const cacheCount = db
      .prepare("SELECT COUNT(*) as c FROM embedding_cache WHERE model = ?")
      .get(provider.modelPath).c;
    assert.ok(cacheCount > 0, "expected embeddings to be cached");

    embedCalls = 0;
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });
    assert.equal(embedCalls, 0, "expected cached embeddings to avoid embedBatch calls");

    db.close();
  });
});

test("incremental sync: deleted memory file is removed from index", async () => {
  await withTempHome(async () => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    const rel = "memory/2026-01-05.md";
    const abs = path.join(workspacePath, rel);
    writeFile(abs, "# 2026-01-05\n\ntodelete\n");

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: null });
    assert.ok(searchText(db, "todelete", 10).length > 0);

    fs.unlinkSync(abs);
    await ensureIndexUpToDate(db, workspacePath, { embeddingProvider: null });
    assert.equal(searchText(db, "todelete", 10).length, 0);

    db.close();
  });
});

test("performance: keyword search remains fast on larger workspaces", async () => {
  await withTempHome(async () => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeFile(path.join(workspacePath, "MEMORY.md"), "perf\n");

    for (let day = 1; day <= 60; day += 1) {
      const name = `2026-01-${String(day).padStart(2, "0")}.md`;
      const lines = ["# " + name.replace(".md", ""), "", "performance keyword"];
      for (let i = 0; i < 30; i += 1) {
        lines.push(`line ${i}: performance keyword ${i}`);
      }
      writeFile(path.join(workspacePath, "memory", name), lines.join("\n"));
    }

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: null });

    const start = Date.now();
    const hits = searchText(db, "performance", 5);
    const elapsedMs = Date.now() - start;

    assert.ok(hits.length > 0, "expected results");
    assert.ok(elapsedMs < 5000, `expected search < 5000ms, got ${elapsedMs}ms`);

    db.close();
  });
});

test("performance: semantic search finds stock memories with different wording", async () => {
  await withTempHome(async (homeDir) => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeSettings(homeDir, { chunking: { tokens: 50, overlap: 10 } });
    writeFile(
      path.join(workspacePath, "MEMORY.md"),
      [
        "## Investing",
        "- Prefer low-cost index funds for stock exposure.",
        "- Keep a diversified portfolio of stocks and bonds.",
        "- Focus on long-term investing and dollar-cost averaging."
      ].join("\n")
    );

    // Noise docs that should not match equity-related queries.
    for (let i = 0; i < 120; i += 1) {
      const lines = ["# Noise", ""];
      for (let j = 0; j < 80; j += 1) {
        lines.push(`line ${j}: cooking travel hiking recipes music movies`);
      }
      writeFile(
        path.join(workspacePath, "memory", "noise", `note-${String(i + 1).padStart(3, "0")}.md`),
        lines.join("\n")
      );
    }

    const tokenGroups = [
      {
        patterns: [/\bstocks?\b/g, /\bequit(?:y|ies)\b/g, /\bshares?\b/g, /\bstock market\b/g]
      },
      { patterns: [/\bbonds?\b/g, /\btreasur(?:y|ies)\b/g, /\bfixed income\b/g] },
      { patterns: [/\betfs?\b/g, /\bindex funds?\b/g, /\bmutual funds?\b/g] },
      { patterns: [/\bdiversif(?:y|ied|ication)?\b/g, /\brebalance\b/g] },
      { patterns: [/\binvest(?:ing|ment|or)?\b/g, /\bportfolio\b/g, /\ballocat(?:e|ion)\b/g] },
      // Ensure unrelated docs still produce non-zero vectors (avoids undefined cosine distance behavior).
      {
        patterns: [
          /\bcooking\b/g,
          /\btravel\b/g,
          /\bhiking\b/g,
          /\brecipes?\b/g,
          /\bmusic\b/g,
          /\bmovies?\b/g
        ]
      }
    ];

    const embedText = (text) => {
      const lower = String(text || "").toLowerCase();
      const vec = tokenGroups.map((group) => {
        let count = 0;
        for (const pattern of group.patterns) {
          const matches = lower.match(pattern);
          if (matches) count += matches.length;
        }
        return count;
      });
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      return norm > 0 ? vec.map((v) => v / norm) : vec;
    };

    const provider = {
      modelPath: "/fake/semantic-model.gguf",
      embedQuery: async (text) => embedText(text),
      embedBatch: async (texts) => texts.map((t) => embedText(t))
    };

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });

    const queries = [
      { query: "equities allocation", expectContains: "stocks" },
      { query: "buy shares", expectContains: "stocks" }
    ];

    const start = Date.now();
    for (const q of queries) {
      const queryVec = await provider.embedQuery(buildQueryInstruction(q.query));
      const results = await searchVector(db, queryVec, 5, provider.modelPath);
      assert.ok(results.length > 0, "expected semantic results");
      assert.equal(results[0].file_path, "MEMORY.md", "expected top result from MEMORY.md");
      assert.ok(
        String(results[0].snippet || "").toLowerCase().includes(q.expectContains),
        `expected snippet to contain "${q.expectContains}"`
      );
    }
    const elapsedMs = Date.now() - start;
    assert.ok(elapsedMs < 5000, `expected semantic search < 5000ms, got ${elapsedMs}ms`);

    db.close();
  });
});

test("retrieval quality score: multilingual video streaming (normal + hard cases + chunking)", async () => {
  await withTempHome(async (homeDir) => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeSettings(homeDir, { chunking: { tokens: 200, overlap: 40 } });

    const longRelevantSentence =
      "The platform offers real-time video streaming with low latency and high playback quality. " +
      "Adaptive bitrate (ABR) and video transcoding improve playback quality under poor connections. " +
      "Low-latency live streaming is critical for online events.";
    const longFillerSentence =
      "Unrelated note: the backend infrastructure must scale under heavy traffic; I bought a new keyboard.";
    const longRelevantParagraph = [
      longRelevantSentence,
      longRelevantSentence,
      longRelevantSentence,
      longRelevantSentence,
      longRelevantSentence,
      longFillerSentence,
      longRelevantSentence,
      longRelevantSentence,
      longRelevantSentence,
      longFillerSentence
    ].join("\n");

    const docs = [
      { id: "01", group: "A", lang: "zh", text: "这家公司提供高质量的视频转码和实时流媒体服务。" },
      { id: "02", group: "A", lang: "zh", text: "我们正在优化视频播放的延迟和清晰度。" },
      { id: "03", group: "A", lang: "zh", text: "该平台支持点播和直播两种视频场景。" },
      { id: "04", group: "A", lang: "en", text: "The platform offers real-time video streaming with low latency." },
      { id: "05", group: "A", lang: "en", text: "Video transcoding and adaptive bitrate are core features of this service." },
      { id: "06", group: "A", lang: "en", text: "This product focuses on improving video playback quality." },
      { id: "07", group: "B", lang: "zh", text: "系统可以根据网络情况动态调整视频码率。" },
      { id: "08", group: "B", lang: "zh", text: "用户在弱网环境下也能流畅观看视频。" },
      { id: "09", group: "B", lang: "en", text: "The system dynamically adjusts bitrate based on network conditions." },
      { id: "10", group: "B", lang: "en", text: "Users can watch videos smoothly even on poor connections." },
      { id: "11", group: "C", lang: "zh", text: "低延迟直播对于在线活动非常重要。" },
      { id: "12", group: "C", lang: "en", text: "Low-latency live streaming is critical for online events." },
      { id: "13", group: "D", lang: "zh", text: "后端服务需要处理高并发请求。" },
      { id: "14", group: "D", lang: "en", text: "The backend infrastructure must scale under heavy traffic." },
      // Hard positives: long paragraph should be chunked but remain retrievable.
      { id: "19", group: "A", lang: "en", text: longRelevantParagraph },
      // Hard negatives: share a few keywords but are semantically off.
      {
        id: "20",
        group: "F",
        lang: "en",
        text: "We reduced keyboard latency for gaming and improved typing feel; video capture quality was unrelated."
      },
      {
        id: "21",
        group: "F",
        lang: "en",
        text: "This video editing workflow improves render quality for offline clips (not for delivery)."
      },
      // Edge case: empty file should produce no chunks and never rank.
      { id: "22", group: "Z", lang: "en", text: "" },
      { id: "15", group: "E", lang: "zh", text: "我今天中午吃了一碗牛肉面。" },
      { id: "16", group: "E", lang: "zh", text: "上海的天气最近有点潮湿。" },
      { id: "17", group: "E", lang: "en", text: "I bought a new keyboard for my laptop." },
      { id: "18", group: "E", lang: "en", text: "The cat is sleeping on the sofa." }
    ];

    for (const doc of docs) {
      writeFile(path.join(workspacePath, "memory", "corpus-video", `doc-${doc.id}.md`), doc.text + "\n");
    }

    const patterns = [
      {
        name: "streaming",
        patterns: [
          /流媒体/g,
          /直播/g,
          /点播/g,
          /\bstreaming\b/gi,
          /\breal-time\b/gi,
          /\blive\b/gi,
          /\bplayback\b/gi
        ]
      },
      {
        name: "video",
        patterns: [
          /视频/g,
          /\bvideo(?:s)?\b/gi
        ]
      },
      {
        name: "transcoding",
        patterns: [
          /转码/g,
          /\btranscod\w*\b/gi
        ]
      },
      { name: "latency", patterns: [/延迟/g, /低延迟/g, /\blow[-\s]?latency\b/gi, /\blatency\b/gi] },
      {
        name: "quality",
        patterns: [/清晰度/g, /播放质量/g, /高质量/g, /\bquality\b/gi, /\bplayback quality\b/gi]
      },
      {
        name: "bitrate",
        patterns: [
          /码率/g,
          /弱网/g,
          /网络/g,
          /\bbitrate\b/gi,
          /\badaptive bitrate\b/gi,
          /\bnetwork conditions\b/gi,
          /\bpoor connections\b/gi,
          /\bdynamically adjusts\b/gi
        ]
      },
      {
        name: "capture",
        patterns: [/采集/g, /\bcapture\b/gi, /\brecord(?:ing|ed)?\b/gi, /\bwebcam\b/gi]
      },
      {
        name: "editing",
        patterns: [/编辑/g, /\bedit(?:ing|or|ors)?\b/gi, /\brender(?:ing)?\b/gi, /\boffline clips?\b/gi]
      },
      {
        name: "gaming",
        patterns: [/游戏/g, /\bgam(?:e|es|ing)\b/gi, /\btyping\b/gi]
      },
      {
        name: "backend",
        patterns: [/后端/g, /高并发/g, /\bbackend\b/gi, /\binfrastructure\b/gi, /\bheavy traffic\b/gi, /\bscale\b/gi]
      },
      {
        name: "unrelated",
        patterns: [/牛肉面/g, /天气/g, /上海/g, /\bkeyboard\b/gi, /\blaptop\b/gi, /\bcat\b/gi, /\bsofa\b/gi]
      }
    ];

    const embedText = (text) => {
      const raw = String(text || "");
      const vec = patterns.map((group) => {
        let count = 0;
        for (const pattern of group.patterns) {
          const matches = raw.match(pattern);
          if (matches) count += matches.length;
        }
        return count;
      });
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      return norm > 0 ? vec.map((v) => v / norm) : vec;
    };

    const provider = {
      modelPath: "/fake/multilingual-model.gguf",
      embedQuery: async (text) => embedText(text),
      embedBatch: async (texts) => texts.map((t) => embedText(t))
    };

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });

    const relevant = new Set(docs.filter((d) => ["A", "B", "C"].includes(d.group)).map((d) => d.id));
    const negatives = new Set(docs.filter((d) => ["E", "F"].includes(d.group)).map((d) => d.id));
    const emptyDocs = new Set(docs.filter((d) => d.group === "Z").map((d) => d.id));
    const byPath = new Map(
      docs.map((d) => [`memory/corpus-video/doc-${d.id}.md`, d])
    );

    const runSearch = async (query) => {
      const queryVec = await provider.embedQuery(buildQueryInstruction(query));
      return searchHybrid({
        db,
        query,
        queryVec,
        limit: 20,
        vectorWeight: 0.7,
        textWeight: 0.3,
        candidateMultiplier: 4,
        maxCandidates: 200,
        snippetMaxChars: 700,
        model: provider.modelPath
      });
    };

    const topUniqueDocIds = (results, k) => {
      const seen = new Set();
      const out = [];
      for (const row of results) {
        const doc = byPath.get(row.file_path);
        if (!doc) continue;
        if (seen.has(doc.id)) continue;
        seen.add(doc.id);
        out.push(doc.id);
        if (out.length >= k) break;
      }
      return out;
    };

    const englishQuery = "How does the system handle low-latency video streaming and playback quality?";
    const chineseQuery = "这个系统是如何保证视频直播低延迟和播放质量的？";
    const englishResults = await runSearch(englishQuery);
    const chineseResults = await runSearch(chineseQuery);

    const score = [];
    const failures = [];

    const check = async (name, fn) => {
      try {
        await fn();
        score.push({ name, ok: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        score.push({ name, ok: false });
        failures.push({ name, message });
      }
    };

    const checkQuery = async (label, results, expectCrossLang) => {
      const top8Unique = topUniqueDocIds(results, 8);
      const top10RankedIds = results
        .slice(0, 10)
        .map((r) => byPath.get(r.file_path))
        .filter(Boolean)
        .map((d) => d.id);
      const relevantHits = top8Unique.filter((id) => relevant.has(id)).length;
      const negativeHits = top10RankedIds.filter((id) => negatives.has(id));
      const hasCrossLang = top8Unique
        .map((id) => byPath.get(`memory/corpus-video/doc-${id}.md`))
        .filter(Boolean)
        .some((doc) => doc.lang === expectCrossLang);

      await check(`${label}: results non-empty`, () => {
        assert.ok(results.length > 0, "expected results");
      });
      await check(`${label}: >=6 relevant in top 8`, () => {
        assert.ok(
          relevantHits >= 6,
          `expected >=6 relevant in top 8, got ${relevantHits} (${top8Unique.join(",")})`
        );
      });
      await check(`${label}: no obvious negatives in top 10`, () => {
        assert.equal(
          negativeHits.length,
          0,
          `expected no negatives in top 10, got ${negativeHits.join(",")}`
        );
      });
      await check(`${label}: cross-language present`, () => {
        assert.ok(hasCrossLang, `expected at least one ${expectCrossLang} doc in top 8`);
      });
    };

    await checkQuery("EN query", englishResults, "zh");
    await checkQuery("ZH query", chineseResults, "en");

    await check("chunking: long paragraph doc is split into multiple chunks", () => {
      const rel = "memory/corpus-video/doc-19.md";
      const rows = db
        .prepare("SELECT content FROM chunks WHERE file_path = ? ORDER BY rowid ASC")
        .all(rel);
      assert.ok(rows.length > 1, `expected doc-19 to be chunked into multiple chunks, got ${rows.length}`);
    });

    await check("chunking: overlap carries tail context across long paragraph chunks", () => {
      const rel = "memory/corpus-video/doc-19.md";
      const rows = db
        .prepare("SELECT content FROM chunks WHERE file_path = ? ORDER BY rowid ASC LIMIT 2")
        .all(rel);
      assert.equal(rows.length, 2, "expected at least 2 chunks for doc-19");
      const first = String(rows[0].content || "");
      const second = String(rows[1].content || "");
      const lastLine = first.trim().split("\n").slice(-1)[0] || "";
      assert.ok(lastLine.length > 0, "expected non-empty tail line");
      assert.ok(second.includes(lastLine), "expected overlap to include tail line from previous chunk");
    });

    await check("edge: empty doc yields no chunks", () => {
      const rel = "memory/corpus-video/doc-22.md";
      const rows = db.prepare("SELECT count(*) as c FROM chunks WHERE file_path = ?").get(rel);
      assert.equal(rows.c, 0, "expected zero chunks for empty doc-22");
    });

    await check("edge: empty doc does not appear in top 20", () => {
      const top = new Set(topUniqueDocIds(englishResults, 20));
      for (const id of emptyDocs) {
        assert.ok(!top.has(id), `did not expect empty doc-${id} in top 20`);
      }
    });

    const passed = score.filter((s) => s.ok).length;
    const total = score.length;
    const pct = total > 0 ? passed / total : 1;
    const pctStr = (pct * 100).toFixed(1);
    const label =
      pct === 1
        ? "great"
        : pct >= 0.95
          ? "acceptable"
          : pct >= 0.9
            ? "something seems wrong"
            : "broken";

    console.log(`[quality-score] ${passed}/${total} (${pctStr}%) - ${label}`);
    for (const f of failures) {
      console.log(`[quality-miss] ${f.name}: ${f.message}`);
    }

    assert.ok(pct >= 0.9, `quality score below 90%: ${passed}/${total} (${pctStr}%)`);

    db.close();
  });
});
