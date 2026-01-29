import fs from "fs";

let stdinOverride: string | null = null;

export function setStdinOverride(value: string | null): void {
  stdinOverride = value;
}

export function readStdinUtf8(): string {
  if (stdinOverride !== null) return stdinOverride;
  return fs.readFileSync(0, "utf8");
}

