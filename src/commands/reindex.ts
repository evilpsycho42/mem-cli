import { Command } from "commander";
import fs from "fs";
import path from "path";
import { resolveWorkspacePath, assertWorkspaceAccess, ensureWorkspaceLayout, loadMeta } from "../core/workspace";
import { ensureIndexUpToDate, indexNeedsUpdate, openDb, reindexWorkspace } from "../core/index";
import { tryGetEmbeddingProvider } from "../core/embeddings";
import { ensureSettings } from "../core/settings";
import { getRootDir, readRegistry } from "../core/registry";
import { PRIVATE_DIRNAME, PUBLIC_DIRNAME } from "../core/layout";
import { MEM_CLI_TOKEN_ENV, readMemCliTokenEnv, resolveWorkspaceSelection } from "../core/token-env";

export function registerReindexCommand(program: Command): void {
  program
    .command("reindex")
    .description("Ensure the semantic index is up to date (vector)")
    .option("--all", "Reindex all workspaces (public + any existing private workspaces)")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--force", "Force a full rebuild even if up to date")
    .option("--json", "JSON output")
    .action(async (options: { all?: boolean; public?: boolean; token?: string; force?: boolean; json?: boolean }) => {
      const isAll = Boolean(options.all);
      const hasPublic = Boolean(options.public);
      const explicitToken = options.token as string | undefined;

      if (isAll) {
        if (hasPublic || explicitToken) {
          throw new Error("Use either --all, or --public/--token.");
        }
      } else {
        if (!hasPublic && !explicitToken && !readMemCliTokenEnv()) {
          throw new Error(`Provide --all, --public, or --token (or set ${MEM_CLI_TOKEN_ENV}).`);
        }
      }

      const settings = ensureSettings();
      const { provider, error } = await tryGetEmbeddingProvider(settings);
      if (!provider) {
        throw new Error(error || "Embeddings unavailable.");
      }

      const force = Boolean(options.force);

      const runForWorkspace = async (workspacePath: string): Promise<{
        workspace: string;
        status: "up-to-date" | "updated" | "reindexed";
      }> => {
        ensureWorkspaceLayout(workspacePath);
        const db = openDb(workspacePath);
        try {
          if (!force) {
            const needs = await indexNeedsUpdate(db, workspacePath, provider);
            if (!needs) return { workspace: workspacePath, status: "up-to-date" };
            await ensureIndexUpToDate(db, workspacePath, { embeddingProvider: provider });
            return { workspace: workspacePath, status: "updated" };
          }

          await reindexWorkspace(db, workspacePath, { embeddingProvider: provider });
          return { workspace: workspacePath, status: "reindexed" };
        } finally {
          db.close();
        }
      };

      const listAllWorkspaces = (): string[] => {
        const rootDir = getRootDir();
        const privateDir = path.join(rootDir, PRIVATE_DIRNAME);
        const candidates = new Set<string>();

        candidates.add(path.join(rootDir, PUBLIC_DIRNAME));

        if (fs.existsSync(privateDir)) {
          try {
            const entries = fs.readdirSync(privateDir, { withFileTypes: true });
            for (const entry of entries) {
              if (!entry.isDirectory()) continue;
              candidates.add(path.join(privateDir, entry.name));
            }
          } catch {}
        }

        try {
          const registry = readRegistry();
          for (const [workspaceId, registryPath] of Object.entries(registry)) {
            if (typeof registryPath === "string" && registryPath.trim().length > 0) {
              candidates.add(registryPath);
            } else if (workspaceId) {
              candidates.add(path.join(privateDir, workspaceId));
            }
          }
        } catch {}

        const existing: string[] = [];
        for (const candidate of candidates) {
          try {
            loadMeta(candidate);
            existing.push(candidate);
          } catch {}
        }

        return existing.sort();
      };

      const results: Array<{ workspace: string; status: "up-to-date" | "updated" | "reindexed" }> = [];

      if (isAll) {
        for (const workspacePath of listAllWorkspaces()) {
          results.push(await runForWorkspace(workspacePath));
        }
      } else {
        const { isPublic, token } = resolveWorkspaceSelection({
          public: options.public,
          token: options.token
        });
        const ref = resolveWorkspacePath({ isPublic, token });
        assertWorkspaceAccess(ref, token);
        results.push(await runForWorkspace(ref.path));
      }

      if (options.json) {
        console.log(JSON.stringify(isAll ? { workspaces: results } : results[0], null, 2));
        return;
      }

      if (!isAll) {
        const status = results[0]?.status ?? "updated";
        console.log(status === "up-to-date" ? "Index already up to date." : "Index updated.");
        return;
      }

      const updated = results.filter((r) => r.status !== "up-to-date").length;
      const total = results.length;
      console.log(updated === 0 ? `All ${total} workspaces already up to date.` : `Updated ${updated}/${total} workspaces.`);
    });
}
