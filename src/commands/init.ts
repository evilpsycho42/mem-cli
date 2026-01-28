import { Command } from "commander";
import { initPublicWorkspace, initPrivateWorkspace } from "../core/workspace";
import { openDb } from "../core/index";
import { settingsFilePath } from "../core/settings";

export function registerInitCommand(program: Command): void {
  program
    .command("init")
    .description("Initialize a public or private workspace")
    .option("--public", "Initialize public workspace")
    .option("--token <token>", "Token for private workspace")
    .option("--path <path>", "Custom path for private workspace")
    .option("--json", "JSON output")
    .action((options: { public?: boolean; token?: string; path?: string; json?: boolean }) => {
      const isPublic = Boolean(options.public);
      const token = options.token as string | undefined;
      const customPath = options.path as string | undefined;

      if (!isPublic && !token) {
        throw new Error("Provide --public or --token.");
      }
      if (isPublic && token) {
        throw new Error("Choose either --public or --token, not both.");
      }
      if (isPublic && customPath) {
        throw new Error("--path is only valid with --token.");
      }

      const workspacePath = isPublic
        ? initPublicWorkspace()
        : initPrivateWorkspace(token as string, customPath);

      const db = openDb(workspacePath);
      db.close();

      if (options.json) {
        console.log(
          JSON.stringify(
            {
              workspace: workspacePath,
              type: isPublic ? "public" : "private",
              settingsFile: settingsFilePath()
            },
            null,
            2
          )
        );
        return;
      }

      console.log(`Initialized ${isPublic ? "public" : "private"} workspace at ${workspacePath}`);
      console.log(`Settings: ${settingsFilePath()}`);
    });
}
