import fs from "fs";
import path from "path";

export function readCliPackageVersion(): string {
  try {
    const scriptPath = process.argv[1];
    const baseDir = scriptPath ? path.resolve(path.dirname(scriptPath), "..") : path.resolve(__dirname, "..", "..");
    const pkgPath = path.join(baseDir, "package.json");
    const raw = fs.readFileSync(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version.trim().length > 0 ? parsed.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

