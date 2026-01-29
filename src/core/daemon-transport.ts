import fs from "fs";
import os from "os";
import path from "path";
import { sha256Hex } from "../utils/hash";

export const DAEMON_PROTOCOL_VERSION = 1;

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function falsyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["0", "false", "no", "n", "off"].includes(normalized);
}

export function daemonEnabledByDefault(): boolean {
  if (truthyEnv(process.env.MEM_CLI_DAEMON_PROCESS)) return false;
  const raw = process.env.MEM_CLI_DAEMON;
  if (raw === undefined) return true;
  return !falsyEnv(raw);
}

function daemonHomeKey(): string {
  const home = os.homedir();
  return sha256Hex(home).slice(0, 12);
}

function daemonBaseDir(): string {
  const override = process.env.MEM_CLI_DAEMON_SOCKET_DIR?.trim();
  if (override) return override;
  // Avoid long HOME-based unix socket paths (sun_path length limits).
  if (process.platform !== "win32" && fs.existsSync("/tmp")) return "/tmp";
  return os.tmpdir();
}

export function daemonAddress(): { transport: "unix" | "pipe"; address: string } {
  const homeKey = daemonHomeKey();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;

  if (process.platform === "win32") {
    return { transport: "pipe", address: `\\\\.\\pipe\\mem-cli-${uid}-${homeKey}` };
  }

  const dir = path.join(daemonBaseDir(), `mem-cli-${uid}-${homeKey}`);
  return { transport: "unix", address: path.join(dir, "daemon.sock") };
}

export function ensureDaemonDir(): { transport: "unix" | "pipe"; address: string } {
  const out = daemonAddress();
  if (out.transport === "unix") {
    fs.mkdirSync(path.dirname(out.address), { recursive: true, mode: 0o700 });
  }
  return out;
}

export function daemonLockPath(name: string): string {
  const homeKey = daemonHomeKey();
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const base = daemonBaseDir();
  const safeName = String(name || "lock").replace(/[^a-zA-Z0-9._-]+/g, "-");
  if (process.platform === "win32") {
    return path.join(base, `mem-cli-${uid}-${homeKey}.${safeName}.lock`);
  }
  const dir = path.join(base, `mem-cli-${uid}-${homeKey}`);
  return path.join(dir, `${safeName}.lock`);
}
