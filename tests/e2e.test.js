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

test("indexing only considers MEMORY.md + memory/**/*.md (not other .md files)", async () => {
  await withTempHome(async () => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    writeFile(path.join(workspacePath, "MEMORY.md"), "# Long-term Memory\n\nalpha\n");
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

test("vector search: daily sections do not leak unrelated entries", async () => {
  await withTempHome(async () => {
    const workspacePath = mkdtemp("mem-cli-ws-");
    const rel = "memory/2026-01-28.md";
    writeFile(
      path.join(workspacePath, rel),
      [
        "# 2026-01-28",
        "",
        "## 09:00",
        "secret code: QQQ",
        "",
        "## 09:05",
        "Discussed equity allocation and low-cost index funds."
      ].join("\n")
    );

    const embedText = (text) => {
      const lower = String(text || "").toLowerCase();
      const finance = (lower.match(/\bequit(?:y|ies)\b/g) || []).length +
        (lower.match(/\bstocks?\b/g) || []).length +
        (lower.match(/\bindex funds?\b/g) || []).length;
      const secret = (lower.match(/\bsecret\b/g) || []).length +
        (lower.match(/\bcode\b/g) || []).length +
        (lower.match(/\bqqq\b/g) || []).length;
      const words = (lower.match(/[a-z0-9_]+/g) || []).length;
      const vec = [finance, secret, words];
      const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
      return norm > 0 ? vec.map((v) => v / norm) : vec;
    };

    const provider = {
      modelPath: "/fake/leak-model.gguf",
      embedQuery: async (text) => embedText(text),
      embedBatch: async (texts) => texts.map((t) => embedText(t))
    };

    const db = openDb(workspacePath);
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });

    const queryVec = await provider.embedQuery(buildQueryInstruction("equity exposure"));
    const results = await searchVector(db, queryVec, 5, provider.modelPath);
    assert.ok(results.length > 0, "expected vector results");
    assert.equal(results[0].file_path, rel, "expected match from the daily log");
    assert.ok(
      !String(results[0].snippet || "").toLowerCase().includes("secret code"),
      "expected snippet to exclude unrelated secret entry"
    );
    assert.ok(
      String(results[0].snippet || "").toLowerCase().includes("equity"),
      "expected finance snippet"
    );

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
    writeFile(path.join(workspacePath, "MEMORY.md"), "# Long-term Memory\n\nperf\n");

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
        "# Long-term Memory",
        "",
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
