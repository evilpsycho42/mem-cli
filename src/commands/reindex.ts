import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { openDb, reindexWorkspace } from "../core/index";
import { tryGetEmbeddingProvider } from "../core/embeddings";
import { ensureSettings } from "../core/settings";

export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description("Rebuild the search index (FTS + vector when available)")
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
      const { provider, error } = await tryGetEmbeddingProvider(settings);
      if (!provider && error) {
        console.error("[mem-cli] embeddings unavailable; reindexing keywords only.");
        console.error(error);
      }
      try {
        await reindexWorkspace(db, ref.path, { embeddingProvider: provider });
      } catch (err) {
        if (!provider) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error("[mem-cli] embeddings failed during reindex; retrying keywords only.");
        console.error(message);
        await reindexWorkspace(db, ref.path, { embeddingProvider: null });
      }
      db.close();

      if (options.json) {
        console.log(JSON.stringify({ workspace: ref.path, status: "reindexed" }, null, 2));
        return;
      }

      console.log("Reindex complete.");
    });
}
