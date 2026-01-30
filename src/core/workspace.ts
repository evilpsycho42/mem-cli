import fs from "fs";
import path from "path";
import { hashToken, tokenWorkspaceId, validateToken } from "./auth";
import { readRegistry, writeRegistry, getRootDir } from "./registry";
import { ensureSettings } from "./settings";
import {
  LEGACY_DAILY_DIRNAME,
  LEGACY_LONG_MEMORY_FILENAME,
  LONG_MEMORY_FILENAME_PRIMARY,
  MEMORY_DIRNAME,
  PRIVATE_DIRNAME,
  PUBLIC_DIRNAME,
  SETTINGS_FILENAME,
  WORKSPACE_DIRNAME,
  metaPath
} from "./layout";

export type WorkspaceType = "public" | "private";

export interface WorkspaceMeta {
  type: WorkspaceType;
  created: string;
  token_hash?: string;
}

export interface WorkspaceRef {
  path: string;
  type: WorkspaceType;
  tokenHash?: string;
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export function getPublicPath(): string {
  return path.join(getRootDir(), PUBLIC_DIRNAME);
}

export function getPrivatePath(workspaceId: string): string {
  return path.join(getRootDir(), PRIVATE_DIRNAME, workspaceId);
}

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function ensureMemoryLayout(workspacePath: string): void {
  const memoryDir = path.join(workspacePath, MEMORY_DIRNAME);
  const legacyDailyDir = path.join(workspacePath, LEGACY_DAILY_DIRNAME);
  if (!fs.existsSync(memoryDir) && fs.existsSync(legacyDailyDir)) {
    try {
      fs.renameSync(legacyDailyDir, memoryDir);
    } catch (err) {
      console.error(
        `[mem-cli] Failed to migrate legacy daily dir; falling back to file-by-file migration: ${formatErrorMessage(err)}`
      );
      ensureDir(memoryDir);
      let failedMoves = 0;
      try {
        for (const name of fs.readdirSync(legacyDailyDir)) {
          const from = path.join(legacyDailyDir, name);
          const to = path.join(memoryDir, name);
          try {
            fs.renameSync(from, to);
            continue;
          } catch {}
          try {
            fs.copyFileSync(from, to);
            fs.unlinkSync(from);
          } catch (fileErr) {
            failedMoves += 1;
            console.error(`[mem-cli] Failed to migrate legacy daily file ${from}: ${formatErrorMessage(fileErr)}`);
          }
        }
      } catch (readErr) {
        console.error(`[mem-cli] Failed to read legacy daily dir ${legacyDailyDir}: ${formatErrorMessage(readErr)}`);
      }
      if (failedMoves > 0) {
        console.error(
          `[mem-cli] Failed to migrate ${failedMoves} file(s) from ${legacyDailyDir}; leaving remaining files in place.`
        );
      }
      try {
        fs.rmdirSync(legacyDailyDir);
      } catch (rmdirErr) {
        // It's ok if the directory isn't empty due to failed moves.
        if (failedMoves === 0) {
          console.error(
            `[mem-cli] Failed to remove legacy daily dir ${legacyDailyDir}: ${formatErrorMessage(rmdirErr)}`
          );
        }
      }
    }
  }
  ensureDir(memoryDir);
}

function safeFileId(filePath: string): { dev: number; ino: number } | null {
  try {
    const stat = fs.statSync(filePath);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function ensureLongMemoryLayout(workspacePath: string): void {
  const primary = path.join(workspacePath, LONG_MEMORY_FILENAME_PRIMARY);
  const legacy = path.join(workspacePath, LEGACY_LONG_MEMORY_FILENAME);

  const primaryExists = fs.existsSync(primary);
  const legacyExists = fs.existsSync(legacy);

  // On case-insensitive filesystems, both names may appear to "exist" but be the same file.
  if (primaryExists && legacyExists) {
    const primaryId = safeFileId(primary);
    const legacyId = safeFileId(legacy);
    if (primaryId && legacyId && primaryId.dev === legacyId.dev && primaryId.ino === legacyId.ino) {
      return;
    }

    try {
      const primaryContent = fs.readFileSync(primary, "utf8");
      const legacyContent = fs.readFileSync(legacy, "utf8");
      if (primaryContent.trim() === legacyContent.trim()) {
        fs.unlinkSync(legacy);
        return;
      }
      fs.appendFileSync(
        primary,
        `\n\n<!-- migrated from legacy ${LEGACY_LONG_MEMORY_FILENAME} -->\n\n${legacyContent.trim()}\n`
      );
      fs.unlinkSync(legacy);
      return;
    } catch {
      // If anything goes wrong, keep both files as-is.
      return;
    }
  }

  if (!primaryExists && legacyExists) {
    try {
      fs.renameSync(legacy, primary);
    } catch {
      try {
        fs.copyFileSync(legacy, primary);
        fs.unlinkSync(legacy);
      } catch (err) {
        console.error(
          `[mem-cli] Failed to migrate legacy ${LEGACY_LONG_MEMORY_FILENAME} to ${LONG_MEMORY_FILENAME_PRIMARY}: ${formatErrorMessage(err)}`
        );
      }
    }
  }
}

function ensureNoWorkspaceSettings(workspacePath: string): void {
  const workspaceSettingsPath = path.join(workspacePath, SETTINGS_FILENAME);
  if (!fs.existsSync(workspaceSettingsPath)) return;
  try {
    fs.unlinkSync(workspaceSettingsPath);
  } catch {}
}

export function ensureWorkspaceLayout(workspacePath: string): void {
  ensureMemoryLayout(workspacePath);
  ensureLongMemoryLayout(workspacePath);
  ensureSettings();
  ensureNoWorkspaceSettings(workspacePath);
}

export function resolveWorkspacePath(options: { isPublic: boolean; token?: string }): WorkspaceRef {
  if (options.isPublic) {
    return { path: getPublicPath(), type: "public" };
  }
  if (!options.token) {
    throw new Error("Token is required for private workspace.");
  }

  const tokenHash = hashToken(options.token);
  const workspaceId = tokenWorkspaceId(tokenHash);
  const registry = readRegistry();
  const registeredPath = registry[workspaceId];
  const workspacePath = registeredPath
    ? registeredPath
    : getPrivatePath(workspaceId);

  return { path: workspacePath, type: "private", tokenHash };
}

export function loadMeta(workspacePath: string): WorkspaceMeta {
  const filePath = metaPath(workspacePath);
  if (!fs.existsSync(filePath)) {
    throw new Error("Workspace not initialized. Run mem init first.");
  }
  const raw = fs.readFileSync(filePath, "utf8");
  return JSON.parse(raw) as WorkspaceMeta;
}

export function writeMeta(workspacePath: string, meta: WorkspaceMeta): void {
  const filePath = metaPath(workspacePath);
  fs.writeFileSync(filePath, JSON.stringify(meta, null, 2));
}

export function assertWorkspaceAccess(ref: WorkspaceRef, token?: string): WorkspaceMeta {
  const meta = loadMeta(ref.path);
  if (meta.type !== ref.type) {
    throw new Error("Workspace type mismatch.");
  }
  if (ref.type === "private") {
    if (!token) {
      throw new Error("Token is required for private workspace.");
    }
    const tokenHash = hashToken(token);
    if (!meta.token_hash || meta.token_hash !== tokenHash) {
      throw new Error("Invalid token for workspace.");
    }
  }
  ensureWorkspaceLayout(ref.path);
  return meta;
}

export function initPublicWorkspace(): string {
  const rootDir = getRootDir();
  ensureDir(rootDir);
  const workspacePath = getPublicPath();
  ensureDir(workspacePath);
  ensureMemoryLayout(workspacePath);
  ensureLongMemoryLayout(workspacePath);

  const memoryPath = path.join(workspacePath, LONG_MEMORY_FILENAME_PRIMARY);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, "");
  }

  writeMeta(workspacePath, {
    type: "public",
    created: new Date().toISOString()
  });

  ensureSettings();
  ensureNoWorkspaceSettings(workspacePath);
  return workspacePath;
}

export function initPrivateWorkspace(token: string, customPath?: string): string {
  validateToken(token);
  const tokenHash = hashToken(token);
  const workspaceId = tokenWorkspaceId(tokenHash);
  const rootDir = getRootDir();
  ensureDir(rootDir);

  let workspacePath: string;
  if (customPath) {
    workspacePath = path.join(customPath, WORKSPACE_DIRNAME);
  } else {
    ensureDir(path.join(rootDir, PRIVATE_DIRNAME));
    workspacePath = getPrivatePath(workspaceId);
  }

  ensureDir(workspacePath);
  ensureMemoryLayout(workspacePath);
  ensureLongMemoryLayout(workspacePath);

  const memoryPath = path.join(workspacePath, LONG_MEMORY_FILENAME_PRIMARY);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, "");
  }

  writeMeta(workspacePath, {
    type: "private",
    token_hash: tokenHash,
    created: new Date().toISOString()
  });

  const registry = readRegistry();
  registry[workspaceId] = customPath ? workspacePath : null;
  writeRegistry(registry);

  ensureSettings();
  ensureNoWorkspaceSettings(workspacePath);
  return workspacePath;
}
