import fs from "fs";
import path from "path";
import { formatDateLocal, formatTimeLocal } from "../utils/date";
import { MEMORY_DIRNAME, dailyDirPath, longMemoryCandidatePaths, resolveLongMemoryPath } from "./layout";

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function appendDailyEntry(workspacePath: string, text: string, date = new Date()): string {
  const day = formatDateLocal(date);
  const time = formatTimeLocal(date);
  const dailyDir = dailyDirPath(workspacePath);
  ensureDir(dailyDir);
  const dailyPath = path.join(dailyDir, `${day}.md`);

  if (!fs.existsSync(dailyPath)) {
    fs.writeFileSync(dailyPath, `# ${day}\n\n`);
  }

  const entry = `## ${time}\n${text.trim()}\n`;
  fs.appendFileSync(dailyPath, `\n${entry}`);
  return dailyPath;
}

export function appendLongMemory(workspacePath: string, text: string): string {
  const memoryPath = resolveLongMemoryPath(workspacePath);
  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, "# Long-term Memory\n");
  }
  fs.appendFileSync(memoryPath, `\n\n${text.trim()}\n`);
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
