import { request as httpRequest } from 'node:http';
import type { EventChannelInfo } from './event-websocket-server.js';
import { resolveApiKey } from './api-key.js';

const PING_TIMEOUT_MS = 750;
const BOOTSTRAP_TIMEOUT_MS = 3_000;
const POLL_INTERVAL_MS = 150;
/** Enough for a cold Node start on a loaded machine, short enough to fail visibly. */
const READY_TIMEOUT_MS = 15_000;

function get(
  path: string,
  port: number,
  timeout: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method: 'GET',
        headers: { Connection: 'close' },
        timeout,
      },
      (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.end();
  });
}

export async function isServerReady(port: number): Promise<boolean> {
  const { status } = await get('/ping', port, PING_TIMEOUT_MS);
  return status === 200;
}

export async function waitForServer(port: number, timeoutMs = READY_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerReady(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return isServerReady(port);
}

/**
 * Ask the server that owns `port` for a channel to hand to an extension.
 *
 * Used by the stub whether or not it was the one that spawned the server: under the
 * spawn race two stubs can both start one, and only the process that won the bind is
 * answering here. Nobody assumes their own child won.
 */
export function requestChannel(port: number): Promise<EventChannelInfo | null> {
  return new Promise((resolve) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port,
        path: '/__chrome_mcp_bridge/bootstrap',
        method: 'POST',
        headers: {
          Connection: 'close',
          Origin: 'http://127.0.0.1',
          Authorization: `Bearer ${resolveApiKey()}`,
        },
        timeout: BOOTSTRAP_TIMEOUT_MS,
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          if (body.length < 4096) body += chunk;
        });
        response.on('end', () => {
          try {
            const channel = (JSON.parse(body) as { channel?: EventChannelInfo }).channel;
            resolve(
              channel &&
                typeof channel.port === 'number' &&
                typeof channel.token === 'string' &&
                typeof channel.expiresAt === 'number'
                ? channel
                : null,
            );
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}
