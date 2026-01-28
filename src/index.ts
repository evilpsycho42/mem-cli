#!/usr/bin/env node
import { Command } from "commander";
import { registerInitCommand } from "./commands/init";
import { registerAddCommand } from "./commands/add";
import { registerSearchCommand } from "./commands/search";
import { registerSummaryCommand } from "./commands/summary";
import { registerStateCommand } from "./commands/state";
import { registerReindexCommand } from "./commands/reindex";
import { registerDestroyCommand } from "./commands/destroy";

async function main() {
  const program = new Command();
  program.name("mem").description("Agent memory CLI").version("0.1.0");

  registerInitCommand(program);
  registerAddCommand(program);
  registerSearchCommand(program);
  registerSummaryCommand(program);
  registerStateCommand(program);
  registerReindexCommand(program);
  registerDestroyCommand(program);

  await program.parseAsync(process.argv);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(message);
  process.exit(1);
});
