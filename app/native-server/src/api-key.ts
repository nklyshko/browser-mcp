import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MCP_API_KEY_ENV } from './constant/index.js';
import { getAgentDataDir } from './agent/storage.js';
import { structuredLog } from './observability.js';

const KEY_FILE_NAME = 'api-key';
/** 32 bytes of randomness, url-safe so it survives a copy-paste into a JSON config. */
const KEY_BYTES = 32;

let cached: string | null = null;

export function getApiKeyPath(): string {
  return path.join(getAgentDataDir(), KEY_FILE_NAME);
}

function readKeyFile(file: string): string | null {
  try {
    const contents = fs.readFileSync(file, 'utf8').trim();
    return contents || null;
  } catch {
    return null;
  }
}

/**
 * The key the server requires on its MCP routes.
 *
 * Read from a file rather than taken only from the environment, because the server now
 * has three launch paths — a Chrome-launched host, an MCP client's stdio proxy, or a
 * terminal — and Chrome gives a native host a minimal, Chrome-controlled environment.
 * `export CHROME_MCP_API_KEY=...` in a shell never reaches a Chrome-launched server, so
 * the file is the one home the key has regardless of who started the process.
 *
 * An explicit environment variable still wins, so existing setups keep working.
 */
export function resolveApiKey(): string {
  // Read fresh rather than cached: an explicitly configured key must always win, and
  // caching it would make a change to the environment silently ineffective.
  const fromEnv = process.env[MCP_API_KEY_ENV]?.trim();
  if (fromEnv) return fromEnv;

  if (cached) return cached;

  const file = getApiKeyPath();
  const existing = readKeyFile(file);
  if (existing) {
    cached = existing;
    return cached;
  }

  const generated = crypto.randomBytes(KEY_BYTES).toString('base64url');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Owner-only: anything that can read this file can drive the browser.
    fs.writeFileSync(file, `${generated}\n`, { mode: 0o600 });
    fs.chmodSync(file, 0o600);
    structuredLog('api_key.generated', { path: file });
  } catch (error) {
    // A read-only data dir must not stop the server from coming up; the key simply
    // lives for this process only, and the popup still surfaces it.
    structuredLog('api_key.persist_failed', {
      path: file,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  cached = generated;
  return cached;
}

/** Test seam only: forget the cached key so a fresh data dir is read again. */
export function resetApiKeyCache(): void {
  cached = null;
}
