import fs from "fs";
import path from "path";
import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { ensureSettings } from "../core/settings";
import { dailyDirPath, findExistingLongMemoryPath } from "../core/layout";

function listRecentDailyFiles(workspacePath: string, days: number): string[] {
  const dailyDir = dailyDirPath(workspacePath);
  if (!fs.existsSync(dailyDir)) {
    return [];
  }
  const files = fs
    .readdirSync(dailyDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();

  if (files.length === 0) {
    return [];
  }

  const slice = days > 0 ? files.slice(-days) : [];
  return slice.map((name) => path.join(dailyDir, name));
}

function truncateMemory(content: string, maxChars: number): { content: string; truncated: boolean } {
  if (content.length <= maxChars) {
    return { content, truncated: false };
  }
  const trimmed = content.slice(0, maxChars);
  return {
    content: `${trimmed}\n... <truncated due to max-chars=${maxChars}>`,
    truncated: true
  };
}

export function registerSummaryCommand(program: Command): void {
  program
    .command("summary")
    .description("Show MEMORY.md plus recent daily logs")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--days <n>", "Number of recent days to include (overrides settings.json)")
    .option("--max-chars <n>", "Max chars for long-term memory (overrides settings.json)")
    .option("--full", "Disable truncation of long-term memory")
    .option("--json", "JSON output")
    .action((options: {
      public?: boolean;
      token?: string;
      days?: string;
      maxChars?: string;
      full?: boolean;
      json?: boolean;
    }) => {
      const isPublic = Boolean(options.public);
      const token = options.token as string | undefined;
      if (!isPublic && !token) {
        throw new Error("Provide --public or --token.");
      }
      if (isPublic && token) {
        throw new Error("Choose either --public or --token, not both.");
      }

      const ref = resolveWorkspacePath({ isPublic, token });
      assertWorkspaceAccess(ref, token);

      const memoryPath = findExistingLongMemoryPath(ref.path);
      const memoryRaw = memoryPath ? fs.readFileSync(memoryPath, "utf8") : "";

      const settings = ensureSettings();

      const daysCandidate = Number(options.days);
      const days = Number.isFinite(daysCandidate) ? daysCandidate : settings.summary.days;

      const maxCharsCandidate = Number(options.maxChars);
      const maxChars = Number.isFinite(maxCharsCandidate) ? maxCharsCandidate : settings.summary.maxChars;

      const useFull = options.full !== undefined ? Boolean(options.full) : settings.summary.full;

      const memory = useFull ? { content: memoryRaw, truncated: false } : truncateMemory(memoryRaw, maxChars);
      const dailyFiles = listRecentDailyFiles(ref.path, days);
      const dailyLogs = dailyFiles.map((file) => ({
        file,
        content: fs.readFileSync(file, "utf8")
      }));

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              workspace: ref.path,
              memory: memory.content,
              truncated: memory.truncated,
              days,
              daily: dailyLogs
            },
            null,
            2
          )
        );
        return;
      }

      const parts: string[] = [];
      parts.push("# Summary");
      parts.push("");
      parts.push("## Long-term Memory");
      parts.push(memory.content.trim() || "(empty)");
      parts.push("");
      parts.push(`## Recent Daily Logs (last ${days} days)`);
      if (dailyLogs.length === 0) {
        parts.push("(none)");
      } else {
        for (const entry of dailyLogs) {
          parts.push(entry.content.trim());
          parts.push("");
        }
      }

      console.log(parts.join("\n").trimEnd());
    });
}
