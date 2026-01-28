import fs from "fs";
import path from "path";
import { formatDateLocal } from "../utils/date";
import { MEMORY_DIRNAME, dailyDirPath, longMemoryCandidatePaths, resolveLongMemoryPath } from "./layout";

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function appendDailyEntry(workspacePath: string, text: string, date = new Date()): string {
  const day = formatDateLocal(date);
  const dailyDir = dailyDirPath(workspacePath);
  ensureDir(dailyDir);
  const dailyPath = path.join(dailyDir, `${day}.md`);

  if (!fs.existsSync(dailyPath)) {
    fs.writeFileSync(dailyPath, "");
  }

  const entry = text.trim();
  if (entry.length === 0) return dailyPath;
  const needsSeparator = fs.statSync(dailyPath).size > 0;
  // We always end entries with a newline, so a single leading newline yields a blank line between entries.
  fs.appendFileSync(dailyPath, `${needsSeparator ? "\n" : ""}${entry}\n`);
  return dailyPath;
}

export function appendLongMemory(workspacePath: string, text: string): string {
  const memoryPath = resolveLongMemoryPath(workspacePath);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, "");
  }
  const entry = text.trim();
  if (entry.length === 0) return memoryPath;
  const needsSeparator = fs.statSync(memoryPath).size > 0;
  fs.appendFileSync(memoryPath, `${needsSeparator ? "\n" : ""}${entry}\n`);
  return memoryPath;
}

export function listMarkdownFiles(workspacePath: string): string[] {
  const results: string[] = [];

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  };

  if (fs.existsSync(workspacePath)) {
    walk(workspacePath);
  }

  return results;
}

export function listMemoryFiles(workspacePath: string): string[] {
  const out: string[] = [];
  for (const candidate of longMemoryCandidatePaths(workspacePath)) {
    if (fs.existsSync(candidate)) out.push(candidate);
  }

  const memoryDir = path.join(workspacePath, MEMORY_DIRNAME);
  if (!fs.existsSync(memoryDir)) {
    return out;
  }

  const walk = (dir: string) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(fullPath);
      }
    }
  };
  walk(memoryDir);
  return out;
}

export function fileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
