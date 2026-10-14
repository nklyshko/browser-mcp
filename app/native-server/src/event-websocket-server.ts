import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { MCP_ALLOWED_ORIGINS_ENV, MCP_EXTENSION_ID_ENV } from './constant/index.js';

export interface EventChannelInfo {
  port: number;
  token: string;
  expiresAt: number;
}

/**
 * Identity an extension declares in its hello frame. The instanceId is minted by the
 * extension into chrome.storage.local, so it survives socket, service-worker and server
 * restarts alike; the label is a human- or launcher-supplied name for it.
 */
export interface ExtensionInstance {
  instanceId: string;
  label: string;
  browser: string;
  protocolVersion: number | null;
  extensionVersion: string | null;
  connectedAt: string;
}

interface Connection {
  socket: net.Socket;
  buffer: Buffer;
  instance: ExtensionInstance | null;
  helloTimer: ReturnType<typeof setTimeout> | null;
}

const MAX_FRAME_BYTES = 1 * 1024 * 1024;
const MAX_CONNECTIONS = 8;
const IDLE_TIMEOUT_MS = 90_000;
const HELLO_TIMEOUT_MS = 10_000;
const TOKEN_TTL_MS = 5 * 60_000;
const MAX_LABEL_BYTES = 64;
const TOKEN_BYTES = 32;
const INSTANCE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

function allowedOrigins(): string[] {
  return (process.env.CHROME_MCP_WS_ALLOWED_ORIGINS || process.env[MCP_ALLOWED_ORIGINS_ENV] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  const configured = allowedOrigins();
  if (configured.length) return configured.includes(origin);
  const expectedExtensionId = process.env[MCP_EXTENSION_ID_ENV]?.trim();
  return expectedExtensionId
    ? origin === `chrome-extension://${expectedExtensionId}`
    : /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

function closeSocket(socket: net.Socket, code = 1008): void {
  try {
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(code, 0);
    const frame = Buffer.concat([Buffer.from([0x88, payload.length]), payload]);
    socket.write(frame);
  } catch {
    // The peer may already be gone.
  }
  socket.destroy();
}

function frameText(payload: Buffer): Buffer {
  const header =
    payload.length < 126
      ? Buffer.from([0x81, payload.length])
      : payload.length < 65_536
        ? Buffer.from([0x81, 126, payload.length >> 8, payload.length & 0xff])
        : Buffer.from([
            0x81,
            127,
            0,
            0,
            0,
            0,
            payload.length >>> 24,
            (payload.length >>> 16) & 0xff,
            (payload.length >>> 8) & 0xff,
            payload.length & 0xff,
          ]);
  return Buffer.concat([header, payload]);
}

/** Labels reach error messages and /status, so strip control characters and bound them. */
export function sanitizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const trimmed = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!trimmed || Buffer.byteLength(trimmed) > MAX_LABEL_BYTES) return null;
  return trimmed;
}

export function parseHello(message: unknown): ExtensionInstance | null {
  const hello = message as Record<string, unknown> | null;
  if (!hello || hello.type !== 'hello') return null;
  if (typeof hello.instanceId !== 'string' || !INSTANCE_ID_PATTERN.test(hello.instanceId))
    return null;
  const label = sanitizeLabel(hello.label);
  if (!label) return null;
  return {
    instanceId: hello.instanceId,
    label,
    browser: sanitizeLabel(hello.browser) ?? 'unknown',
    protocolVersion: typeof hello.protocolVersion === 'number' ? hello.protocolVersion : null,
    extensionVersion:
      typeof hello.extensionVersion === 'string' ? hello.extensionVersion.slice(0, 32) : null,
    connectedAt: new Date().toISOString(),
  };
}

export interface EventChannelHandlers {
  /** Supplies the API key surfaced to the extension in the hello ack. */
  apiKey?: () => string;
  onMessage?: (message: unknown, instance: ExtensionInstance) => void;
  onHello?: (instance: ExtensionInstance) => void;
  onGone?: (instance: ExtensionInstance) => void;
}

export class LocalEventWebSocketServer {
  /** Used only when nothing else is hosting the upgrade. */
  private readonly ownServer = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  private server: http.Server = this.ownServer;
  private attached = false;
  private attachedPort: number | null = null;
  private readonly connections = new Set<Connection>();
  /** token -> expiresAt. One token is minted per bootstrap and consumed on upgrade. */
  private readonly pendingTokens = new Map<string, number>();
  private handlers: EventChannelHandlers = {};
  private readonly upgradeListener = (
    request: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ) => this.handleUpgrade(request, socket, head);

  constructor(handlers: EventChannelHandlers = {}) {
    this.handlers = handlers;
    this.ownServer.maxConnections = MAX_CONNECTIONS;
    this.ownServer.on('upgrade', this.upgradeListener);
  }

  setHandlers(handlers: EventChannelHandlers): void {
    this.handlers = handlers;
  }

  /**
   * Serve the upgrade on an existing HTTP server instead of a private one.
   *
   * This is what lets a standalone browser dial in with nothing but the port it already
   * knows: the channel lives on the same 12306 everything else uses, so there is no
   * second, ephemeral port to discover or configure.
   */
  attachTo(server: http.Server, port: number): void {
    if (this.attached) return;
    this.detachOwnServer();
    this.server = server;
    this.attached = true;
    this.attachedPort = port;
    server.on('upgrade', this.upgradeListener);
  }

  private detachOwnServer(): void {
    this.ownServer.off('upgrade', this.upgradeListener);
    if (this.ownServer.listening) this.ownServer.close();
  }

  /** Binds on first call, then mints a fresh single-use token for this bootstrap. */
  async start(): Promise<EventChannelInfo> {
    if (this.attached) {
      this.pruneTokens();
      const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
      const expiresAt = Date.now() + TOKEN_TTL_MS;
      this.pendingTokens.set(token, expiresAt);
      return { port: this.attachedPort!, token, expiresAt };
    }
    if (!this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          this.server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          this.server.off('error', onError);
          resolve();
        };
        this.server.once('error', onError);
        this.server.once('listening', onListening);
        this.server.listen(0, '127.0.0.1');
      });
    }
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Event channel failed to bind');
    this.pruneTokens();
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    this.pendingTokens.set(token, expiresAt);
    return { port: address.port, token, expiresAt };
  }

  /** Every instance that has completed a hello. */
  instances(): ExtensionInstance[] {
    return [...this.connections]
      .map((connection) => connection.instance)
      .filter((instance): instance is ExtensionInstance => instance !== null);
  }

  publishTo(instanceId: string, message: unknown): boolean {
    return this.publishRaw(instanceId, JSON.stringify(message));
  }

  /** For callers that already serialized, so a message is encoded exactly once. */
  publishRaw(instanceId: string, payload: string): boolean {
    for (const connection of this.connections) {
      if (connection.instance?.instanceId === instanceId) return this.sendRaw(connection, payload);
    }
    return false;
  }

  broadcast(message: unknown): number {
    let delivered = 0;
    for (const connection of this.connections) {
      if (connection.instance && this.send(connection, message)) delivered += 1;
    }
    return delivered;
  }

  async stop(): Promise<void> {
    for (const connection of [...this.connections]) {
      closeSocket(connection.socket, 1001);
      this.dropConnection(connection);
    }
    this.pendingTokens.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private send(connection: Connection, message: unknown): boolean {
    return this.sendRaw(connection, JSON.stringify(message));
  }

  private sendRaw(connection: Connection, payload: string): boolean {
    if (connection.socket.destroyed) return false;
    const bytes = Buffer.from(payload);
    if (bytes.length > MAX_FRAME_BYTES) return false;
    try {
      connection.socket.write(frameText(bytes));
      return true;
    } catch {
      return false;
    }
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [token, expiresAt] of this.pendingTokens) {
      if (now >= expiresAt) this.pendingTokens.delete(token);
    }
  }

  private consumeToken(provided: string): boolean {
    if (!provided) return false;

    // No stub ran, so no token was minted: a standalone browser presents the API key
    // instead. Not consumed, because it is long-lived by design.
    const apiKey = this.handlers.apiKey?.();
    if (apiKey && provided.length === apiKey.length) {
      if (crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(apiKey))) return true;
    }

    this.pruneTokens();
    const candidate = Buffer.from(provided);
    for (const token of this.pendingTokens.keys()) {
      const known = Buffer.from(token);
      if (known.length !== candidate.length) continue;
      if (!crypto.timingSafeEqual(known, candidate)) continue;
      this.pendingTokens.delete(token);
      return true;
    }
    return false;
  }

  private dropConnection(connection: Connection): void {
    if (!this.connections.delete(connection)) return;
    if (connection.helloTimer) clearTimeout(connection.helloTimer);
    connection.helloTimer = null;
    // Fires synchronously, so a reconnecting instance is detached before the newer
    // connection is attached rather than after it.
    if (connection.instance) this.handlers.onGone?.(connection.instance);
  }

  private handleUpgrade(request: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const key = request.headers['sec-websocket-key'];
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : undefined;
    if (
      url.pathname !== '/events' ||
      typeof key !== 'string' ||
      !isAllowedOrigin(origin) ||
      this.connections.size >= MAX_CONNECTIONS
    ) {
      socket.destroy();
      return;
    }
    // Checked last so a rejected upgrade cannot burn a live token.
    if (!this.consumeToken(url.searchParams.get('token') || '')) {
      socket.destroy();
      return;
    }

    const connection: Connection = { socket, buffer: head, instance: null, helloTimer: null };
    this.connections.add(connection);
    socket.setNoDelay(true);
    socket.setTimeout(IDLE_TIMEOUT_MS, () => closeSocket(socket, 1001));
    connection.helloTimer = setTimeout(() => {
      if (!connection.instance) closeSocket(socket, 1008);
    }, HELLO_TIMEOUT_MS);
    socket.on('data', (chunk) => {
      socket.setTimeout(IDLE_TIMEOUT_MS);
      connection.buffer = Buffer.concat([connection.buffer, chunk]);
      this.processFrames(connection);
    });
    const drop = () => this.dropConnection(connection);
    socket.on('close', drop);
    socket.on('error', drop);

    const accept = crypto
      .createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    if (connection.buffer.length) this.processFrames(connection);
  }

  private acceptHello(connection: Connection, message: unknown): void {
    const instance = parseHello(message);
    if (!instance) {
      closeSocket(connection.socket, 1008);
      return;
    }
    if (connection.helloTimer) {
      clearTimeout(connection.helloTimer);
      connection.helloTimer = null;
    }
    // An extension reload can leave the previous socket half-open. Newest wins, so the
    // same instance never appears twice and turns its own label ambiguous.
    for (const existing of [...this.connections]) {
      if (existing === connection) continue;
      if (existing.instance?.instanceId !== instance.instanceId) continue;
      closeSocket(existing.socket, 1001);
      this.dropConnection(existing);
    }
    connection.instance = instance;
    // The key travels back over the channel because an extension cannot read the file
    // it lives in, and the popup has to put it in the snippet people copy. No new
    // capability is granted: anything that can complete this hello can already drive
    // the browser directly.
    this.send(connection, {
      type: 'hello-ack',
      instanceId: instance.instanceId,
      apiKey: this.handlers.apiKey?.() ?? null,
    });
    this.handlers.onHello?.(instance);
  }

  private processFrames(connection: Connection): void {
    const socket = connection.socket;
    while (connection.buffer.length >= 2) {
      const first = connection.buffer[0];
      const second = connection.buffer[1];
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (!masked) return closeSocket(socket, 1002);
      if (length === 126) {
        if (connection.buffer.length < 4) return;
        length = connection.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (connection.buffer.length < 10 || connection.buffer.readUInt32BE(2) !== 0)
          return closeSocket(socket, 1009);
        length = connection.buffer.readUInt32BE(6);
        offset = 10;
      }
      if (length > MAX_FRAME_BYTES) return closeSocket(socket, 1009);
      const frameSize = offset + 4 + length;
      if (connection.buffer.length < frameSize) return;
      const mask = connection.buffer.subarray(offset, offset + 4);
      const payload = Buffer.alloc(length);
      for (let i = 0; i < length; i += 1)
        payload[i] = connection.buffer[offset + 4 + i] ^ mask[i % 4];
      connection.buffer = connection.buffer.subarray(frameSize);
      const opcode = first & 0x0f;
      if (opcode === 0x8) return closeSocket(socket, 1000);
      if (opcode === 0x9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, payload.length]), payload]));
        continue;
      }
      if (opcode !== 0x1) return closeSocket(socket, 1003);
      let message: unknown;
      try {
        message = JSON.parse(payload.toString('utf8'));
      } catch {
        return closeSocket(socket, 1007);
      }
      // Pings are allowed before hello so a heartbeat timer cannot race the handshake.
      if ((message as { type?: unknown } | null)?.type === 'ping') {
        this.send(connection, { type: 'pong', at: Date.now() });
        continue;
      }
      if (!connection.instance) {
        this.acceptHello(connection, message);
        continue;
      }
      this.handlers.onMessage?.(message, connection.instance);
    }
  }
}
