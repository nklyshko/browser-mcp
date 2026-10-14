import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MCP_API_KEY_ENV } from './constant/index.js';
import { getApiKeyPath, resetApiKeyCache, resolveApiKey } from './api-key.js';

let dir: string;
let previousDir: string | undefined;
let previousKey: string | undefined;

beforeEach(() => {
  previousDir = process.env.CHROME_MCP_AGENT_DATA_DIR;
  previousKey = process.env[MCP_API_KEY_ENV];
  delete process.env[MCP_API_KEY_ENV];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-key-test-'));
  process.env.CHROME_MCP_AGENT_DATA_DIR = dir;
  resetApiKeyCache();
});

afterEach(() => {
  if (previousDir === undefined) delete process.env.CHROME_MCP_AGENT_DATA_DIR;
  else process.env.CHROME_MCP_AGENT_DATA_DIR = previousDir;
  if (previousKey === undefined) delete process.env[MCP_API_KEY_ENV];
  else process.env[MCP_API_KEY_ENV] = previousKey;
  resetApiKeyCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('api key', () => {
  test('generates once, persists owner-only, and reuses the stored value', () => {
    const first = resolveApiKey();
    expect(first).toMatch(/^[A-Za-z0-9_-]{32,}$/);

    const file = getApiKeyPath();
    expect(fs.readFileSync(file, 'utf8').trim()).toBe(first);
    // Anything that can read this file can drive the browser.
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);

    // A fresh process reads the file rather than minting a second key, or every
    // restart would invalidate every client config.
    resetApiKeyCache();
    expect(resolveApiKey()).toBe(first);
  });

  test('an explicit environment key wins and is never cached', () => {
    const generated = resolveApiKey();
    process.env[MCP_API_KEY_ENV] = 'explicit-key';
    expect(resolveApiKey()).toBe('explicit-key');

    // Caching the env value would make a change to it silently ineffective.
    delete process.env[MCP_API_KEY_ENV];
    expect(resolveApiKey()).toBe(generated);
  });

  test('an unwritable data dir still yields a usable key', () => {
    process.env.CHROME_MCP_AGENT_DATA_DIR = path.join(dir, 'file-not-a-dir');
    fs.writeFileSync(path.join(dir, 'file-not-a-dir'), 'blocked');
    resetApiKeyCache();

    // The server must still come up; the key just lives for this process.
    expect(resolveApiKey()).toMatch(/^[A-Za-z0-9_-]{32,}$/);
  });
});
