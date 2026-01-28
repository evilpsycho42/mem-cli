import fs from "fs";
import path from "path";

export const APP_DIRNAME = ".mem-cli";
export const WORKSPACE_DIRNAME = ".mem-cli";
export const PUBLIC_DIRNAME = "public";
export const PRIVATE_DIRNAME = "private";
export const SETTINGS_FILENAME = "settings.json";
export const INDEX_DB_FILENAME = "index.db";
export const META_FILENAME = "meta.json";
export const REGISTRY_FILENAME = "registry.json";

export const MEMORY_DIRNAME = "memory";
export const LEGACY_DAILY_DIRNAME = "daily";
export const LONG_MEMORY_FILENAME_PRIMARY = "MEMORY.md";
export const LEGACY_LONG_MEMORY_FILENAME = "memory.md";

export function settingsPath(workspacePath: string): string {
  return path.join(workspacePath, SETTINGS_FILENAME);
}

export function indexDbPath(workspacePath: string): string {
  return path.join(workspacePath, INDEX_DB_FILENAME);
}

export function metaPath(workspacePath: string): string {
  return path.join(workspacePath, META_FILENAME);
}

export function dailyDirPath(workspacePath: string): string {
  return path.join(workspacePath, MEMORY_DIRNAME);
}

export function longMemoryCandidatePaths(workspacePath: string): string[] {
  return [path.join(workspacePath, LONG_MEMORY_FILENAME_PRIMARY)];
}

export function findExistingLongMemoryPath(workspacePath: string): string | null {
  for (const candidate of longMemoryCandidatePaths(workspacePath)) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function resolveLongMemoryPath(workspacePath: string): string {
  return findExistingLongMemoryPath(workspacePath) ?? path.join(workspacePath, LONG_MEMORY_FILENAME_PRIMARY);
}
