#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function readInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function mkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function runCli({ cliPath, homeDir, args, env = {}, input }) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, HOME: homeDir, MEM_CLI_DAEMON: "0", ...env },
    encoding: "utf8",
    input
  });
  const elapsedMs = Date.now() - started;
  return { ...res, elapsedMs };
}

function readJsonStdout(res) {
  const raw = (res.stdout || "").trim();
  assert.ok(raw, `expected JSON output, got empty stdout (stderr=${res.stderr})`);
  return JSON.parse(raw);
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

function randomChoice(rand, arr) {
  return arr[Math.floor(rand() * arr.length)] || arr[0];
}

function generateDoc({ rand, id, wordsPerDoc }) {
  const words = [
    "agent",
    "memory",
    "index",
    "search",
    "chunk",
    "embedding",
    "vector",
    "keyword",
    "hybrid",
    "latency",
    "reindex",
    "workspace",
    "public",
    "private",
    "token",
    "sqlite",
    "cache",
    "model",
    "prompt",
    "recall",
    "precision",
    "notes",
    "meeting",
    "decision",
    "todo",
    "bug",
    "fix",
    "benchmark",
    "performance",
    "regression"
  ];

  const lines = [];
  lines.push(`# Doc ${id}`);
  lines.push("");
  lines.push(`tags: ${randomChoice(rand, words)}, ${randomChoice(rand, words)}, ${randomChoice(rand, words)}`);
  lines.push("");

  const sentenceWordCount = 12;
  const sentenceCount = Math.max(1, Math.floor(wordsPerDoc / sentenceWordCount));
  for (let s = 0; s < sentenceCount; s += 1) {
    const w = [];
    for (let i = 0; i < sentenceWordCount; i += 1) {
      w.push(randomChoice(rand, words));
    }
    const sentence = w.join(" ");
    lines.push(`${sentence}.`);
    if (s > 0 && s % 4 === 0) lines.push("");
  }

  return lines.join("\n") + "\n";
}

function listFilesRec(dir) {
  const out = [];
  const walk = (d) => {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function totalBytes(dir) {
  let total = 0;
  for (const file of listFilesRec(dir)) {
    total += fs.statSync(file).size;
  }
  return total;
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s - m * 60;
  return `${m}m ${rem.toFixed(2)}s`;
}

function parseSizes(raw) {
  const fallback = [1000, 10000];
  if (!raw) return fallback;
  const parts = String(raw)
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isFinite(n) && n > 0) out.push(Math.floor(n));
  }
  return out.length > 0 ? out : fallback;
}

function writeSettings({ homeDir, modelPath }) {
  const settings = {
    version: 2,
    chunking: { tokens: 400, overlap: 80, minChars: 32, charsPerToken: 4 },
    embeddings: {
      modelPath,
      cacheDir: "",
      batchMaxTokens: 8000,
      approxCharsPerToken: 1,
      cacheLookupBatchSize: 400,
      queryInstructionTemplate:
        "Instruct: Given a memory search query, retrieve relevant memory snippets that answer the query\nQuery: {query}"
    },
    search: {
      limit: 10,
      vectorWeight: 0.9,
      textWeight: 0.1,
      candidateMultiplier: 2,
      maxCandidates: 200,
      snippetMaxChars: 700
    },
    summary: { days: 7, maxChars: 8000, full: false },
    debug: { vector: false }
  };
  writeFile(path.join(homeDir, ".mem-cli", "settings.json"), JSON.stringify(settings, null, 2) + "\n");
}

async function main() {
  const root = path.join(__dirname, "..");
  const cliPath = process.env.MEM_CLI_BIN || path.join(root, "dist", "index.js");
  if (!fs.existsSync(cliPath)) {
    throw new Error(`CLI not found at ${cliPath}. Build first: npm run build`);
  }

  const sizes = parseSizes(process.env.MEM_CLI_REINDEX_SIZES);
  const seed = readInt("MEM_CLI_REINDEX_SEED", 42);
  const wordsPerDoc = readInt("MEM_CLI_REINDEX_WORDS_PER_DOC", 96);
  const dims = readInt("MEM_CLI_REINDEX_EMBED_DIMS", 8);
  const loadMs = readInt("MEM_CLI_REINDEX_EMBED_LOAD_MS", 0);

  const rows = [];
  for (const count of sizes) {
    const homeDir = mkdtemp("mem-cli-reindex-home-");
    const rand = mulberry32(seed + count);
    try {
      writeSettings({ homeDir, modelPath: "/fake/reindex-benchmark-model.gguf" });

      const env = {
        MEM_CLI_EMBEDDINGS_MOCK: "1",
        MEM_CLI_EMBEDDINGS_MOCK_DIMS: String(dims),
        MEM_CLI_EMBEDDINGS_MOCK_LOAD_MS: String(loadMs)
      };

      const initRes = runCli({ cliPath, homeDir, args: ["init", "--public", "--json"], env });
      assert.equal(initRes.status, 0, initRes.stderr || initRes.stdout);
      const init = readJsonStdout(initRes);
      const workspacePath = init.workspace;
      assert.ok(workspacePath, "expected init JSON to include workspace");

      const corpusDir = path.join(workspacePath, "memory", "corpus-reindex");
      fs.mkdirSync(corpusDir, { recursive: true });

      for (let i = 0; i < count; i += 1) {
        const id = String(i + 1).padStart(5, "0");
        const content = generateDoc({ rand, id, wordsPerDoc });
        writeFile(path.join(corpusDir, `doc-${id}.md`), content);
      }

      const bytes = totalBytes(path.join(workspacePath, "memory"));

      const reindexRes = runCli({ cliPath, homeDir, args: ["reindex", "--public", "--json"], env });
      assert.equal(reindexRes.status, 0, reindexRes.stderr || reindexRes.stdout);

      const stateRes = runCli({ cliPath, homeDir, args: ["state", "--public", "--json"], env });
      assert.equal(stateRes.status, 0, stateRes.stderr || stateRes.stdout);
      const state = readJsonStdout(stateRes);

      rows.push({
        docs: count,
        bytes,
        chunks: state.indexChunks,
        reindexMs: reindexRes.elapsedMs
      });
    } finally {
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  }

  const now = new Date().toISOString();
  const header = [
    "# Reindex benchmark (synthetic)",
    "",
    `- Date: ${now}`,
    `- Command: \`bash scripts/e2e-reindex-performance.sh\``,
    `- Mode: mock embeddings (dims=${dims}, loadMs=${loadMs}), daemon disabled`,
    `- Generator: ${wordsPerDoc} words/doc, seed=${seed}`,
    ""
  ].join("\n");

  const table = [
    "| Docs | Approx bytes | Indexed chunks | `mem reindex` wall time |",
    "| ---: | ---: | ---: | ---: |",
    ...rows.map((r) => `| ${r.docs} | ${r.bytes} | ${r.chunks} | ${formatMs(r.reindexMs)} |`)
  ].join("\n");

  const out = `${header}${table}\n`;
  process.stdout.write(out);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

