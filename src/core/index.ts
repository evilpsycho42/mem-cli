import path from "path";
import fs from "fs";
import crypto from "crypto";
import Database from "better-sqlite3";
import { listMemoryFiles } from "./storage";
import { sha256Hex } from "../utils/hash";
import type { EmbeddingProvider } from "./embeddings";
import { loadSqliteVecExtension } from "./sqlite-vec";
import { ensureSettings, type Settings } from "./settings";
import { indexDbPath } from "./layout";

const META_KEY = "mem_index_meta_v2";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";

type IndexMeta = {
  model?: string;
  dims?: number;
  vectorExtensionPath?: string;
  chunkTokens?: number;
  chunkOverlap?: number;
  chunkMinChars?: number;
  chunkCharsPerToken?: number;
};

let cachedVectorExtensionPath: string | undefined;

type ChunkingConfig = { tokens: number; overlap: number; minChars: number; charsPerToken: number };

type EmbeddingBatchingConfig = {
  batchMaxTokens: number;
  approxCharsPerToken: number;
  cacheLookupBatchSize: number;
};

function resolveChunkingFromSettings(settings: Settings): ChunkingConfig {
  const tokens = settings.chunking.tokens;
  const overlap = settings.chunking.overlap;
  const minChars = settings.chunking.minChars;
  const charsPerToken = settings.chunking.charsPerToken;

  const clampedTokens = Math.max(1, Math.floor(tokens));
  const clampedOverlap = Math.max(0, Math.min(Math.floor(overlap), Math.max(0, clampedTokens - 1)));
  const clampedMinChars = Math.max(1, Math.floor(minChars));
  const clampedCharsPerToken = Math.max(1, Math.floor(charsPerToken));

  return {
    tokens: clampedTokens,
    overlap: clampedOverlap,
    minChars: clampedMinChars,
    charsPerToken: clampedCharsPerToken
  };
}

function resolveEmbeddingBatchingFromSettings(settings: Settings): EmbeddingBatchingConfig {
  const batchMaxTokens = Math.max(1, Math.floor(settings.embeddings.batchMaxTokens));
  const approxCharsPerToken = Math.max(0.01, settings.embeddings.approxCharsPerToken);
  const cacheLookupBatchSize = Math.max(1, Math.floor(settings.embeddings.cacheLookupBatchSize));
  return { batchMaxTokens, approxCharsPerToken, cacheLookupBatchSize };
}

export function openDb(workspacePath: string): Database.Database {
  const dbPath = indexDbPath(workspacePath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  ensureChunksSchema(db);
  ensureFtsSchema(db);
  ensureEmbeddingCacheSchema(db);
  return db;
}

export function getIndexMeta(db: Database.Database): IndexMeta {
  return readMeta(db);
}

function readMeta(db: Database.Database): IndexMeta {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(META_KEY) as { value: string } | undefined;
  if (!row?.value) return {};
  try {
    return JSON.parse(row.value) as IndexMeta;
  } catch {
    return {};
  }
}

function ensureChunksSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      file_path TEXT NOT NULL,
      line_start INTEGER NOT NULL,
      line_end INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      content TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const columns = db
    .prepare("PRAGMA table_info(chunks)")
    .all() as Array<{ name: string }>;
  const required = [
    "id",
    "file_path",
    "line_start",
    "line_end",
    "hash",
    "model",
    "content",
    "embedding",
    "updated_at"
  ];
  const missing = required.some((col) => !columns.find((entry) => entry.name === col));
  if (missing) {
    db.exec("DROP TABLE IF EXISTS chunks");
    db.exec(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL,
        line_start INTEGER NOT NULL,
        line_end INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_file_path ON chunks(file_path);");
}

function ensureFtsSchema(db: Database.Database): void {
  try {
    const columns = db
      .prepare(`PRAGMA table_info(${FTS_TABLE})`)
      .all() as Array<{ name: string }>;
    const hasId = columns.some((entry) => entry.name === "id");
    if (!hasId) {
      db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
    }
  } catch {
    db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE}`);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(\n` +
      `  content,\n` +
      `  id UNINDEXED,\n` +
      `  file_path UNINDEXED,\n` +
      `  line_start UNINDEXED,\n` +
      `  line_end UNINDEXED,\n` +
      `  model UNINDEXED,\n` +
      `  tokenize='porter'\n` +
      `);`
  );
}

function ensureEmbeddingCacheSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
      model TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (model, hash)
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${EMBEDDING_CACHE_TABLE}(updated_at);`
  );
}

function writeMeta(db: Database.Database, meta: IndexMeta): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(META_KEY, JSON.stringify(meta));
}

function hasTable(db: Database.Database, table: string): boolean {
  const row = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { name?: string } | undefined;
  return Boolean(row?.name);
}

async function ensureVectorReady(
  db: Database.Database,
  modelPath: string,
  dims: number,
  debug = false
): Promise<boolean> {
  if (dims <= 0) return false;

  const meta = readMeta(db);
  const previousDims = meta.dims;
  if (meta.model && meta.model !== modelPath) {
    if (hasTable(db, VECTOR_TABLE)) {
      db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    }
    meta.dims = undefined;
  }

  const loaded = await loadSqliteVecExtension({
    db,
    extensionPath: cachedVectorExtensionPath
  });
  if (debug) {
    console.error("[mem-cli] sqlite-vec load", loaded);
  }
  meta.model = modelPath;
  meta.dims = dims;
  if (!loaded.ok) {
    writeMeta(db, meta);
    return false;
  }
  cachedVectorExtensionPath = loaded.extensionPath;
  try {
    const row = db.prepare("SELECT vec_version() as v").get() as { v?: string } | undefined;
    if (debug) {
      console.error("[mem-cli] vec_version", row?.v);
    }
  } catch {
    writeMeta(db, meta);
    return false;
  }

  if (previousDims && previousDims !== dims) {
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
  }

  if (debug) {
    console.error("[mem-cli] creating vec table", dims);
  }
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
      `  id TEXT PRIMARY KEY,\n` +
      `  embedding FLOAT[${dims}]\n` +
      `)`
  );

  meta.vectorExtensionPath = cachedVectorExtensionPath;
  writeMeta(db, meta);
  return true;
}

function toPosixPath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

async function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

type MemoryChunk = { content: string; lineStart: number; lineEnd: number; hash: string };

function chunkLinesByChars(
  lines: string[],
  chunking: ChunkingConfig,
  baseLineNo = 1
): MemoryChunk[] {
  if (lines.length === 0) return [];
  const maxChars = Math.max(chunking.minChars, chunking.tokens * chunking.charsPerToken);
  const overlapChars = Math.max(0, chunking.overlap * chunking.charsPerToken);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) return;
    const text = current.map((entry) => entry.line).join("\n");
    chunks.push({
      content: text,
      lineStart: firstEntry.lineNo,
      lineEnd: lastEntry.lineNo,
      hash: sha256Hex(text)
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) continue;
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, entry) => sum + entry.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = baseLineNo + i;
    const segments: string[] = [];
    if (line.length === 0) {
      segments.push("");
    } else {
      for (let start = 0; start < line.length; start += maxChars) {
        segments.push(line.slice(start, start + maxChars));
      }
    }
    for (const segment of segments) {
      const lineSize = segment.length + 1;
      if (currentChars + lineSize > maxChars && current.length > 0) {
        flush();
        carryOverlap();
      }
      current.push({ line: segment, lineNo });
      currentChars += lineSize;
    }
  }

  flush();
  return chunks;
}

function isH2Heading(line: string): boolean {
  return /^##\s+\S/.test(line);
}

function trimTrailingEmptyLines(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && (lines[end - 1] ?? "").trim().length === 0) {
    end -= 1;
  }
  return lines.slice(0, end);
}

function chunkMarkdown(content: string, chunking: ChunkingConfig): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const h2Starts: number[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (isH2Heading(line)) h2Starts.push(i);
  }

  // No built-in sections: fall back to character-based chunking.
  if (h2Starts.length === 0) {
    return chunkLinesByChars(lines, chunking, 1);
  }

  // Section-based chunking: split at each H2 heading (e.g. `## 14:38`, `## Finance Notes`).
  // This keeps unrelated entries from being returned together (important for privacy + relevance).
  const chunks: MemoryChunk[] = [];
  // We intentionally skip any preamble before the first H2 so headings act like "entry boundaries".
  // (E.g. `# 2026-01-28` or `# Long-term Memory` is rarely useful for semantic recall and can
  // create zero-vector chunks that pollute vector search.)
  const boundaries = h2Starts.filter((v, idx, arr) => idx === 0 || v !== arr[idx - 1]);

  for (let i = 0; i < boundaries.length; i += 1) {
    const start = boundaries[i] ?? 0;
    const next = boundaries[i + 1];
    const rawEnd = typeof next === "number" ? next - 1 : lines.length - 1;
    if (rawEnd < start) continue;

    const sectionLines = trimTrailingEmptyLines(lines.slice(start, rawEnd + 1));
    if (sectionLines.length === 0) continue;

    const maxChars = Math.max(chunking.minChars, chunking.tokens * chunking.charsPerToken);
    const sectionText = sectionLines.join("\n");
    if (sectionText.length > maxChars) {
      // Oversized section: apply overlap-based char chunking within the section only.
      chunks.push(...chunkLinesByChars(sectionLines, chunking, start + 1));
    } else {
      chunks.push({
        content: sectionText,
        lineStart: start + 1,
        lineEnd: start + sectionLines.length,
        hash: sha256Hex(sectionText)
      });
    }
  }

  return chunks;
}

function buildChunkId(
  relPath: string,
  lineStart: number,
  lineEnd: number,
  hash: string,
  ordinal: number
): string {
  return sha256Hex(`${relPath}:${lineStart}:${lineEnd}:${hash}:${ordinal}`);
}

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function estimateEmbeddingTokens(text: string, approxCharsPerToken: number): number {
  if (!text) return 0;
  return Math.ceil(text.length / approxCharsPerToken);
}

function buildEmbeddingBatches(chunks: MemoryChunk[], batching: EmbeddingBatchingConfig): MemoryChunk[][] {
  const batches: MemoryChunk[][] = [];
  let current: MemoryChunk[] = [];
  let currentTokens = 0;

  for (const chunk of chunks) {
    const estimate = estimateEmbeddingTokens(chunk.content, batching.approxCharsPerToken);
    const wouldExceed =
      current.length > 0 && currentTokens + estimate > batching.batchMaxTokens;
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentTokens = 0;
    }
    if (current.length === 0 && estimate > batching.batchMaxTokens) {
      batches.push([chunk]);
      continue;
    }
    current.push(chunk);
    currentTokens += estimate;
  }

  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

function loadEmbeddingCache(
  db: Database.Database,
  model: string,
  hashes: string[],
  batchSize: number
): Map<string, number[]> {
  if (!model) return new Map();
  if (hashes.length === 0) return new Map();
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const hash of hashes) {
    if (!hash) continue;
    if (seen.has(hash)) continue;
    seen.add(hash);
    unique.push(hash);
  }
  if (unique.length === 0) return new Map();

  const out = new Map<string, number[]>();
  for (let start = 0; start < unique.length; start += batchSize) {
    const batch = unique.slice(start, start + batchSize);
    const placeholders = batch.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}\n` +
          ` WHERE model = ? AND hash IN (${placeholders})`
      )
      .all(model, ...batch) as Array<{ hash: string; embedding: string }>;
    for (const row of rows) {
      out.set(row.hash, parseEmbedding(row.embedding));
    }
  }
  return out;
}

function upsertEmbeddingCache(
  db: Database.Database,
  model: string,
  entries: Array<{ hash: string; embedding: number[] }>
): void {
  if (!model) return;
  if (entries.length === 0) return;
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT INTO ${EMBEDDING_CACHE_TABLE} (model, hash, embedding, dims, updated_at)\n` +
      ` VALUES (?, ?, ?, ?, ?)\n` +
      ` ON CONFLICT(model, hash) DO UPDATE SET\n` +
      `   embedding=excluded.embedding,\n` +
      `   dims=excluded.dims,\n` +
      `   updated_at=excluded.updated_at`
  );
  for (const entry of entries) {
    const embedding = entry.embedding ?? [];
    stmt.run(model, entry.hash, JSON.stringify(embedding), embedding.length, now);
  }
}

async function embedChunksWithCache(
  db: Database.Database,
  provider: EmbeddingProvider,
  chunks: MemoryChunk[],
  batching: EmbeddingBatchingConfig
): Promise<number[][]> {
  if (chunks.length === 0) return [];
  const cached = loadEmbeddingCache(
    db,
    provider.modelPath,
    chunks.map((chunk) => chunk.hash),
    batching.cacheLookupBatchSize
  );
  const embeddings: number[][] = Array.from({ length: chunks.length }, () => []);
  const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const chunk = chunks[i];
    const hit = chunk?.hash ? cached.get(chunk.hash) : undefined;
    if (hit && hit.length > 0) {
      embeddings[i] = hit;
    } else if (chunk) {
      missing.push({ index: i, chunk });
    }
  }

  if (missing.length === 0) return embeddings;

  const missingChunks = missing.map((m) => m.chunk);
  const batches = buildEmbeddingBatches(missingChunks, batching);
  const toCache: Array<{ hash: string; embedding: number[] }> = [];
  let cursor = 0;
  for (const batch of batches) {
    const batchEmbeddings = await provider.embedBatch(batch.map((chunk) => chunk.content));
    for (let i = 0; i < batch.length; i += 1) {
      const item = missing[cursor + i];
      const embedding = batchEmbeddings[i] ?? [];
      if (item) {
        embeddings[item.index] = embedding;
        toCache.push({ hash: item.chunk.hash, embedding });
      }
    }
    cursor += batch.length;
  }
  upsertEmbeddingCache(db, provider.modelPath, toCache);
  return embeddings;
}

async function indexFile(
  db: Database.Database,
  workspacePath: string,
  filePath: string,
  provider: EmbeddingProvider | null,
  chunking: ChunkingConfig,
  batching: EmbeddingBatchingConfig,
  debugVector = false
): Promise<void> {
  const relPath = toPosixPath(path.relative(workspacePath, filePath));
  const stat = fs.statSync(filePath);
  const fileHash = await hashFile(filePath);

  const content = fs.readFileSync(filePath, "utf8");
  const chunks = chunkMarkdown(content, chunking).filter((chunk) => chunk.content.trim().length > 0);

  let embeddings: number[][] = [];
  if (provider) {
    embeddings = await embedChunksWithCache(db, provider, chunks, batching);
  }

  const sample = embeddings.find((embedding) => embedding.length > 0);
  const dims = sample ? sample.length : 0;
  const vectorReady = provider
    ? await ensureVectorReady(db, provider.modelPath, dims, debugVector)
    : false;
  const model = provider?.modelPath ?? "";

  if (vectorReady) {
    db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE file_path = ?)`).run(
      relPath
    );
  }
  db.prepare(`DELETE FROM ${FTS_TABLE} WHERE file_path = ?`).run(relPath);
  db.prepare("DELETE FROM chunks WHERE file_path = ?").run(relPath);

  const insertChunk = db.prepare(
    "INSERT INTO chunks (id, file_path, line_start, line_end, hash, model, content, embedding, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const insertFts = db.prepare(
    `INSERT INTO ${FTS_TABLE} (content, id, file_path, line_start, line_end, model) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertVec = vectorReady
    ? db.prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
    : null;

  db.exec("BEGIN");
  try {
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const id = buildChunkId(relPath, chunk.lineStart, chunk.lineEnd, chunk.hash, i);
      const chunkHash = chunk.hash;
      insertChunk.run(
        id,
        relPath,
        chunk.lineStart,
        chunk.lineEnd,
        chunkHash,
        model,
        chunk.content,
        JSON.stringify(embedding),
        Date.now()
      );
      insertFts.run(chunk.content, id, relPath, chunk.lineStart, chunk.lineEnd, model);
      if (insertVec && embedding.length > 0) {
        insertVec.run(id, Buffer.from(new Float32Array(embedding).buffer));
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const upsertFile = db.prepare(
    "INSERT INTO files (path, hash, mtime, size) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime, size = excluded.size"
  );
  upsertFile.run(relPath, fileHash, Math.floor(stat.mtimeMs), stat.size);
}

export async function ensureIndexUpToDate(
  db: Database.Database,
  workspacePath: string,
  options?: { embeddingProvider?: EmbeddingProvider | null }
): Promise<void> {
  const provider = options?.embeddingProvider ?? null;
  const settings = ensureSettings();
  const batching = resolveEmbeddingBatchingFromSettings(settings);
  const meta = readMeta(db);
  const chunking = resolveChunkingFromSettings(settings);
  if (
    meta.chunkTokens !== chunking.tokens ||
    meta.chunkOverlap !== chunking.overlap ||
    meta.chunkMinChars !== chunking.minChars ||
    meta.chunkCharsPerToken !== chunking.charsPerToken
  ) {
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });
    return;
  }
  if (provider && (!meta.model || meta.model !== provider.modelPath)) {
    await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });
    return;
  }

  let vectorExtensionReady = false;
  if (provider && hasTable(db, VECTOR_TABLE)) {
    const loaded = await loadSqliteVecExtension({
      db,
      extensionPath: cachedVectorExtensionPath
    });
    if (loaded.ok) {
      cachedVectorExtensionPath = loaded.extensionPath;
      try {
        db.prepare("SELECT vec_version()").get();
        vectorExtensionReady = true;
      } catch {
        vectorExtensionReady = false;
      }
    }
  }

  const rows = db
    .prepare("SELECT path, hash, mtime, size FROM files")
    .all() as { path: string; hash: string; mtime: number; size: number }[];
  const existing = new Map<string, { hash: string; mtime: number; size: number }>();
  for (const row of rows) {
    existing.set(row.path, { hash: row.hash, mtime: row.mtime, size: row.size });
  }

  const filesOnDisk = listMemoryFiles(workspacePath);
  const seen = new Set<string>();

  for (const filePath of filesOnDisk) {
    const relPath = toPosixPath(path.relative(workspacePath, filePath));
    seen.add(relPath);
    const stat = fs.statSync(filePath);
    const record = existing.get(relPath);
    if (!record) {
      await indexFile(
        db,
        workspacePath,
        filePath,
        provider,
        chunking,
        batching,
        settings.debug.vector
      );
      continue;
    }

    if (record.mtime !== Math.floor(stat.mtimeMs) || record.size !== stat.size) {
      const fileHash = await hashFile(filePath);
      if (fileHash !== record.hash) {
        await indexFile(
          db,
          workspacePath,
          filePath,
          provider,
          chunking,
          batching,
          settings.debug.vector
        );
      } else {
        db.prepare("UPDATE files SET mtime = ?, size = ? WHERE path = ?").run(
          Math.floor(stat.mtimeMs),
          stat.size,
          relPath
        );
      }
    }
  }

  for (const row of rows) {
    if (!seen.has(row.path)) {
      db.prepare(`DELETE FROM ${FTS_TABLE} WHERE file_path = ?`).run(row.path);
      if (hasTable(db, VECTOR_TABLE)) {
        if (vectorExtensionReady) {
          db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE file_path = ?)`).run(
            row.path
          );
        }
      }
      db.prepare("DELETE FROM chunks WHERE file_path = ?").run(row.path);
      db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
    }
  }
}

export async function reindexWorkspace(
  db: Database.Database,
  workspacePath: string,
  options?: { embeddingProvider?: EmbeddingProvider | null }
): Promise<void> {
  const settings = ensureSettings();
  const chunking = resolveChunkingFromSettings(settings);
  const batching = resolveEmbeddingBatchingFromSettings(settings);
  const meta = readMeta(db);
  meta.chunkTokens = chunking.tokens;
  meta.chunkOverlap = chunking.overlap;
  meta.chunkMinChars = chunking.minChars;
  meta.chunkCharsPerToken = chunking.charsPerToken;
  if (!options?.embeddingProvider) {
    meta.model = undefined;
    meta.dims = undefined;
  }
  writeMeta(db, meta);

  db.prepare(`DELETE FROM ${FTS_TABLE}`).run();
  db.prepare("DELETE FROM chunks").run();
  try {
    db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
  } catch {}
  db.prepare("DELETE FROM files").run();

  const filesOnDisk = listMemoryFiles(workspacePath);
  for (const filePath of filesOnDisk) {
    await indexFile(
      db,
      workspacePath,
      filePath,
      options?.embeddingProvider ?? null,
      chunking,
      batching,
      settings.debug.vector
    );
  }
}
