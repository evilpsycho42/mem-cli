import fs from "fs";
import net from "net";
import { spawn } from "child_process";
import { DAEMON_PROTOCOL_VERSION, daemonEnabledByDefault, daemonAddress, daemonLockPath } from "./daemon-transport";
import { readCliPackageVersion } from "./cli-version";
import { acquireFileLock } from "./lock";

type DaemonRunResponse = {
  ok: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  restartRequired?: boolean;
};

function isForwardableCommand(argv: string[]): boolean {
  // Find the first non-flag token (command name).
  const cmd = argv.find((a) => a && !a.startsWith("-"));
  if (!cmd) return false;
  return ["add", "search", "reindex"].includes(cmd);
}

function readOptionalStdin(argv: string[]): string | undefined {
  if (!argv.includes("--stdin")) return undefined;
  return fs.readFileSync(0, "utf8");
}

function connectOnce(timeoutMs: number): Promise<net.Socket> {
  const { address } = daemonAddress();
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address);
    const done = (err?: unknown) => {
      socket.removeAllListeners();
      if (err) {
        try {
          socket.destroy();
        } catch {}
        reject(err);
      } else {
        resolve(socket);
      }
    };
    socket.once("connect", () => done());
    socket.once("error", (err) => done(err));
    socket.setTimeout(timeoutMs, () => done(new Error("Timed out connecting to daemon")));
  });
}

async function sendRequest<T extends object>(payload: T, timeoutMs: number): Promise<any> {
  const socket = await connectOnce(timeoutMs);
  socket.setEncoding("utf8");
  const response = await new Promise<string>((resolve, reject) => {
    let buffer = "";
    const done = (err?: unknown, raw?: string) => {
      socket.removeAllListeners();
      try {
        socket.end();
      } catch {}
      if (err) reject(err);
      else resolve(raw ?? "");
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf("\n");
      if (idx === -1) return;
      const line = buffer.slice(0, idx);
      done(undefined, line);
    });
    socket.once("error", (err) => done(err));
    socket.setTimeout(timeoutMs, () => done(new Error("Timed out waiting for daemon response")));

    socket.write(`${JSON.stringify(payload)}\n`);
  });
  try {
    return JSON.parse(response);
  } catch {
    throw new Error("Invalid daemon response");
  }
}

async function waitForDaemonReady(timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await sendRequest(
        { type: "ping", protocolVersion: DAEMON_PROTOCOL_VERSION, clientVersion: readCliPackageVersion() },
        300
      );
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error("Timed out waiting for daemon to start");
}

async function startDaemon(): Promise<void> {
  const scriptPath = process.argv[1];
  if (!scriptPath) throw new Error("Unable to locate CLI entrypoint");
  const child = spawn(process.execPath, [scriptPath, "__daemon", "--serve"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, MEM_CLI_DAEMON_PROCESS: "1" }
  });
  child.unref();
}

async function ensureDaemonRunning(): Promise<void> {
  try {
    await waitForDaemonReady(500);
    return;
  } catch {}

  // Avoid a thundering herd of concurrent clients spawning multiple daemons.
  const lock = await acquireFileLock(daemonLockPath("daemon-start"), { timeoutMs: 10000 });
  try {
    try {
      await waitForDaemonReady(500);
      return;
    } catch {}
    await startDaemon();
    await waitForDaemonReady(5000);
  } finally {
    lock.release();
  }
}

export async function requestDaemonShutdown(): Promise<void> {
  const clientVersion = readCliPackageVersion();
  try {
    await sendRequest(
      { type: "shutdown", protocolVersion: DAEMON_PROTOCOL_VERSION, clientVersion },
      1000
    );
  } catch {}
}

async function runViaDaemonOnce(argv: string[]): Promise<DaemonRunResponse> {
  const clientVersion = readCliPackageVersion();
  const stdin = readOptionalStdin(argv);

  await ensureDaemonRunning();
  return (await sendRequest(
    {
      type: "run",
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      clientVersion,
      argv,
      stdin
    },
    10 * 60 * 1000
  )) as DaemonRunResponse;
}

export async function maybeRunViaDaemon(argv: string[]): Promise<boolean> {
  if (!daemonEnabledByDefault()) return false;
  if (!isForwardableCommand(argv)) return false;

  try {
    let res = await runViaDaemonOnce(argv);
    if (res.restartRequired) {
      await requestDaemonShutdown();
      res = await runViaDaemonOnce(argv);
    }

    const stdout = typeof res.stdout === "string" ? res.stdout : "";
    const stderr = typeof res.stderr === "string" ? res.stderr : "";
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
    process.exitCode = typeof res.exitCode === "number" ? res.exitCode : res.ok ? 0 : 1;
    return true;
  } catch {
    return false;
  }
}
