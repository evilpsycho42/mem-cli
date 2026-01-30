import Database from "better-sqlite3";
import { loadSqliteVecExtension } from "./sqlite-vec";

export interface SearchResult {
  id: string;
  file_path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  score: number;
  vectorScore?: number;
}

const VECTOR_TABLE = "chunks_vec";

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

const cachedVectorExtensionPathByDb = new WeakMap<Database.Database, string | undefined>();

async function ensureVecExtension(db: Database.Database): Promise<boolean> {
  const extensionPathHint = cachedVectorExtensionPathByDb.get(db);
  let loaded = await loadSqliteVecExtension({
    db,
    extensionPath: extensionPathHint
  });
  if (!loaded.ok && extensionPathHint) {
    cachedVectorExtensionPathByDb.delete(db);
    loaded = await loadSqliteVecExtension({ db });
  }
  if (!loaded.ok) return false;
  try {
    db.prepare("SELECT vec_version()").get();
    cachedVectorExtensionPathByDb.set(db, loaded.extensionPath);
    return true;
  } catch {
    cachedVectorExtensionPathByDb.delete(db);
    return false;
  }
}

function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function cosineSimilaritySameLength(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function truncateSnippet(text: string, maxChars: number): string {
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

export async function searchVector(
  db: Database.Database,
  queryVec: number[],
  limit: number,
  model: string | undefined,
  snippetMaxChars: number
): Promise<SearchResult[]> {
  if (queryVec.length === 0 || limit <= 0) return [];
  const trimmedModel = model?.trim();

  const hasVecTable =
    (db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(VECTOR_TABLE) as { name?: string } | undefined)?.name === VECTOR_TABLE;

  const vecReady = hasVecTable ? await ensureVecExtension(db) : false;

  if (hasVecTable && vecReady) {
    const stmt = db.prepare(
      `SELECT c.id, c.file_path, c.line_start, c.line_end, c.content,\n` +
        `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
        `  FROM ${VECTOR_TABLE} v\n` +
        `  JOIN chunks c ON c.id = v.id\n` +
        (trimmedModel ? ` WHERE c.model = ?\n` : "") +
        ` ORDER BY dist ASC\n` +
        ` LIMIT ?`
    );
    const rows = (trimmedModel
      ? stmt.all(vectorToBlob(queryVec), trimmedModel, limit)
      : stmt.all(vectorToBlob(queryVec), limit)) as Array<{
      id: string;
      file_path: string;
      line_start: number;
      line_end: number;
      content: string;
      dist: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      file_path: row.file_path,
      line_start: row.line_start,
      line_end: row.line_end,
      snippet: truncateSnippet(row.content, snippetMaxChars),
      score: 1 - row.dist,
      vectorScore: 1 - row.dist
    }));
  }

  const rows = db
    .prepare(
      `SELECT id, file_path, line_start, line_end, content, embedding FROM chunks` +
        (trimmedModel ? " WHERE model = ?" : "")
    )
    .all(...(trimmedModel ? [trimmedModel] : [])) as Array<{
    id: string;
    file_path: string;
    line_start: number;
    line_end: number;
    content: string;
    embedding: string;
  }>;

  let warnedDimMismatch = false;
  return rows
    .map((row) => {
      const embedding = parseEmbedding(row.embedding);
      if (embedding.length !== queryVec.length) {
        if (!warnedDimMismatch) {
          console.error(
            `[mem-cli] Embedding dimension mismatch (query=${queryVec.length}, row=${embedding.length}); treating mismatched rows as score=0. Consider reindexing.`
          );
          warnedDimMismatch = true;
        }
        return { row, score: 0 };
      }
      return { row, score: cosineSimilaritySameLength(queryVec, embedding) };
    })
    .filter((entry) => Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => ({
      id: entry.row.id,
      file_path: entry.row.file_path,
      line_start: entry.row.line_start,
      line_end: entry.row.line_end,
      snippet: truncateSnippet(entry.row.content, snippetMaxChars),
      score: entry.score,
      vectorScore: entry.score
    }));
}
