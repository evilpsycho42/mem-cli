export const MEM_CLI_TOKEN_ENV = "MEM_CLI_TOKEN";

export function readMemCliTokenEnv(): string | undefined {
  const raw = process.env[MEM_CLI_TOKEN_ENV];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveWorkspaceSelection(options: {
  public?: boolean;
  token?: string;
}): { isPublic: boolean; token?: string } {
  const isPublic = Boolean(options.public);
  const explicitToken =
    typeof options.token === "string" && options.token.trim().length > 0
      ? options.token.trim()
      : undefined;

  if (isPublic && explicitToken) {
    throw new Error("Choose either --public or --token, not both.");
  }
  if (isPublic) {
    return { isPublic: true };
  }

  const token = explicitToken ?? readMemCliTokenEnv();
  if (!token) {
    throw new Error(`Provide --public or --token (or set ${MEM_CLI_TOKEN_ENV}).`);
  }

  return { isPublic: false, token };
}

export function expandArgvDefaultToken(argv: string[]): string[] {
  // Never change argv when a workspace is explicitly selected.
  if (argv.includes("--public") || argv.includes("--token")) return argv;

  // Don't inject defaults when user is asking for help/version.
  if (argv.includes("--help") || argv.includes("-h") || argv.includes("--version") || argv.includes("-V")) {
    return argv;
  }

  const envToken = readMemCliTokenEnv();
  if (!envToken) return argv;

  // Determine command for special cases.
  const cmd = argv.find((a) => a && !a.startsWith("-"));
  if (!cmd) return argv;

  // `reindex --all` must not be combined with token selection.
  if (cmd === "reindex" && argv.includes("--all")) return argv;

  return [...argv, "--token", envToken];
}

