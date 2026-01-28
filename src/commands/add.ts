import { Command } from "commander";
import fs from "fs";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { appendDailyEntry, appendLongMemory } from "../core/storage";
import { ensureIndexUpToDate, openDb } from "../core/index";
import { getEmbeddingProvider } from "../core/embeddings";
import { ensureSettings } from "../core/settings";

function resolveAccess(options: { public?: boolean; token?: string }) {
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
  return { ref, token, isPublic };
}

export function registerAddCommand(program: Command): void {
  const add = program.command("add").description("Add memory entries");

  add
    .command("short [text...]")
    .description("Append a short entry to today's daily log")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--stdin", "Read entry text from stdin")
    .option("--json", "JSON output")
    .action(
      async (
        textParts: string[] | undefined,
        options: { public?: boolean; token?: string; stdin?: boolean; json?: boolean }
      ) => {
        const { ref, token, isPublic } = resolveAccess(options);
        const text = options.stdin
          ? fs.readFileSync(0, "utf8")
          : (textParts ?? []).join(" ");
        if (!text || text.trim().length === 0) {
          throw new Error("Provide text (e.g. `mem add short ...`) or use --stdin.");
        }
        const filePath = appendDailyEntry(ref.path, text);

        const db = openDb(ref.path);
        const settings = ensureSettings();
        const provider = await getEmbeddingProvider(settings);
        await ensureIndexUpToDate(db, ref.path, { embeddingProvider: provider });
        db.close();

        if (options.json) {
          console.log(
            JSON.stringify(
              { file: filePath, workspace: ref.path, type: isPublic ? "public" : "private" },
              null,
              2
            )
          );
          return;
        }
        console.log(`Added entry to ${filePath}`);
      }
    );

  add
    .command("long [text...]")
    .description("Append text to MEMORY.md")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--stdin", "Read entry text from stdin")
    .option("--json", "JSON output")
    .action(
      async (
        textParts: string[] | undefined,
        options: { public?: boolean; token?: string; stdin?: boolean; json?: boolean }
      ) => {
        const { ref, token, isPublic } = resolveAccess(options);
        const text = options.stdin
          ? fs.readFileSync(0, "utf8")
          : (textParts ?? []).join(" ");
        if (!text || text.trim().length === 0) {
          throw new Error("Provide text (e.g. `mem add long ...`) or use --stdin.");
        }
        const filePath = appendLongMemory(ref.path, text);

        const db = openDb(ref.path);
        const settings = ensureSettings();
        const provider = await getEmbeddingProvider(settings);
        await ensureIndexUpToDate(db, ref.path, { embeddingProvider: provider });
        db.close();

        if (options.json) {
          console.log(
            JSON.stringify(
              { file: filePath, workspace: ref.path, type: isPublic ? "public" : "private" },
              null,
              2
            )
          );
          return;
        }
        console.log(`Appended to ${filePath}`);
      }
    );
}
