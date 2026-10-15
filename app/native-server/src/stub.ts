#!/usr/bin/env node
/**
 * The bootstrap stub: what Chrome actually launches.
 *
 * An extension cannot start a process, which is the entire remaining justification for
 * native messaging. So this runs, makes sure a server exists, hands the extension a
 * channel to it, and exits — leaving one server that no browser owns, governed by its own
 * idle timeout rather than by whichever browser happened to start it.
 *
 * Nothing but framed native messages may reach stdout; diagnostics go to stderr, which
 * the wrapper script captures.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import {
  NATIVE_PROTOCOL_VERSION,
  createNativeCapabilities,
  createNativeHello,
  negotiateNativeProtocolVersion,
} from '@ethanwilkins/chrome-mcp-shared-2026';
import { NATIVE_SERVER_PORT } from './constant/index.js';
import { MAX_NATIVE_MESSAGE_SIZE_BYTES, NativeMessageFrameDecoder } from './native-frame.js';
import { isServerReady, requestChannel, waitForServer } from './bootstrap-client.js';

/** Give up rather than hold Chrome's port open forever if nothing can be reached. */
const OVERALL_DEADLINE_MS = 20_000;

function log(message: string): void {
  process.stderr.write(`[stub] ${message}\n`);
}

function send(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message));
  if (body.length > MAX_NATIVE_MESSAGE_SIZE_BYTES) {
    log('refusing to send an oversized message');
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stdout.write(Buffer.concat([header, body]));
}

function resolvePort(requested?: unknown): number {
  const configured = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  if (configured) {
    const port = Number.parseInt(configured, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  const port = typeof requested === 'number' ? requested : Number(requested);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : NATIVE_SERVER_PORT;
}

/**
 * Detached, unref'd, stdio ignored — the inverse of the autostart path, which
 * deliberately ties its server to the client that spawned it. This one has to outlive
 * us, and we exit in a moment.
 */
function spawnServer(port: number): void {
  const entry = path.join(__dirname, 'index.js');
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      // No native peer: it must not read stdin or write framed messages to stdout.
      CHROME_MCP_STANDALONE: '1',
      // Lets it exit quietly if it loses the race to bind, rather than lingering.
      CHROME_MCP_SPAWNED_BY_STUB: '1',
      CHROME_MCP_PORT: String(port),
      MCP_HTTP_PORT: String(port),
    },
  });
  child.unref();
  log(`spawned a server for port ${port}`);
}

let bootstrapped = false;
/** Set while the async bootstrap is running, so nothing exits out from under it. */
let bootstrapInFlight = false;
let sawHello = false;
let requestedPort: unknown;
let pendingStart: { requestId: string; traceId: string } | null = null;

async function bootstrap(): Promise<void> {
  if (bootstrapped) return;
  bootstrapped = true;
  bootstrapInFlight = true;
  const port = resolvePort(requestedPort);

  if (await isServerReady(port)) {
    log(`a server is already listening on ${port}`);
  } else {
    spawnServer(port);
  }

  // Polled rather than assumed: under the spawn race another stub may have started the
  // server that actually won the bind, and ours may have exited.
  if (!(await waitForServer(port))) {
    log(`no server became reachable on ${port}`);
    send({
      version: NATIVE_PROTOCOL_VERSION,
      type: 'event',
      event: 'native.error',
      data: { code: 'BROWSER_ERROR', message: `No MCP server became reachable on ${port}.` },
    });
    finish(1);
    return;
  }

  const channel = await requestChannel(port);
  if (!channel) {
    log('the server would not issue a channel');
    send({
      version: NATIVE_PROTOCOL_VERSION,
      type: 'event',
      event: 'native.error',
      data: { code: 'BROWSER_ERROR', message: 'The MCP server would not issue a channel.' },
    });
    finish(1);
    return;
  }

  send({
    version: NATIVE_PROTOCOL_VERSION,
    type: 'event',
    event: 'native.eventChannelReady',
    data: channel,
  });
  send({
    version: NATIVE_PROTOCOL_VERSION,
    type: 'event',
    event: 'native.serverStarted',
    data: { port },
  });
  if (pendingStart) {
    send({
      version: NATIVE_PROTOCOL_VERSION,
      type: 'response',
      requestId: pendingStart.requestId,
      traceId: pendingStart.traceId,
      ok: true,
      result: { started: true },
    });
    pendingStart = null;
  }
  log(`handed over a channel on ${channel.port}; exiting`);
  finish(0);
}

/** Lets stdout flush before the process goes away, or the extension loses the channel. */
function finish(code: number): void {
  bootstrapInFlight = false;
  setTimeout(() => process.exit(code), 50);
}

/**
 * stdin closing is not a reason to abandon a bootstrap already in flight. Chrome keeps
 * the pipe open, but a closed stdin otherwise cut the channel handover short — the
 * extension got the handshake and never the channel.
 */
function requestExit(code: number): void {
  if (bootstrapInFlight) return;
  finish(code);
}

function handle(message: any): void {
  if (!message || typeof message !== 'object') return;
  switch (message.type) {
    case 'hello': {
      const selected = negotiateNativeProtocolVersion(message.supportedVersions);
      if (selected === null) {
        log('no mutually supported protocol version');
        finish(1);
        return;
      }
      // The extension needs a peer that speaks the protocol before it will trust the
      // channel, so the stub completes the handshake even though it serves nothing.
      send({
        ...createNativeHello(
          'native-service',
          { name: 'chrome-mcp-stub', version: '2' },
          message.traceId,
        ),
        selectedVersion: selected,
      });
      send(createNativeCapabilities(message.traceId));
      sawHello = true;
      return;
    }
    case 'request':
      if (message.method === 'native.start') {
        requestedPort = message.params?.port ?? requestedPort;
        pendingStart = { requestId: message.requestId, traceId: message.traceId };
      }
      return;
    default:
      return;
  }
}

const decoder = new NativeMessageFrameDecoder();

stdin.on('readable', () => {
  let chunk;
  while ((chunk = stdin.read()) !== null) decoder.append(chunk);
  try {
    for (const buffer of decoder.readMessages()) handle(JSON.parse(buffer.toString()));
  } catch (error) {
    log(`failed to read a message: ${error instanceof Error ? error.message : String(error)}`);
  }
  // Both hello and native.start usually arrive in one chunk, so act after the batch:
  // that way the port the extension asked for is known before anything is started.
  if (sawHello) void bootstrap();
});

stdin.on('end', () => requestExit(0));
stdin.on('error', () => requestExit(1));

setTimeout(() => {
  if (bootstrapped) return;
  log('no usable message arrived; exiting');
  finish(1);
}, OVERALL_DEADLINE_MS).unref();
