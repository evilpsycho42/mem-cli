import fs from "fs";
import path from "path";
import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { fileSize, listMemoryFiles } from "../core/storage";
import { openDb, getIndexMeta } from "../core/index";
import { ensureSettings, settingsFilePath } from "../core/settings";
import { dailyDirPath, findExistingLongMemoryPath } from "../core/layout";
import { resolveWorkspaceSelection } from "../core/token-env";

function listDailyFiles(workspacePath: string): string[] {
  const dailyDir = dailyDirPath(workspacePath);
  if (!fs.existsSync(dailyDir)) {
    return [];
  }
  return fs
    .readdirSync(dailyDir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/.test(name))
    .sort();
}

function totalSize(dirPath: string): number {
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += totalSize(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

export function registerStateCommand(program: Command): void {
  program
    .command("state")
    .description("Show workspace stats")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--json", "JSON output")
    .action((options: { public?: boolean; token?: string; json?: boolean }) => {
      const { isPublic, token } = resolveWorkspaceSelection({
        public: options.public,
        token: options.token
      });

      const ref = resolveWorkspacePath({ isPublic, token });
      const workspaceMeta = assertWorkspaceAccess(ref, token);
      const settings = ensureSettings();
      const settingsFile = settingsFilePath();

      const memoryPath = findExistingLongMemoryPath(ref.path);
      const memorySize = memoryPath ? fileSize(memoryPath) : 0;

      const dailyFiles = listDailyFiles(ref.path);
      const dailyRange =
        dailyFiles.length > 0
          ? `${dailyFiles[0].replace(".md", "")} → ${dailyFiles[dailyFiles.length - 1].replace(".md", "")}`
          : "none";

      const db = openDb(ref.path);
      const chunkRow = db.prepare("SELECT count(*) as count FROM chunks").get() as {
        count: number;
      };
      const chunkCount = chunkRow.count;
      const indexMeta = getIndexMeta(db);
      const vectorRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("chunks_vec") as { name?: string } | undefined;
      const vectorReady = Boolean(vectorRow?.name);
      db.close();

      const sizeTotal = totalSize(ref.path);
      const markdownCount = listMemoryFiles(ref.path).length;

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              workspace: ref.path,
              settingsFile,
              type: workspaceMeta.type,
              created: workspaceMeta.created,
              longTermBytes: memorySize,
              dailyFiles: dailyFiles.length,
              dailyRange,
              totalBytes: sizeTotal,
              markdownFiles: markdownCount,
              chunking: settings.chunking,
              embeddings: settings.embeddings,
              searchDefaults: settings.search,
              summaryDefaults: settings.summary,
              indexChunks: chunkCount,
              embeddingModel: indexMeta?.model ?? null,
              embeddingDims: indexMeta?.dims ?? null,
              vectorReady
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`Workspace: ${ref.path}`);
      console.log(`Settings: ${settingsFile}`);
      console.log(`Type: ${workspaceMeta.type}`);
      console.log(`Created: ${workspaceMeta.created}`);
      console.log(`Long-term: ${memoryPath ? path.basename(memoryPath) : "none"} (${memorySize} bytes)`);
      console.log(`Daily logs: ${dailyRange} (${dailyFiles.length} files)`);
      console.log(`Total size: ${sizeTotal} bytes`);
      console.log(`Index: ${chunkCount} chunks`);
      console.log(
        `Chunking: ${settings.chunking.tokens} tokens, ${settings.chunking.overlap} overlap ` +
          `(${settings.chunking.minChars} min chars, ${settings.chunking.charsPerToken} chars/token)`
      );
      console.log(`Embedding model (configured): ${settings.embeddings.modelPath}`);
      console.log(
        `Embedding cache (configured): ${settings.embeddings.cacheDir || "(default)"}`
      );
      console.log(`Embedding model (indexed): ${indexMeta?.model ? indexMeta.model : "none"}`);
      if (indexMeta?.dims) {
        console.log(`Embedding dims: ${indexMeta.dims}`);
      }
      console.log(`Vector index: ${vectorReady ? "ready" : "unavailable"}`);
    });
}
