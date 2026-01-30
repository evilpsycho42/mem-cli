import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { appendDailyEntry, appendLongMemory } from "../core/storage";
import { ensureIndexUpToDate, openDb } from "../core/index";
import { tryGetEmbeddingProvider } from "../core/embeddings";
import { ensureSettings } from "../core/settings";
import { readStdinUtf8 } from "../core/stdin";
import { resolveWorkspaceSelection } from "../core/token-env";

function resolveAccess(options: { public?: boolean; token?: string }) {
  const { isPublic, token } = resolveWorkspaceSelection({
    public: options.public,
    token: options.token
  });
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
        const { ref, isPublic } = resolveAccess(options);
        const text = options.stdin
          ? readStdinUtf8()
          : (textParts ?? []).join(" ");
        if (!text || text.trim().length === 0) {
          throw new Error("Provide text (e.g. `mem add short ...`) or use --stdin.");
        }
        const filePath = appendDailyEntry(ref.path, text);

        const db = openDb(ref.path);
        try {
          const settings = ensureSettings();
          const { provider, error } = await tryGetEmbeddingProvider(settings);
          if (!provider) {
            console.error("[mem-cli] embeddings unavailable; memory was written but not indexed.");
            if (error) console.error(error);
          } else {
            try {
              await ensureIndexUpToDate(db, ref.path, { embeddingProvider: provider });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[mem-cli] embeddings failed during indexing; memory was written but not indexed.");
              console.error(message);
            }
          }
        } finally {
          db.close();
        }

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
        const { ref, isPublic } = resolveAccess(options);
        const text = options.stdin
          ? readStdinUtf8()
          : (textParts ?? []).join(" ");
        if (!text || text.trim().length === 0) {
          throw new Error("Provide text (e.g. `mem add long ...`) or use --stdin.");
        }
        const filePath = appendLongMemory(ref.path, text);

        const db = openDb(ref.path);
        try {
          const settings = ensureSettings();
          const { provider, error } = await tryGetEmbeddingProvider(settings);
          if (!provider) {
            console.error("[mem-cli] embeddings unavailable; memory was written but not indexed.");
            if (error) console.error(error);
          } else {
            try {
              await ensureIndexUpToDate(db, ref.path, { embeddingProvider: provider });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              console.error("[mem-cli] embeddings failed during indexing; memory was written but not indexed.");
              console.error(message);
            }
          }
        } finally {
          db.close();
        }

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
