import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { openDb, reindexWorkspace } from "../core/index";
import { getEmbeddingProvider } from "../core/embeddings";
import { ensureSettings } from "../core/settings";

export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description("Rebuild the search index (FTS + vector)")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--json", "JSON output")
    .action(async (options: { public?: boolean; token?: string; json?: boolean }) => {
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

      const db = openDb(ref.path);
      const settings = ensureSettings();
      const provider = await getEmbeddingProvider(settings);
      await reindexWorkspace(db, ref.path, { embeddingProvider: provider });
      db.close();

      if (options.json) {
        console.log(JSON.stringify({ workspace: ref.path, status: "reindexed" }, null, 2));
        return;
      }

      console.log("Reindex complete.");
    });
}
