import { afterEach, describe, expect, test } from '@jest/globals';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Drives the built stub as Chrome does: framed messages on stdin, framed messages back
 * on stdout, and a real HTTP server standing in for the MCP server it bootstraps from.
 *
 * Runs against dist/, so it needs a build. Skipped rather than failed when there isn't
 * one, because a missing build is a setup problem and not a defect in the stub.
 */
const STUB = path.join(__dirname, '..', 'dist', 'stub.js');
const built = fs.existsSync(STUB);
const describeIfBuilt = built ? describe : describe.skip;

function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

/** Reads length-prefixed frames off the stub's stdout. */
function collect(child: ChildProcess, onMessage: (m: any) => void): void {
  let buffer = Buffer.alloc(0);
  child.stdout!.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const size = buffer.readUInt32LE(0);
      if (buffer.length < 4 + size) return;
      const body = buffer.subarray(4, 4 + size);
      buffer = buffer.subarray(4 + size);
      try {
        onMessage(JSON.parse(body.toString('utf8')));
      } catch {
        // Not JSON; the stub only ever sends JSON.
      }
    }
  });
}

interface FakeServer {
  port: number;
  bootstrapCalls: number;
  authHeaders: (string | undefined)[];
  close(): Promise<void>;
}

async function startFakeServer(options: { issueChannel: boolean }): Promise<FakeServer> {
  const state = { bootstrapCalls: 0, authHeaders: [] as (string | undefined)[] };
  const server = http.createServer((request, response) => {
    if (request.url === '/ping') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ status: 'ok', message: 'pong' }));
      return;
    }
    if (request.url === '/__chrome_mcp_bridge/bootstrap' && request.method === 'POST') {
      state.bootstrapCalls += 1;
      state.authHeaders.push(request.headers.authorization);
      if (!options.issueChannel) {
        response.writeHead(503).end(JSON.stringify({ status: 'no_channel' }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          status: 'ok',
          channel: { port: 54321, token: 'channel-token', expiresAt: Date.now() + 60_000 },
        }),
      );
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake server failed to bind');
  return {
    port: address.port,
    get bootstrapCalls() {
      return state.bootstrapCalls;
    },
    get authHeaders() {
      return state.authHeaders;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const children: ChildProcess[] = [];
const servers: FakeServer[] = [];
let dataDir: string | null = null;

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  for (const server of servers.splice(0)) await server.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

function runStub(port: number): { child: ChildProcess; messages: any[]; exited: Promise<number> } {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-test-'));
  const child = spawn(process.execPath, [STUB], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CHROME_MCP_PORT: String(port),
      MCP_HTTP_PORT: String(port),
      CHROME_MCP_AGENT_DATA_DIR: dataDir,
    },
  });
  children.push(child);
  const messages: any[] = [];
  collect(child, (m) => messages.push(m));
  const exited = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));

  child.stdin!.write(
    frame({
      version: 2,
      type: 'hello',
      traceId: crypto.randomUUID(),
      role: 'extension-background',
      agent: { name: 'chrome-mcp-extension', version: '2' },
      supportedVersions: [2],
    }),
  );
  child.stdin!.write(
    frame({
      version: 2,
      type: 'request',
      requestId: 'req-start',
      traceId: 'trace-start',
      method: 'native.start',
      deadlineAt: Date.now() + 15_000,
      params: { port },
    }),
  );
  return { child, messages, exited };
}

describeIfBuilt('bootstrap stub', () => {
  test('reuses a running server and hands its channel over, then exits', async () => {
    const server = await startFakeServer({ issueChannel: true });
    servers.push(server);

    const { messages, exited } = runStub(server.port);
    expect(await exited).toBe(0);

    // Completes the handshake, or the extension will not trust the channel.
    expect(messages.find((m) => m.type === 'hello')?.selectedVersion).toBe(2);
    expect(messages.some((m) => m.type === 'capabilities')).toBe(true);

    const ready = messages.find((m) => m.event === 'native.eventChannelReady');
    expect(ready?.data).toMatchObject({ port: 54321, token: 'channel-token' });
    expect(messages.find((m) => m.event === 'native.serverStarted')?.data).toMatchObject({
      port: server.port,
    });
    // The pending native.start is answered rather than left hanging.
    expect(
      messages.find((m) => m.type === 'response' && m.requestId === 'req-start'),
    ).toMatchObject({ ok: true });

    // It did not start a second server on top of the one already listening.
    expect(server.bootstrapCalls).toBe(1);
    expect(server.authHeaders[0]).toMatch(/^Bearer .+/);
  }, 30_000);

  test('two stubs against one server both get their own channel', async () => {
    const server = await startFakeServer({ issueChannel: true });
    servers.push(server);

    const first = runStub(server.port);
    const second = runStub(server.port);
    expect(await first.exited).toBe(0);
    expect(await second.exited).toBe(0);

    // Nobody is evicted and nobody waits: two browsers, two channels, one server.
    expect(server.bootstrapCalls).toBe(2);
    for (const run of [first, second]) {
      expect(run.messages.some((m) => m.event === 'native.eventChannelReady')).toBe(true);
    }
  }, 30_000);

  test('reports an error and fails when the server will not issue a channel', async () => {
    const server = await startFakeServer({ issueChannel: false });
    servers.push(server);

    const { messages, exited } = runStub(server.port);
    expect(await exited).toBe(1);

    expect(messages.find((m) => m.event === 'native.error')?.data?.message).toMatch(/channel/i);
    expect(messages.some((m) => m.event === 'native.eventChannelReady')).toBe(false);
  }, 30_000);

  test('nothing but framed messages reaches stdout', async () => {
    const server = await startFakeServer({ issueChannel: true });
    servers.push(server);

    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stub-test-'));
    const child = spawn(process.execPath, [STUB], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        CHROME_MCP_PORT: String(server.port),
        CHROME_MCP_AGENT_DATA_DIR: dataDir,
      },
    });
    children.push(child);
    const raw: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => raw.push(chunk));
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdin!.write(
      frame({
        version: 2,
        type: 'hello',
        traceId: crypto.randomUUID(),
        role: 'extension-background',
        agent: { name: 'chrome-mcp-extension', version: '2' },
        supportedVersions: [2],
      }),
    );
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));

    // A stray console.log here would corrupt the native messaging stream, and the
    // failure would look like a protocol bug in the extension.
    const out = Buffer.concat(raw);
    let offset = 0;
    while (offset + 4 <= out.length) {
      const size = out.readUInt32LE(offset);
      expect(size).toBeGreaterThan(0);
      offset += 4 + size;
    }
    expect(offset).toBe(out.length);
    // Diagnostics go to stderr, which the wrapper captures.
    expect(stderr).toMatch(/\[stub\]/);
  }, 30_000);
});
