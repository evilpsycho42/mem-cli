#!/usr/bin/env node
import { Command } from "commander";
import fs from "fs";
import path from "path";
import { maybeRunViaDaemon, requestDaemonShutdown } from "./core/daemon-client";
import { serveDaemon } from "./core/daemon-server";
import { registerInitCommand } from "./commands/init";
import { registerAddCommand } from "./commands/add";
import { registerSearchCommand } from "./commands/search";
import { registerSummaryCommand } from "./commands/summary";
import { registerStateCommand } from "./commands/state";
import { registerReindexCommand } from "./commands/reindex";

function readPackageVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

async function main() {
  if (process.argv[2] === "__daemon") {
    const args = process.argv.slice(3);
    if (args.includes("--shutdown")) {
      await requestDaemonShutdown();
      return;
    }
    if (args.includes("--serve")) {
      await serveDaemon();
      return;
    }
    throw new Error("Usage: mem __daemon --serve|--shutdown");
  }

  const forwarded = await maybeRunViaDaemon(process.argv.slice(2));
  if (forwarded) return;

  const program = new Command();
  program.name("mem").description("Agent memory CLI").version(readPackageVersion());

  registerInitCommand(program);
  registerAddCommand(program);
  registerSearchCommand(program);
  registerSummaryCommand(program);
  registerStateCommand(program);
  registerReindexCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
