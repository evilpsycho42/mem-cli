import fs from "fs";
import path from "path";

export type FileLockHandle = { release: () => void };

type LockInfo = { pid: number; createdAt: number };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
      try {
        fs.unlinkSync(lockPath);
        continue;
      } catch {}
    } else if (!isPidAlive(info.pid)) {
      try {
        fs.unlinkSync(lockPath);
        continue;
      } catch {}
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
  while (true) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        const info: LockInfo = { pid: process.pid, createdAt: Date.now() };
        fs.writeFileSync(fd, JSON.stringify(info), "utf8");
      } catch {
        try {
          fs.closeSync(fd);
        } catch {}
        try {
          fs.unlinkSync(lockPath);
        } catch {}
        throw new Error(`Failed to write lock metadata: ${lockPath}`);
      }

      return {
        release: () => {
          try {
            fs.closeSync(fd);
          } catch {}
          try {
            fs.unlinkSync(lockPath);
          } catch {}
        }
      };
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
      if (code !== "EEXIST") throw err;
      await waitForUnlock(lockPath, options);
    }
  }
}

export async function waitForFileLockRelease(
  lockPath: string,
  options?: { timeoutMs?: number; pollIntervalMs?: number }
): Promise<void> {
  await waitForUnlock(lockPath, options);
}

