import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { Command } from "commander";
import { ensureDaemonDir, DAEMON_PROTOCOL_VERSION, daemonAddress } from "./daemon-transport";
import { readCliPackageVersion } from "./cli-version";
import { setStdinOverride } from "./stdin";
import { getEmbeddingsDebugStats } from "./embeddings";
import { registerInitCommand } from "../commands/init";
import { registerAddCommand } from "../commands/add";
import { registerSearchCommand } from "../commands/search";
import { registerSummaryCommand } from "../commands/summary";
import { registerStateCommand } from "../commands/state";
import { registerReindexCommand } from "../commands/reindex";

type DaemonRequest =
  | { type: "ping"; protocolVersion: number; clientVersion: string }
  | { type: "shutdown"; protocolVersion: number; clientVersion: string }
  | {
      type: "run";
      protocolVersion: number;
      clientVersion: string;
      argv: string[];
      stdin?: string;
    };

type DaemonResponse = {
  ok: boolean;
  protocolVersion: number;
  daemonVersion: string;
  pid: number;
  startedAt: number;
  embeddings?: ReturnType<typeof getEmbeddingsDebugStats>;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  restartRequired?: boolean;
};

function parseIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function truthyEnv(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function createCliProgram(): Command {
  const program = new Command();
  program.name("mem").description("Agent memory CLI").version(readCliPackageVersion());

  registerInitCommand(program);
  registerAddCommand(program);
  registerSearchCommand(program);
  registerSummaryCommand(program);
  registerStateCommand(program);
  registerReindexCommand(program);

  // Ensure we never terminate the daemon process due to commander exits.
  program.exitOverride();
  return program;
}

async function runCliInProcess(argv: string[], stdin?: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const program = createCliProgram();

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  const captureWrite = (chunks: string[], chunk: any, encoding?: any, cb?: any): boolean => {
    const text =
      typeof chunk === "string"
        ? chunk
        : Buffer.isBuffer(chunk)
          ? chunk.toString(
              typeof encoding === "string" && Buffer.isEncoding(encoding)
                ? (encoding as BufferEncoding)
                : "utf8"
            )
          : String(chunk);
    chunks.push(text);
    if (typeof cb === "function") cb();
    return true;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, encoding?: any, cb?: any) => captureWrite(stdoutChunks, chunk, encoding, cb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, encoding?: any, cb?: any) => captureWrite(stderrChunks, chunk, encoding, cb);

  const prevExitCode = process.exitCode;
  process.exitCode = 0;

  const argvForCommander = ["node", "mem", ...argv];

  try {
    setStdinOverride(stdin ?? null);
    await program.parseAsync(argvForCommander);
  } catch (err) {
    const commanderExitCode =
      err && typeof err === "object" && typeof (err as any).exitCode === "number"
        ? (err as any).exitCode
        : null;
    const commanderCode = err && typeof err === "object" ? (err as any).code : undefined;
    if (commanderExitCode !== null) {
      // Commander already printed help/error output before throwing (due to exitOverride()).
      process.exitCode = commanderExitCode;
      if (
        commanderCode !== "commander.helpDisplayed" &&
        commanderCode !== "commander.help" &&
        commanderCode !== "commander.version"
      ) {
        // As a fallback, if commander didn't write anything, keep the message.
        if (stderrChunks.length === 0) {
          const message = err instanceof Error ? err.message : String(err);
          stderrChunks.push(message.endsWith("\n") ? message : `${message}\n`);
        }
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      stderrChunks.push(message.endsWith("\n") ? message : `${message}\n`);
      process.exitCode = 1;
    }
  } finally {
    setStdinOverride(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = stdoutWrite;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = stderrWrite;
  }

  const exitCode =
    typeof process.exitCode === "number" && Number.isFinite(process.exitCode) ? process.exitCode : 0;
  process.exitCode = prevExitCode;

  return { exitCode, stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

async function isExistingDaemonAlive(): Promise<boolean> {
  const { transport, address } = daemonAddress();
  if (transport !== "unix") return false;
  if (!fs.existsSync(address)) return false;

  return new Promise((resolve) => {
    const socket = net.createConnection(address);
    const done = (ok: boolean) => {
      try {
        socket.destroy();
      } catch {}
      resolve(ok);
    };
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
    socket.setTimeout(300, () => done(false));
  });
}

export async function serveDaemon(): Promise<void> {
  const daemonVersion = readCliPackageVersion();
  const { transport, address } = ensureDaemonDir();
  const startedAt = Date.now();

  if (transport === "unix") {
    if (await isExistingDaemonAlive()) {
      return;
    }
    // Clean up stale socket file.
    try {
      fs.unlinkSync(address);
    } catch {}
  }

  if (truthyEnv(process.env.MEM_CLI_DAEMON_TRACE)) {
    try {
      const traceDir = path.join(os.homedir(), ".mem-cli");
      fs.mkdirSync(traceDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(
        path.join(traceDir, "daemon-starts.log"),
        `${new Date().toISOString()} pid=${process.pid} version=${daemonVersion}\n`,
        "utf8"
      );
    } catch {}
  }

  const idleMs = parseIntEnv("MEM_CLI_DAEMON_IDLE_MS", 10 * 60 * 1000);
  const server = net.createServer();

  let shuttingDown = false;
  let idleTimer: NodeJS.Timeout | null = null;

  let queue: Promise<unknown> = Promise.resolve();
  const enqueue = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work);
    queue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  };

  const cleanup = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    if (transport === "unix") {
      try {
        fs.unlinkSync(address);
      } catch {}
      try {
        fs.rmdirSync(path.dirname(address));
      } catch {}
    }
  };

  const scheduleIdle = () => {
    if (idleMs <= 0) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (shuttingDown) return;
      shuttingDown = true;
      server.close(() => {
        cleanup();
        process.exit(0);
      });
    }, idleMs);
  };

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    server.close(() => {
      cleanup();
      process.exit(0);
    });
  };

  server.on("connection", (socket) => {
    scheduleIdle();
    socket.setEncoding("utf8");
    let buffer = "";
    const respond = (res: DaemonResponse) => {
      try {
        socket.write(`${JSON.stringify(res)}\n`);
      } catch {}
      try {
        socket.end();
      } catch {}
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      buffer = "";
      let req: DaemonRequest;
      try {
        req = JSON.parse(line) as DaemonRequest;
      } catch {
        respond({
          ok: false,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          daemonVersion,
          pid: process.pid,
          startedAt,
          exitCode: 1,
          stderr: "Invalid request JSON\n"
        });
        return;
      }

      enqueue(async () => {
        if (!req || typeof req !== "object" || typeof (req as any).type !== "string") {
          respond({
            ok: false,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            daemonVersion,
            pid: process.pid,
            startedAt,
            exitCode: 1,
            stderr: "Invalid request\n"
          });
          return;
        }

        if (req.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
          respond({
            ok: false,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            daemonVersion,
            pid: process.pid,
            startedAt,
            exitCode: 1,
            restartRequired: true,
            stderr: `[mem-cli] daemon protocol mismatch (daemon=${DAEMON_PROTOCOL_VERSION}, client=${req.protocolVersion})\n`
          });
          return;
        }

        if (req.clientVersion && req.clientVersion !== daemonVersion) {
          respond({
            ok: false,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            daemonVersion,
            pid: process.pid,
            startedAt,
            exitCode: 1,
            restartRequired: true,
            stderr: `[mem-cli] daemon version mismatch (daemon=${daemonVersion}, client=${req.clientVersion})\n`
          });
          return;
        }

        if (req.type === "ping") {
          respond({
            ok: true,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            daemonVersion,
            pid: process.pid,
            startedAt,
            embeddings: getEmbeddingsDebugStats()
          });
          return;
        }

        if (req.type === "shutdown") {
          respond({
            ok: true,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            daemonVersion,
            pid: process.pid,
            startedAt
          });
          shutdown();
          return;
        }

        if (req.type !== "run" || !Array.isArray(req.argv)) {
          respond({
            ok: false,
            protocolVersion: DAEMON_PROTOCOL_VERSION,
            daemonVersion,
            pid: process.pid,
            startedAt,
            exitCode: 1,
            stderr: "Unsupported request\n"
          });
          return;
        }

        const runRes = await runCliInProcess(req.argv, typeof req.stdin === "string" ? req.stdin : undefined);
        respond({
          ok: true,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          daemonVersion,
          pid: process.pid,
          startedAt,
          exitCode: runRes.exitCode,
          stdout: runRes.stdout,
          stderr: runRes.stderr
        });
      }).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        respond({
          ok: false,
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          daemonVersion,
          pid: process.pid,
          startedAt,
          exitCode: 1,
          stderr: `${message}\n`
        });
      });
    });

    socket.on("error", () => {});
  });

  server.on("error", (err) => {
    const code = err && typeof err === "object" ? (err as { code?: string }).code : undefined;
    if (code === "EADDRINUSE") {
      process.exit(0);
    }
    console.error(`[mem-cli] daemon server error: ${String(err)}`);
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    server.listen(address, () => resolve());
  });

  if (transport === "unix") {
    try {
      fs.chmodSync(address, 0o600);
    } catch {}
  }

  scheduleIdle();

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("exit", cleanup);
}
