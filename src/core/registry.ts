import fs from "fs";
import path from "path";
import os from "os";
import { APP_DIRNAME, REGISTRY_FILENAME } from "./layout";

export type Registry = Record<string, string | null>;

export function getRootDir(): string {
  return path.join(os.homedir(), APP_DIRNAME);
}

export function getRegistryPath(): string {
  return path.join(getRootDir(), REGISTRY_FILENAME);
}

export function readRegistry(): Registry {
  const registryPath = getRegistryPath();
  if (!fs.existsSync(registryPath)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(registryPath, "utf8");
    const parsed = JSON.parse(raw) as Registry;
    return parsed ?? {};
  } catch {
    return {};
  }
}

export function writeRegistry(registry: Registry): void {
  const rootDir = getRootDir();
  if (!fs.existsSync(rootDir)) {
    fs.mkdirSync(rootDir, { recursive: true });
  }
  fs.writeFileSync(getRegistryPath(), JSON.stringify(registry, null, 2));
}
