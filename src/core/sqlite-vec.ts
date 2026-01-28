import type Database from "better-sqlite3";

export async function loadSqliteVecExtension(params: {
  db: Database.Database;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const sqliteVec = await import("sqlite-vec");
    const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();
    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else if (typeof sqliteVec.load === "function") {
      sqliteVec.load(params.db);
    } else {
      params.db.loadExtension(extensionPath);
    }
    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
