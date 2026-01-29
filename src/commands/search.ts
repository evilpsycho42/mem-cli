import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { openDb, ensureIndexUpToDate } from "../core/index";
import { searchVector } from "../core/search";
import { buildQueryInstruction, tryGetEmbeddingProvider } from "../core/embeddings";
import { ensureSettings, settingsFilePath } from "../core/settings";
import { resolveWorkspaceSelection } from "../core/token-env";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query...>")
    .description("Search memory (semantic)")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--limit <n>", "Limit number of results (overrides settings.json)")
    .option("--json", "JSON output")
    .action(
      async (
        queryParts: string[],
        options: {
          public?: boolean;
          token?: string;
          limit?: string;
          json?: boolean;
        }
      ) => {
        const query = (queryParts ?? []).join(" ").trim();
        if (!query) {
          throw new Error("Provide a search query.");
        }
        const { isPublic, token } = resolveWorkspaceSelection({
          public: options.public,
          token: options.token
        });

        const ref = resolveWorkspacePath({ isPublic, token });
        assertWorkspaceAccess(ref, token);

        const settings = ensureSettings();

        const limitCandidate = Number(options.limit);
        const limit = Number.isFinite(limitCandidate) && limitCandidate > 0 ? limitCandidate : settings.search.limit;
        const snippetMaxChars = settings.search.snippetMaxChars;

        const db = openDb(ref.path);
        try {
          const providerResult = await tryGetEmbeddingProvider(settings);
          const provider = providerResult.provider;
          if (!provider) {
            throw new Error(providerResult.error || "Embeddings unavailable.");
          }
          await ensureIndexUpToDate(db, ref.path, { embeddingProvider: provider });
          const queryVec = await provider.embedQuery(
            buildQueryInstruction(query, settings.embeddings.queryInstructionTemplate)
          );
          const results = await searchVector(db, queryVec, limit, provider.modelPath, snippetMaxChars);

          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  query,
                  limit,
                  settingsFile: settingsFilePath(),
                  results
                },
                null,
                2
              )
            );
            return;
          }

          if (results.length === 0) {
            console.log("No results.");
            return;
          }

          console.log(`Found ${results.length} result(s):`);
          for (const result of results) {
            console.log(`${result.file_path}:${result.line_start}-${result.line_end}`);
            console.log(result.snippet);
            console.log(`score: ${result.score.toFixed(4)}`);
            console.log("");
          }
        } finally {
          db.close();
        }
      }
    );
}
