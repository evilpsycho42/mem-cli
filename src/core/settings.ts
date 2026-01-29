import fs from "fs";
import path from "path";
import { APP_DIRNAME, PRIVATE_DIRNAME, PUBLIC_DIRNAME, SETTINGS_FILENAME } from "./layout";
import { getRootDir, readRegistry } from "./registry";

const DEFAULT_EMBEDDING_MODEL =
  "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
const DEFAULT_EMBEDDING_CACHE_DIR = `~/${APP_DIRNAME}/model-cache`;

export type Settings = {
  version: 3;
  chunking: {
    tokens: number;
    overlap: number;
    minChars: number;
    charsPerToken: number;
  };
  embeddings: {
    modelPath: string;
    cacheDir: string;
    batchMaxTokens: number;
    approxCharsPerToken: number;
    cacheLookupBatchSize: number;
    queryInstructionTemplate: string;
  };
  search: {
    limit: number;
    snippetMaxChars: number;
  };
  summary: {
    days: number;
    maxChars: number;
    full: boolean;
  };
  debug: {
    vector: boolean;
  };
};

export const DEFAULT_SETTINGS: Settings = {
  version: 3,
  chunking: { tokens: 400, overlap: 80, minChars: 32, charsPerToken: 4 },
  embeddings: {
    modelPath: DEFAULT_EMBEDDING_MODEL,
    cacheDir: DEFAULT_EMBEDDING_CACHE_DIR,
    batchMaxTokens: 8000,
    approxCharsPerToken: 1,
    cacheLookupBatchSize: 400,
    queryInstructionTemplate:
      "Instruct: Given a memory search query, retrieve relevant memory snippets that answer the query\nQuery: {query}"
  },
  search: {
    limit: 10,
    snippetMaxChars: 700
  },
  summary: {
    days: 7,
    maxChars: 8000,
    full: false
  },
  debug: {
    vector: false
  }
};

export function settingsFilePath(): string {
  return path.join(getRootDir(), SETTINGS_FILENAME);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function cleanupWorkspaceSettingsFiles(rootDir: string, globalSettingsPath: string): void {
  const candidates = new Set<string>();

  candidates.add(path.join(rootDir, PUBLIC_DIRNAME, SETTINGS_FILENAME));

  const privateDir = path.join(rootDir, PRIVATE_DIRNAME);
  if (fs.existsSync(privateDir)) {
    try {
      const entries = fs.readdirSync(privateDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        candidates.add(path.join(privateDir, entry.name, SETTINGS_FILENAME));
      }
    } catch {}
  }

  try {
    const registry = readRegistry();
    for (const workspacePath of Object.values(registry)) {
      if (!workspacePath) continue;
      candidates.add(path.join(workspacePath, SETTINGS_FILENAME));
    }
  } catch {}

  candidates.delete(globalSettingsPath);
  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) safeUnlink(filePath);
  }
}

function assertNoUnknownKeys(obj: Record<string, unknown>, allowed: string[], prefix: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      throw new Error(`Unknown ${prefix} key: ${key}`);
    }
  }
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function toBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeSettings(raw: unknown): { settings: Settings; changed: boolean } {
  const out: Settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
  let changed = false;

  if (!isObject(raw)) {
    return { settings: out, changed: true };
  }

  assertNoUnknownKeys(raw, ["version", "chunking", "embeddings", "search", "summary", "debug"], "settings");

  const version = raw.version;
  const fromVersion = version === 3 ? 3 : version === 2 ? 2 : 1;
  if (version === undefined) {
    changed = true;
  } else if (version !== 1 && version !== 2 && version !== 3) {
    throw new Error(`Unsupported settings.version: ${String(version)}`);
  }
  if (fromVersion < 3) {
    // We always write v3 going forward.
    changed = true;
  }

  const chunkingRaw = raw.chunking;
  if (chunkingRaw === undefined) {
    changed = true;
  } else if (isObject(chunkingRaw)) {
    assertNoUnknownKeys(chunkingRaw, ["tokens", "overlap", "minChars", "charsPerToken"], "settings.chunking");
    const tokens = toNumber(chunkingRaw.tokens);
    const overlap = toNumber(chunkingRaw.overlap);
    const minChars = toNumber(chunkingRaw.minChars);
    const charsPerToken = toNumber(chunkingRaw.charsPerToken);

    if (chunkingRaw.tokens === undefined) changed = true;
    if (tokens !== null) {
      out.chunking.tokens = clampInt(tokens, 1, 10_000);
      if (out.chunking.tokens !== tokens) changed = true;
    } else if (chunkingRaw.tokens !== undefined) {
      throw new Error("settings.chunking.tokens must be a number");
    }
    if (chunkingRaw.overlap === undefined) changed = true;
    if (overlap !== null) {
      const clampedTokens = out.chunking.tokens;
      out.chunking.overlap = clampInt(overlap, 0, Math.max(0, clampedTokens - 1));
      if (out.chunking.overlap !== overlap) changed = true;
    } else if (chunkingRaw.overlap !== undefined) {
      throw new Error("settings.chunking.overlap must be a number");
    }

    if (chunkingRaw.minChars === undefined) changed = true;
    if (minChars !== null) {
      out.chunking.minChars = clampInt(minChars, 1, 1_000_000);
      if (out.chunking.minChars !== minChars) changed = true;
    } else if (chunkingRaw.minChars !== undefined) {
      throw new Error("settings.chunking.minChars must be a number");
    }

    if (chunkingRaw.charsPerToken === undefined) changed = true;
    if (charsPerToken !== null) {
      out.chunking.charsPerToken = Math.min(100, Math.max(1, Math.floor(charsPerToken)));
      if (out.chunking.charsPerToken !== charsPerToken) changed = true;
    } else if (chunkingRaw.charsPerToken !== undefined) {
      throw new Error("settings.chunking.charsPerToken must be a number");
    }
  } else if (raw.chunking !== undefined) {
    throw new Error("settings.chunking must be an object");
  }

  const embeddingsRaw = raw.embeddings;
  if (embeddingsRaw === undefined) {
    changed = true;
  } else if (isObject(embeddingsRaw)) {
    const allowedEmbeddingKeys =
      fromVersion === 1
        ? [
            "mode",
            "modelPath",
            "cacheDir",
            "batchMaxTokens",
            "approxCharsPerToken",
            "cacheLookupBatchSize",
            "queryInstructionTemplate"
          ]
        : [
            "modelPath",
            "cacheDir",
            "batchMaxTokens",
            "approxCharsPerToken",
            "cacheLookupBatchSize",
            "queryInstructionTemplate"
          ];
    assertNoUnknownKeys(
      embeddingsRaw,
      allowedEmbeddingKeys,
      "settings.embeddings"
    );
    if (fromVersion === 1 && embeddingsRaw.mode !== undefined) {
      // Removed in v2; keep migration explicit by rewriting the file without it.
      changed = true;
    }

    if (typeof embeddingsRaw.modelPath === "string") {
      out.embeddings.modelPath = embeddingsRaw.modelPath;
    } else if (embeddingsRaw.modelPath !== undefined) {
      throw new Error("settings.embeddings.modelPath must be a string");
    }
    if (embeddingsRaw.modelPath === undefined) changed = true;

    if (typeof embeddingsRaw.cacheDir === "string") {
      out.embeddings.cacheDir = embeddingsRaw.cacheDir;
    } else if (embeddingsRaw.cacheDir !== undefined) {
      throw new Error("settings.embeddings.cacheDir must be a string");
    }
    if (embeddingsRaw.cacheDir === undefined) changed = true;

    const batchMaxTokens = toNumber(embeddingsRaw.batchMaxTokens);
    if (embeddingsRaw.batchMaxTokens === undefined) changed = true;
    if (batchMaxTokens !== null) {
      out.embeddings.batchMaxTokens = clampInt(batchMaxTokens, 1, 1_000_000);
      if (out.embeddings.batchMaxTokens !== batchMaxTokens) changed = true;
    } else if (embeddingsRaw.batchMaxTokens !== undefined) {
      throw new Error("settings.embeddings.batchMaxTokens must be a number");
    }

    const approxCharsPerToken = toNumber(embeddingsRaw.approxCharsPerToken);
    if (embeddingsRaw.approxCharsPerToken === undefined) changed = true;
    if (approxCharsPerToken !== null) {
      out.embeddings.approxCharsPerToken = Math.min(100, Math.max(0.01, approxCharsPerToken));
      if (out.embeddings.approxCharsPerToken !== approxCharsPerToken) changed = true;
    } else if (embeddingsRaw.approxCharsPerToken !== undefined) {
      throw new Error("settings.embeddings.approxCharsPerToken must be a number");
    }

    const cacheLookupBatchSize = toNumber(embeddingsRaw.cacheLookupBatchSize);
    if (embeddingsRaw.cacheLookupBatchSize === undefined) changed = true;
    if (cacheLookupBatchSize !== null) {
      out.embeddings.cacheLookupBatchSize = clampInt(cacheLookupBatchSize, 1, 10_000);
      if (out.embeddings.cacheLookupBatchSize !== cacheLookupBatchSize) changed = true;
    } else if (embeddingsRaw.cacheLookupBatchSize !== undefined) {
      throw new Error("settings.embeddings.cacheLookupBatchSize must be a number");
    }

    if (typeof embeddingsRaw.queryInstructionTemplate === "string") {
      out.embeddings.queryInstructionTemplate = embeddingsRaw.queryInstructionTemplate;
    } else if (embeddingsRaw.queryInstructionTemplate === undefined) {
      changed = true;
    } else {
      throw new Error("settings.embeddings.queryInstructionTemplate must be a string");
    }
  } else if (raw.embeddings !== undefined) {
    throw new Error("settings.embeddings must be an object");
  }

  const searchRaw = raw.search;
  if (searchRaw === undefined) {
    changed = true;
  } else if (isObject(searchRaw)) {
    assertNoUnknownKeys(
      searchRaw,
      [
        "limit",
        "snippetMaxChars",
        // Deprecated in settings v3 (semantic-only search); accepted for migration.
        "vectorWeight",
        "textWeight",
        "candidateMultiplier",
        "maxCandidates"
      ],
      "settings.search"
    );
    const deprecatedKeys = ["vectorWeight", "textWeight", "candidateMultiplier", "maxCandidates"];
    if (deprecatedKeys.some((key) => key in searchRaw)) {
      changed = true;
    }
    const limit = toNumber(searchRaw.limit);
    if (searchRaw.limit === undefined) changed = true;
    if (limit !== null) {
      out.search.limit = clampInt(limit, 1, 200);
      if (out.search.limit !== limit) changed = true;
    } else if (searchRaw.limit !== undefined) {
      throw new Error("settings.search.limit must be a number");
    }

    const snippetMaxChars = toNumber(searchRaw.snippetMaxChars);
    if (searchRaw.snippetMaxChars === undefined) changed = true;
    if (snippetMaxChars !== null) {
      out.search.snippetMaxChars = clampInt(snippetMaxChars, 1, 1_000_000);
      if (out.search.snippetMaxChars !== snippetMaxChars) changed = true;
    } else if (searchRaw.snippetMaxChars !== undefined) {
      throw new Error("settings.search.snippetMaxChars must be a number");
    }
  } else if (raw.search !== undefined) {
    throw new Error("settings.search must be an object");
  }

  const summaryRaw = raw.summary;
  if (summaryRaw === undefined) {
    changed = true;
  } else if (isObject(summaryRaw)) {
    assertNoUnknownKeys(summaryRaw, ["days", "maxChars", "full"], "settings.summary");
    const days = toNumber(summaryRaw.days);
    if (summaryRaw.days === undefined) changed = true;
    if (days !== null) {
      out.summary.days = clampInt(days, 0, 365);
      if (out.summary.days !== days) changed = true;
    } else if (summaryRaw.days !== undefined) {
      throw new Error("settings.summary.days must be a number");
    }

    const maxChars = toNumber(summaryRaw.maxChars);
    if (summaryRaw.maxChars === undefined) changed = true;
    if (maxChars !== null) {
      out.summary.maxChars = clampInt(maxChars, 1, 500_000);
      if (out.summary.maxChars !== maxChars) changed = true;
    } else if (summaryRaw.maxChars !== undefined) {
      throw new Error("settings.summary.maxChars must be a number");
    }

    const full = toBoolean(summaryRaw.full);
    if (summaryRaw.full === undefined) changed = true;
    if (full !== null) {
      out.summary.full = full;
    } else if (summaryRaw.full !== undefined) {
      throw new Error("settings.summary.full must be a boolean");
    }
  } else if (raw.summary !== undefined) {
    throw new Error("settings.summary must be an object");
  }

  const debugRaw = raw.debug;
  if (debugRaw === undefined) {
    changed = true;
  } else if (isObject(debugRaw)) {
    assertNoUnknownKeys(debugRaw, ["vector"], "settings.debug");
    const vector = toBoolean(debugRaw.vector);
    if (debugRaw.vector === undefined) changed = true;
    if (vector !== null) {
      out.debug.vector = vector;
    } else if (debugRaw.vector !== undefined) {
      throw new Error("settings.debug.vector must be a boolean");
    }
  } else if (raw.debug !== undefined) {
    throw new Error("settings.debug must be an object");
  }

  if (!out.embeddings.modelPath || !out.embeddings.modelPath.trim()) {
    throw new Error("settings.embeddings.modelPath is required (local embeddings)");
  }

  return { settings: out, changed };
}

export function ensureSettings(): Settings {
  const rootDir = getRootDir();
  const filePath = settingsFilePath();
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }

  if (!fs.existsSync(filePath)) {
    const legacyPublicPath = path.join(rootDir, PUBLIC_DIRNAME, SETTINGS_FILENAME);
    if (fs.existsSync(legacyPublicPath)) {
      const rawText = fs.readFileSync(legacyPublicPath, "utf8");
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawText);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid legacy settings.json at ${legacyPublicPath}\n${message}`);
      }
      const normalized = normalizeSettings(parsed);
      fs.writeFileSync(filePath, JSON.stringify(normalized.settings, null, 2) + "\n");
      cleanupWorkspaceSettingsFiles(rootDir, filePath);
      return normalized.settings;
    }

    fs.writeFileSync(filePath, JSON.stringify(DEFAULT_SETTINGS, null, 2) + "\n");
    cleanupWorkspaceSettingsFiles(rootDir, filePath);
    return JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as Settings;
  }

  const rawText = fs.readFileSync(filePath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid settings.json at ${filePath}\n${message}`);
  }

  const normalized = normalizeSettings(parsed);
  if (normalized.changed) {
    fs.writeFileSync(filePath, JSON.stringify(normalized.settings, null, 2) + "\n");
  }
  cleanupWorkspaceSettingsFiles(rootDir, filePath);
  return normalized.settings;
}
