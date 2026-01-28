import path from "path";
import { importNodeLlamaCpp } from "./node-llama";
import type { Settings } from "./settings";
import { DEFAULT_SETTINGS } from "./settings";
import { getRootDir } from "./registry";

export type EmbeddingProvider = {
  modelPath: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

const cachedProviders = new Map<string, Promise<EmbeddingProvider>>();

function isRemoteModelSpecifier(spec: string): boolean {
  return /^(hf:|https?:)/i.test(spec);
}

function resolveUserPath(raw: string, baseDir: string): string {
  if (!raw) return raw;
  if (raw.startsWith("~")) {
    return path.join(process.env.HOME || "", raw.slice(1));
  }
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(baseDir, raw);
}

export function buildQueryInstruction(query: string, template?: string): string {
  const base =
    template && template.trim().length > 0
      ? template
      : DEFAULT_SETTINGS.embeddings.queryInstructionTemplate;
  return base.replaceAll("{query}", query.trim());
}

export async function getEmbeddingProvider(
  settings: Settings
): Promise<EmbeddingProvider> {
  const baseDir = getRootDir();
  const rawModelPath = settings.embeddings.modelPath ?? "";
  if (!rawModelPath.trim()) {
    throw new Error("settings.embeddings.modelPath is required (local embeddings)");
  }
  const modelPath = isRemoteModelSpecifier(rawModelPath)
    ? rawModelPath
    : resolveUserPath(rawModelPath, baseDir);
  const cacheDirRaw = settings.embeddings.cacheDir?.trim();
  const cacheDir = cacheDirRaw ? resolveUserPath(cacheDirRaw, baseDir) : null;
  const cacheKey = JSON.stringify({
    modelPath,
    cacheDir
  });
  const existing = cachedProviders.get(cacheKey);
  if (existing) return existing;

  const providerPromise = (async () => {
    let llamaModule: unknown;
    try {
      llamaModule = await importNodeLlamaCpp();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Local embeddings unavailable. Optional dependency node-llama-cpp is missing or failed to load.\n${message}`
      );
    }
    const { getLlama, LlamaLogLevel, resolveModelFile } = llamaModule as {
      getLlama: (opts: { logLevel: number }) => Promise<{
        loadModel: (opts: { modelPath: string }) => Promise<{
          createEmbeddingContext: () => Promise<{
            getEmbeddingFor: (text: string) => Promise<{ vector: Float32Array }>;
          }>;
        }>;
      }>;
      resolveModelFile: (modelPath: string, cacheDir?: string) => Promise<string>;
      LlamaLogLevel: { error: number };
    };

    let llama: any = null;
    let model: any = null;
    let ctx: any = null;

    const ensureContext = async () => {
      if (!llama) {
        llama = await getLlama({ logLevel: LlamaLogLevel.error });
      }
      if (!model) {
        const resolved = await resolveModelFile(modelPath, cacheDir || undefined);
        model = await llama.loadModel({ modelPath: resolved });
      }
      if (!ctx) {
        ctx = await model.createEmbeddingContext();
      }
      return ctx;
    };

    return {
      modelPath,
      embedQuery: async (text: string) => {
        const context = await ensureContext();
        const embedding = await context.getEmbeddingFor(text);
        return Array.from(embedding.vector) as number[];
      },
      embedBatch: async (texts: string[]) => {
        const context = await ensureContext();
        const embeddings = await Promise.all(
          texts.map(async (text) => {
            const embedding = await context.getEmbeddingFor(text);
            return Array.from(embedding.vector) as number[];
          })
        );
        return embeddings;
      }
    };
  })();

  cachedProviders.set(cacheKey, providerPromise);
  return providerPromise;
}

export async function tryGetEmbeddingProvider(
  settings: Settings
): Promise<{ provider: EmbeddingProvider | null; error?: string }> {
  try {
    const provider = await getEmbeddingProvider(settings);
    return { provider };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { provider: null, error: message };
  }
}
