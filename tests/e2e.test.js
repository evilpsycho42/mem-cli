const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const { spawnSync, spawn } = require("node:child_process");

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
    version: 3,
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

function runCli({ homeDir, args, env = {}, input }) {
  const cliPath = path.join(__dirname, "..", "dist", "index.js");
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: homeDir, MEM_CLI_DAEMON: "0", ...env },
    encoding: "utf8",
    input
  });
  return res;
}

function runCliAsync({ homeDir, args, env = {}, input, timeoutMs = 30000 }) {
  const cliPath = path.join(__dirname, "..", "dist", "index.js");
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, HOME: homeDir, MEM_CLI_DAEMON: "0", ...env },
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        status: typeof code === "number" ? code : 1,
        signal,
        stdout,
        stderr,
        elapsedMs: Date.now() - started
      });
    });

    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

function daemonPing({ homeDir, timeoutMs = 2000 }) {
  const { daemonAddress, DAEMON_PROTOCOL_VERSION } = require("../dist/core/daemon-transport.js");
  const clientVersion = require("../package.json").version;
  const { address } = daemonAddress();

  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    socket.setEncoding("utf8");

    const done = (err, res) => {
      socket.removeAllListeners();
      try {
        socket.end();
      } catch {}
      if (err) reject(err);
      else resolve(res);
    };

    socket.once("error", (err) => done(err));
    socket.setTimeout(timeoutMs, () => done(new Error("daemon ping timeout")));

    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      try {
        const parsed = JSON.parse(line);
        done(null, parsed);
      } catch (err) {
        done(err);
      }
    });

    socket.once("connect", () => {
      const payload = {
        type: "ping",
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        clientVersion
      };
      socket.write(`${JSON.stringify(payload)}\n`);
    });
  });
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

function searchVector(db, queryVec, limit, model, snippetMaxChars = 700) {
  // eslint-disable-next-line global-require
  return require("../dist/core/search.js").searchVector(db, queryVec, limit, model, snippetMaxChars);
}

function buildQueryInstruction(query) {
  // eslint-disable-next-line global-require
  return require("../dist/core/embeddings.js").buildQueryInstruction(query);
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

test("cli: add short/long writes raw Markdown (no injected headers) and semantic search returns results", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/missing-model.gguf", cacheDir: "" } });
    const env = { MEM_CLI_EMBEDDINGS_MOCK: "1", MEM_CLI_EMBEDDINGS_MOCK_DIMS: "8" };

    const initRes = runCli({ homeDir, args: ["init", "--public", "--json"], env });
    assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);
    const init = readJson(initRes);
    const workspacePath = init.workspace;
    assert.ok(workspacePath);

    const addShortRes = runCli({ homeDir, args: ["add", "short", "hello world", "--public"], env });
    assert.equal(addShortRes.status, 0, addShortRes.stderr || addShortRes.stdout);

    const memoryDir = path.join(workspacePath, "memory");
    const dailyFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
    assert.equal(dailyFiles.length, 1, "expected exactly one daily memory file");
    const dailyPath = path.join(memoryDir, dailyFiles[0]);
    const dailyContent = fs.readFileSync(dailyPath, "utf8");
    assert.equal(dailyContent.trim(), "hello world");
    assert.ok(!dailyContent.includes("## "), "expected no injected timestamp headings");
    assert.ok(!dailyContent.match(/^#\s/m), "expected no injected date headings");

    const addLongRes = runCli({ homeDir, args: ["add", "long", "alpha", "--public"], env });
    assert.equal(addLongRes.status, 0, addLongRes.stderr || addLongRes.stdout);
    const addLong2Res = runCli({ homeDir, args: ["add", "long", "beta", "--public"], env });
    assert.equal(addLong2Res.status, 0, addLong2Res.stderr || addLong2Res.stdout);

    const longPath = path.join(workspacePath, "MEMORY.md");
    const longContent = fs.readFileSync(longPath, "utf8");
    assert.equal(longContent, "alpha\n\nbeta\n");

    const searchRes = runCli({ homeDir, args: ["search", "hello", "--public", "--json"], env });
    assert.equal(searchRes.status, 0, searchRes.stderr || searchRes.stdout);
    const out = readJson(searchRes);
    assert.ok(Array.isArray(out.results));
    assert.ok(out.results.length > 0, "expected at least one search hit");
    assert.ok(out.results.every((r) => r.textScore === undefined), "expected no keyword/text scores");
    assert.ok(
      out.results.some((r) => String(r.file_path || "").startsWith("memory/")),
      "expected hit from daily memory file"
    );
  });
});

test("cli: reindex --all updates only when needed", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/mock-model.gguf", cacheDir: "" } });
    const env = { MEM_CLI_EMBEDDINGS_MOCK: "1", MEM_CLI_EMBEDDINGS_MOCK_DIMS: "8" };

    const initPublicRes = runCli({ homeDir, args: ["init", "--public", "--json"], env });
    assert.equal(initPublicRes.status, 0, initPublicRes.stderr || initPublicRes.stdout);
    const publicInit = readJson(initPublicRes);
    const publicPath = publicInit.workspace;
    assert.ok(publicPath);

    const token = "test-token-123";
    const initPrivateRes = runCli({ homeDir, args: ["init", "--token", token, "--json"], env });
    assert.equal(initPrivateRes.status, 0, initPrivateRes.stderr || initPrivateRes.stdout);
    const privateInit = readJson(initPrivateRes);
    const privatePath = privateInit.workspace;
    assert.ok(privatePath);

    const addPublic = runCli({ homeDir, args: ["add", "short", "hello-public", "--public"], env });
    assert.equal(addPublic.status, 0, addPublic.stderr || addPublic.stdout);
    const addPrivate = runCli({ homeDir, args: ["add", "short", "hello-private", "--token", token], env });
    assert.equal(addPrivate.status, 0, addPrivate.stderr || addPrivate.stdout);

    const reindexAllRes = runCli({ homeDir, args: ["reindex", "--all", "--json"], env });
    assert.equal(reindexAllRes.status, 0, reindexAllRes.stderr || reindexAllRes.stdout);
    const outA = readJson(reindexAllRes);
    assert.ok(Array.isArray(outA.workspaces), "expected JSON workspaces list");
    const mapA = new Map(outA.workspaces.map((w) => [w.workspace, w.status]));
    assert.equal(mapA.get(publicPath), "up-to-date");
    assert.equal(mapA.get(privatePath), "up-to-date");

    writeSettings(homeDir, { chunking: { tokens: 300 } });
    const reindexAllRes2 = runCli({ homeDir, args: ["reindex", "--all", "--json"], env });
    assert.equal(reindexAllRes2.status, 0, reindexAllRes2.stderr || reindexAllRes2.stdout);
    const outB = readJson(reindexAllRes2);
    const mapB = new Map(outB.workspaces.map((w) => [w.workspace, w.status]));
    assert.equal(mapB.get(publicPath), "updated");
    assert.equal(mapB.get(privatePath), "updated");

    const reindexPublicRes = runCli({ homeDir, args: ["reindex", "--public"], env });
    assert.equal(reindexPublicRes.status, 0, reindexPublicRes.stderr || reindexPublicRes.stdout);
    assert.ok(
      String(reindexPublicRes.stdout || "").includes("Index already up to date."),
      "expected reindex to report up-to-date status"
    );
  });
});

test("daemon: forwards add/search and supports --stdin", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/missing-model.gguf", cacheDir: "" } });

    const daemonEnv = {
      MEM_CLI_DAEMON: "1",
      MEM_CLI_DAEMON_IDLE_MS: "10000",
      MEM_CLI_EMBEDDINGS_MOCK: "1",
      MEM_CLI_EMBEDDINGS_MOCK_DIMS: "8"
    };

    try {
      const initRes = runCli({
        homeDir,
        args: ["init", "--public", "--json"],
        env: daemonEnv
      });
      assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);
      const init = readJson(initRes);
      const workspacePath = init.workspace;
      assert.ok(workspacePath);

      const addShortRes = runCli({
        homeDir,
        args: ["add", "short", "hello world", "--public"],
        env: daemonEnv
      });
      assert.equal(addShortRes.status, 0, addShortRes.stderr || addShortRes.stdout);

      const addLongStdinRes = runCli({
        homeDir,
        args: ["add", "long", "--public", "--stdin"],
        env: daemonEnv,
        input: "alpha from stdin\n"
      });
      assert.equal(addLongStdinRes.status, 0, addLongStdinRes.stderr || addLongStdinRes.stdout);

      const longPath = path.join(workspacePath, "MEMORY.md");
      const longContent = fs.readFileSync(longPath, "utf8");
      assert.ok(longContent.includes("alpha from stdin"));

      const searchRes = runCli({
        homeDir,
        args: ["search", "hello", "--public", "--json"],
        env: daemonEnv
      });
      assert.equal(searchRes.status, 0, searchRes.stderr || searchRes.stdout);
      const out = readJson(searchRes);
      assert.ok(Array.isArray(out.results));
      assert.ok(out.results.length > 0, "expected at least one search hit");
    } finally {
      runCli({ homeDir, args: ["__daemon", "--shutdown"] });
    }
  });
});

test("edge: concurrent clients (daemon) + manual file edits stay consistent", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/missing-model.gguf", cacheDir: "" } });

    const daemonEnv = {
      MEM_CLI_DAEMON: "1",
      MEM_CLI_DAEMON_IDLE_MS: "20000",
      MEM_CLI_EMBEDDINGS_MOCK: "1",
      MEM_CLI_EMBEDDINGS_MOCK_DIMS: "8"
    };

    try {
      const initRes = runCli({
        homeDir,
        args: ["init", "--public", "--json"],
        env: daemonEnv
      });
      assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);
      const init = readJson(initRes);
      const workspacePath = init.workspace;
      assert.ok(workspacePath);

      // Start from a cold state: multiple clients issue forwardable commands simultaneously.
      const entries = ["edgecasealphaa", "edgecasealphab"];
      const addResults = await Promise.all(
        entries.map((text) =>
          runCliAsync({
            homeDir,
            args: ["add", "short", text, "--public"],
            env: daemonEnv
          })
        )
      );
      for (const res of addResults) {
        assert.equal(res.status, 0, res.stderr || res.stdout);
      }

      const memoryDir = path.join(workspacePath, "memory");
      const dailyFiles = fs.readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
      assert.equal(dailyFiles.length, 1, "expected exactly one daily memory file");
      const dailyPath = path.join(memoryDir, dailyFiles[0]);
      const dailyContent = fs.readFileSync(dailyPath, "utf8");
      for (const text of entries) {
        assert.ok(dailyContent.includes(text), `expected daily log to include ${text}`);
      }

      // Mix add + search concurrently and ensure both succeed.
      const [searchRes, addRes] = await Promise.all([
        runCliAsync({
          homeDir,
          args: ["search", entries[0], "--public", "--json"],
          env: daemonEnv
        }),
        runCliAsync({
          homeDir,
          args: ["add", "short", "edgecasegamma", "--public"],
          env: daemonEnv
        })
      ]);
      assert.equal(searchRes.status, 0, searchRes.stderr || searchRes.stdout);
      assert.equal(addRes.status, 0, addRes.stderr || addRes.stdout);
      const searchOut = JSON.parse(String(searchRes.stdout || "").trim());
      assert.ok(Array.isArray(searchOut.results));
      assert.ok(searchOut.results.length > 0, "expected at least one search hit");

      // Manual memory file edits: create + index, then edit and ensure concurrent searches pick up changes.
      const corpusDir = path.join(workspacePath, "memory", "corpus-edge");
      fs.mkdirSync(corpusDir, { recursive: true });
      const docPath = path.join(corpusDir, "doc.md");
      const relDoc = "memory/corpus-edge/doc.md";

      const oldToken = "manualeditoldtokenzz";
      const newToken = "manualeditnewtokenzzlong";
      writeFile(docPath, `${oldToken}\n`);

      const oldIndexedRes = runCli({
        homeDir,
        args: ["search", oldToken, "--public", "--json"],
        env: daemonEnv
      });
      assert.equal(oldIndexedRes.status, 0, oldIndexedRes.stderr || oldIndexedRes.stdout);
      let db = openDb(workspacePath);
      let rows = db.prepare("SELECT content FROM chunks WHERE file_path = ?").all(relDoc);
      assert.ok(rows.length > 0, "expected manual file to be indexed into chunks table");
      assert.ok(
        rows.some((r) => String(r.content || "").includes(oldToken)),
        "expected indexed chunk content to include old token"
      );
      db.close();

      writeFile(docPath, `${newToken}\nthis line makes the file longer\n`);

      const [newSearchA, newSearchB] = await Promise.all([
        runCliAsync({
          homeDir,
          args: ["search", newToken, "--public", "--json"],
          env: daemonEnv
        }),
        runCliAsync({
          homeDir,
          args: ["search", newToken, "--public", "--json"],
          env: daemonEnv
        })
      ]);
      assert.equal(newSearchA.status, 0, newSearchA.stderr || newSearchA.stdout);
      assert.equal(newSearchB.status, 0, newSearchB.stderr || newSearchB.stdout);
      db = openDb(workspacePath);
      rows = db.prepare("SELECT content FROM chunks WHERE file_path = ?").all(relDoc);
      assert.ok(
        rows.some((r) => String(r.content || "").includes(newToken)),
        "expected indexed chunk content to include new token"
      );
      assert.ok(
        rows.every((r) => !String(r.content || "").includes(oldToken)),
        "expected indexed chunk content to not include old token after edit"
      );
      db.close();
    } finally {
      runCli({ homeDir, args: ["__daemon", "--shutdown"] });
    }
  });
});

test("edge: multi-client request storm (daemon) starts once and loads embeddings once", async () => {
  await withTempHome(async (homeDir) => {
    writeSettings(homeDir, { embeddings: { modelPath: "/fake/mock-model.gguf", cacheDir: "" } });

    const daemonEnv = {
      MEM_CLI_DAEMON: "1",
      MEM_CLI_DAEMON_IDLE_MS: "20000",
      MEM_CLI_DAEMON_TRACE: "1",
      MEM_CLI_EMBEDDINGS_MOCK: "1",
      MEM_CLI_EMBEDDINGS_MOCK_LOAD_MS: "250",
      MEM_CLI_EMBEDDINGS_MOCK_DIMS: "8"
    };

    const traceFile = path.join(homeDir, ".mem-cli", "daemon-starts.log");

    try {
      const initRes = runCli({
        homeDir,
        args: ["init", "--public", "--json"],
        env: daemonEnv
      });
      assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);
      const init = readJson(initRes);
      const workspacePath = init.workspace;
      assert.ok(workspacePath);

      // Cold start storm: many concurrent forwardable commands should still yield one daemon start.
      const concurrentAdds = Array.from({ length: 6 }, (_, i) =>
        runCliAsync({
          homeDir,
          args: ["add", "short", `storm-add-${i}-zz`, "--public"],
          env: daemonEnv
        })
      );
      const addRes = await Promise.all(concurrentAdds);
      for (const res of addRes) {
        assert.equal(res.status, 0, res.stderr || res.stdout);
      }

      // Each "client" runs multiple commands sequentially; clients run concurrently.
      const clientCount = 3;
      const opsPerClient = 3;
      const clientDurations = [];

      const runClient = async (id) => {
        let total = 0;
        for (let op = 0; op < opsPerClient; op += 1) {
          const token = `client-${id}-op-${op}-token-zz`;
          const add = await runCliAsync({
            homeDir,
            args: ["add", "short", token, "--public"],
            env: daemonEnv
          });
          total += add.elapsedMs;
          assert.equal(add.status, 0, add.stderr || add.stdout);

          const search = await runCliAsync({
            homeDir,
            args: ["search", token, "--public", "--json"],
            env: daemonEnv
          });
          total += search.elapsedMs;
          assert.equal(search.status, 0, search.stderr || search.stdout);
          const out = JSON.parse(String(search.stdout || "").trim());
          assert.ok(Array.isArray(out.results));
          assert.ok(out.results.length > 0, "expected search to find newly-added token");
        }
        clientDurations.push(total);
      };

      // Manual edits happen concurrently with client operations.
      const manualEdits = async () => {
        const corpusDir = path.join(workspacePath, "memory", "corpus-storm");
        fs.mkdirSync(corpusDir, { recursive: true });
        const docPath = path.join(corpusDir, "manual.md");
        const relDoc = "memory/corpus-storm/manual.md";

        writeFile(docPath, "manual-old-zz\n");
        const oldSearch = await runCliAsync({
          homeDir,
          args: ["search", "manual-old-zz", "--public", "--json"],
          env: daemonEnv
        });
        assert.equal(oldSearch.status, 0, oldSearch.stderr || oldSearch.stdout);
        let db = openDb(workspacePath);
        let rows = db.prepare("SELECT content FROM chunks WHERE file_path = ?").all(relDoc);
        assert.ok(rows.length > 0, "expected manual file to be indexed into chunks table");
        assert.ok(
          rows.some((r) => String(r.content || "").includes("manual-old-zz")),
          "expected indexed chunk content to include old token"
        );
        db.close();

        writeFile(docPath, "manual-new-zz\nextra\n");
        const [s1, s2] = await Promise.all([
          runCliAsync({
            homeDir,
            args: ["search", "manual-new-zz", "--public", "--json"],
            env: daemonEnv
          }),
          runCliAsync({
            homeDir,
            args: ["search", "manual-new-zz", "--public", "--json"],
            env: daemonEnv
          })
        ]);
        assert.equal(s1.status, 0, s1.stderr || s1.stdout);
        assert.equal(s2.status, 0, s2.stderr || s2.stdout);

        db = openDb(workspacePath);
        rows = db.prepare("SELECT content FROM chunks WHERE file_path = ?").all(relDoc);
        assert.ok(
          rows.some((r) => String(r.content || "").includes("manual-new-zz")),
          "expected indexed chunk content to include new token"
        );
        assert.ok(
          rows.every((r) => !String(r.content || "").includes("manual-old-zz")),
          "expected indexed chunk content to not include old token after edit"
        );
        db.close();
      };

      await Promise.all([
        ...Array.from({ length: clientCount }, (_, i) => runClient(i)),
        manualEdits()
      ]);

      const stateRes = runCli({
        homeDir,
        args: ["state", "--public", "--json"],
        env: daemonEnv
      });
      assert.equal(stateRes.status, 0, stateRes.stderr || stateRes.stdout);
      const state = readJson(stateRes);
      assert.ok(Number(state.markdownFiles) > 0, "expected markdown files in workspace");
      assert.ok(Number(state.indexChunks) > 0, "expected indexed chunks in workspace");

      // Confirm a single daemon processed requests and it only loaded the model once.
      const ping = await daemonPing({ homeDir });
      assert.ok(ping.ok, "expected daemon ping ok");
      assert.ok(typeof ping.pid === "number" && ping.pid > 0, "expected daemon pid");
      assert.ok(typeof ping.startedAt === "number" && ping.startedAt > 0, "expected startedAt");
      assert.ok(ping.embeddings, "expected embeddings stats");
      assert.equal(ping.embeddings.modelLoadCount, 1, "expected exactly one model load in daemon");
      assert.equal(ping.embeddings.contextCreateCount, 1, "expected exactly one context creation in daemon");
      assert.equal(ping.embeddings.providerCreateCount, 1, "expected exactly one provider creation in daemon");

      // Confirm the daemon only started once even under concurrent cold-start pressure.
      const trace = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
      const lines = trace.split("\n").filter((l) => l.trim().length > 0);
      assert.equal(lines.length, 1, `expected 1 daemon start, got ${lines.length} (${trace.trim()})`);

      // Soft monitoring: ensure clients didn't take unbounded time.
      const maxClientMs = Math.max(...clientDurations);
      assert.ok(maxClientMs < 60000, `expected each client to finish < 60s, max=${maxClientMs}ms`);
    } finally {
      runCli({ homeDir, args: ["__daemon", "--shutdown"] });
    }
  });
});

test("cli: CJK query errors when embeddings are unavailable", async () => {
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
    assert.notEqual(searchRes.status, 0, "expected search to fail without embeddings");
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

    const indexedPaths = db
      .prepare("SELECT DISTINCT file_path as p FROM chunks ORDER BY p ASC")
      .all()
      .map((r) => r.p);
    assert.ok(indexedPaths.includes("MEMORY.md"), "expected MEMORY.md to be indexed");
    assert.ok(
      indexedPaths.includes("memory/2026-01-01.md"),
      "expected memory/2026-01-01.md to be indexed"
    );
    assert.ok(!indexedPaths.includes("notes.md"), "notes.md should not be indexed");
    assert.ok(!indexedPaths.includes("memory.md"), "legacy memory.md should not be indexed");

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
    const before = db.prepare("SELECT count(*) as c FROM chunks WHERE file_path = ?").get(rel);
    assert.ok(Number(before.c) > 0, "expected deleted file to be indexed initially");

    fs.unlinkSync(abs);
    await ensureIndexUpToDate(db, workspacePath, { embeddingProvider: null });
    const after = db.prepare("SELECT count(*) as c FROM chunks WHERE file_path = ?").get(rel);
    assert.equal(Number(after.c), 0, "expected deleted file to be removed from index");

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
      return searchVector(db, queryVec, 20, provider.modelPath, 700);
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
