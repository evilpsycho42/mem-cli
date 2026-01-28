import fs from "fs";
import path from "path";
import { Command } from "commander";
import { resolveWorkspacePath, assertWorkspaceAccess } from "../core/workspace";
import { readRegistry, writeRegistry } from "../core/registry";
import { hashToken, tokenWorkspaceId } from "../core/auth";

export function registerDestroyCommand(program: Command): void {
  program
    .command("destroy")
    .description("Destroy a workspace (requires --confirm)")
    .option("--public", "Use public workspace")
    .option("--token <token>", "Use private workspace token")
    .option("--confirm", "Confirm destruction")
    .option("--json", "JSON output")
    .action((options: { public?: boolean; token?: string; confirm?: boolean; json?: boolean }) => {
      if (!options.confirm) {
        throw new Error("Destruction requires --confirm.");
      }

      const isPublic = Boolean(options.public);
      const token = options.token as string | undefined;
      if (!isPublic && !token) {
        throw new Error("Provide --public or --token.");
      }
      if (isPublic && token) {
        throw new Error("Choose either --public or --token, not both.");
      }

      const ref = resolveWorkspacePath({ isPublic, token });
      assertWorkspaceAccess(ref, token);

      if (!isPublic && token) {
        const tokenHash = hashToken(token);
        const workspaceId = tokenWorkspaceId(tokenHash);
        const registry = readRegistry();
        if (registry[workspaceId] !== undefined) {
          delete registry[workspaceId];
          writeRegistry(registry);
        }
      }

      if (fs.existsSync(ref.path)) {
        fs.rmSync(ref.path, { recursive: true, force: true });
      }

      if (options.json) {
        console.log(JSON.stringify({ workspace: ref.path, status: "destroyed" }, null, 2));
        return;
      }

      console.log(`Destroyed workspace at ${ref.path}`);
    });
}
