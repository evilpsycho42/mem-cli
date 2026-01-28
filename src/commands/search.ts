import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { openDb, ensureIndexUpToDate } from "../core/index";
import { searchHybrid } from "../core/search";
import { buildQueryInstruction, getEmbeddingProvider } from "../core/embeddings";
import { ensureSettings, settingsFilePath } from "../core/settings";

export function registerSearchCommand(program: Command): void {
  program
    .command("search <query...>")
    .description("Search memory (hybrid)")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--limit <n>", "Limit number of results (overrides settings.json)")
    .option("--vector-weight <n>", "Hybrid vector weight (0..1, overrides settings.json)")
    .option("--text-weight <n>", "Hybrid text weight (0..1, overrides settings.json)")
    .option("--candidate-multiplier <n>", "Hybrid candidate multiplier (overrides settings.json)")
    .option("--json", "JSON output")
    .action(
      async (
        queryParts: string[],
        options: {
          public?: boolean;
          token?: string;
          limit?: string;
          vectorWeight?: string;
          textWeight?: string;
          candidateMultiplier?: string;
          json?: boolean;
        }
      ) => {
        const query = (queryParts ?? []).join(" ").trim();
        if (!query) {
          throw new Error("Provide a search query.");
        }
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

        const settings = ensureSettings();

        const limitCandidate = Number(options.limit);
        const limit = Number.isFinite(limitCandidate) && limitCandidate > 0 ? limitCandidate : settings.search.limit;

        const vectorWeightRaw =
          options.vectorWeight !== undefined ? Number(options.vectorWeight) : settings.search.vectorWeight;
        const textWeightRaw =
          options.textWeight !== undefined ? Number(options.textWeight) : settings.search.textWeight;

        const baseVectorWeight = Number.isFinite(vectorWeightRaw) ? Math.max(0, vectorWeightRaw) : 0;
        const baseTextWeight = Number.isFinite(textWeightRaw) ? Math.max(0, textWeightRaw) : 0;

        const sumWeights = baseVectorWeight + baseTextWeight;
        const vectorWeight = sumWeights > 0 ? baseVectorWeight / sumWeights : settings.search.vectorWeight;
        const textWeight = sumWeights > 0 ? baseTextWeight / sumWeights : settings.search.textWeight;

        const candidateMultiplierRaw = Number(options.candidateMultiplier);
        const candidateMultiplier = Number.isFinite(candidateMultiplierRaw) && candidateMultiplierRaw > 0
          ? candidateMultiplierRaw
          : settings.search.candidateMultiplier;

        const maxCandidates = settings.search.maxCandidates;
        const snippetMaxChars = settings.search.snippetMaxChars;

        const db = openDb(ref.path);

        const provider = await getEmbeddingProvider(settings);
        await ensureIndexUpToDate(db, ref.path, { embeddingProvider: provider });

        const queryVec = await provider.embedQuery(
          buildQueryInstruction(query, settings.embeddings.queryInstructionTemplate)
        );
        const results = await searchHybrid({
          db,
          query,
          queryVec,
          limit,
          vectorWeight,
          textWeight,
          candidateMultiplier,
          maxCandidates,
          snippetMaxChars,
          model: provider.modelPath
        });

        db.close();

        if (options.json) {
          console.log(
            JSON.stringify(
              {
                query,
                limit,
                vectorWeight,
                textWeight,
                candidateMultiplier,
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
      }
    );
}
