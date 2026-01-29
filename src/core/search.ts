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

let cachedVectorExtensionPath: string | undefined;

async function ensureVecExtension(db: Database.Database): Promise<boolean> {
  const loaded = await loadSqliteVecExtension({
    db,
    extensionPath: cachedVectorExtensionPath
  });
  if (!loaded.ok) return false;
  cachedVectorExtensionPath = loaded.extensionPath;
  try {
    db.prepare("SELECT vec_version()").get();
    return true;
  } catch {
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

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
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

  return rows
    .map((row) => ({
      row,
      score: cosineSimilarity(queryVec, parseEmbedding(row.embedding))
    }))
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
