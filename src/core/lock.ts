import fs from "fs";
import path from "path";

export type FileLockHandle = { release: () => void };

type LockInfo = { pid: number; createdAt: number };

const CORRUPT_LOCK_GRACE_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {}
}

function safeClose(fd: number): void {
  try {
    fs.closeSync(fd);
  } catch {}
}

function parseLockInfo(raw: string): LockInfo | null {
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (!parsed || typeof parsed.pid !== "number" || typeof parsed.createdAt !== "number") {
      return null;
    }
    return { pid: parsed.pid, createdAt: parsed.createdAt };
  } catch {
    return null;
  }
}

function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    return parseLockInfo(raw);
  } catch {
    return null;
  }
}

function safeFileAgeMs(filePath: string): number | null {
  try {
    const stat = fs.statSync(filePath);
    return Math.max(0, Date.now() - stat.mtimeMs);
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
    // ESRCH: no such process. EPERM: process exists but we lack permission.
    if (code === "ESRCH") return false;
    return true;
  }
}

async function waitForUnlock(lockPath: string, options?: { timeoutMs?: number; pollIntervalMs?: number }): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 10 * 60 * 1000;
  const pollIntervalMs = options?.pollIntervalMs ?? 50;
  const start = Date.now();
  while (fs.existsSync(lockPath)) {
    const info = readLockInfo(lockPath);
    if (!info) {
      const ageMs = safeFileAgeMs(lockPath);
      // If metadata is missing or corrupt, it may just be in the middle of being written.
      // Wait a short grace period before treating it as stale.
      if (ageMs !== null && ageMs > CORRUPT_LOCK_GRACE_MS) {
        safeUnlink(lockPath);
        continue;
      }
    } else if (!isPidAlive(info.pid)) {
      safeUnlink(lockPath);
      continue;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for lock: ${lockPath}`);
    }
    await sleep(pollIntervalMs);
  }
}

export async function acquireFileLock(
  lockPath: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<FileLockHandle> {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const pollIntervalMs = options?.pollIntervalMs ?? 50;
  let attempts = 0;
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        const info: LockInfo = { pid: process.pid, createdAt: Date.now() };
        fs.writeFileSync(fd, JSON.stringify(info), "utf8");
      } catch {
        safeClose(fd);
        safeUnlink(lockPath);
        throw new Error(`Failed to write lock metadata: ${lockPath}`);
      }

      return {
        release: () => {
          safeClose(fd);
          safeUnlink(lockPath);
        }
      };
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
      if (code !== "EEXIST") throw err;
      await waitForUnlock(lockPath, options);
      attempts += 1;
      // Small backoff to reduce thundering herds when multiple processes are contending.
      await sleep(Math.min(250, pollIntervalMs * Math.min(attempts, 5)));
    }
  }
}

export async function waitForFileLockRelease(
  lockPath: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<void> {
  await waitForUnlock(lockPath, options);
}
