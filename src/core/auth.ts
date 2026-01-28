import { sha256Hex } from "../utils/hash";

const TOKEN_REGEX = /^[a-zA-Z0-9-]+$/;
const TOKEN_MIN_LENGTH = 6;
const WORKSPACE_ID_LENGTH = 12;

export function validateToken(token: string): void {
  if (!TOKEN_REGEX.test(token)) {
    throw new Error("Token must match [a-zA-Z0-9-].");
  }
  if (token.length < TOKEN_MIN_LENGTH) {
    throw new Error(`Token must be at least ${TOKEN_MIN_LENGTH} characters.`);
  }
}

export function hashToken(token: string): string {
  return sha256Hex(token);
}

export function tokenWorkspaceId(tokenHash: string): string {
  return tokenHash.slice(0, WORKSPACE_ID_LENGTH);
}
