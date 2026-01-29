import path from "path";
import crypto from "crypto";
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

let providerCreateCount = 0;
let llamaInitCount = 0;
let modelLoadCount = 0;
let contextCreateCount = 0;

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

export function getEmbeddingsDebugStats(): {
  providerCacheSize: number;
  providerCreateCount: number;
  llamaInitCount: number;
  modelLoadCount: number;
  contextCreateCount: number;
  mockEnabled: boolean;
} {
  return {
    providerCacheSize: cachedProviders.size,
    providerCreateCount,
    llamaInitCount,
    modelLoadCount,
    contextCreateCount,
    mockEnabled: truthyEnv(process.env.MEM_CLI_EMBEDDINGS_MOCK)
  };
}

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

  providerCreateCount += 1;
  const providerPromise = (async () => {
    if (truthyEnv(process.env.MEM_CLI_EMBEDDINGS_MOCK)) {
      const dims = Math.max(1, Math.floor(Number(process.env.MEM_CLI_EMBEDDINGS_MOCK_DIMS) || 8));
      const loadMs = Math.max(
        0,
        Math.floor(Number(process.env.MEM_CLI_EMBEDDINGS_MOCK_LOAD_MS) || 200)
      );
      let contextPromise: Promise<boolean> | null = null;

      const ensureContext = async () => {
        if (!contextPromise) {
          modelLoadCount += 1;
          contextCreateCount += 1;
          contextPromise = (async () => {
            if (loadMs > 0) {
              await new Promise((r) => setTimeout(r, loadMs));
            }
            return true;
          })();
        }
        return contextPromise;
      };

      const embedText = (text: string): number[] => {
        const buf = crypto.createHash("sha256").update(String(text || ""), "utf8").digest();
        const vec: number[] = [];
        for (let i = 0; i < dims; i += 1) {
          const v = buf[i % buf.length] ?? 0;
          vec.push(v / 127.5 - 1);
        }
        const norm = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
        return vec.map((v) => v / norm);
      };

      return {
        modelPath,
        embedQuery: async (text: string) => {
          await ensureContext();
          return embedText(text);
        },
        embedBatch: async (texts: string[]) => {
          await ensureContext();
          return texts.map((t) => embedText(t));
        }
      };
    }

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

    let llamaPromise: Promise<any> | null = null;
    let modelPromise: Promise<any> | null = null;
    let ctxPromise: Promise<any> | null = null;

    const ensureContext = async () => {
      if (!llamaPromise) {
        llamaInitCount += 1;
        llamaPromise = getLlama({ logLevel: LlamaLogLevel.error });
      }
      const llama = await llamaPromise;

      if (!modelPromise) {
        modelLoadCount += 1;
        modelPromise = (async () => {
          const resolved = await resolveModelFile(modelPath, cacheDir || undefined);
          return llama.loadModel({ modelPath: resolved });
        })();
      }
      const model = await modelPromise;

      if (!ctxPromise) {
        contextCreateCount += 1;
        ctxPromise = model.createEmbeddingContext();
      }
      return ctxPromise;
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
