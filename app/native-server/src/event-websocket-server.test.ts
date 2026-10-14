import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import crypto from 'node:crypto';
import net from 'node:net';
import {
  LocalEventWebSocketServer,
  parseHello,
  sanitizeLabel,
  type ExtensionInstance,
} from './event-websocket-server.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

/** Minimal client: the server speaks raw RFC 6455, so the test has to as well. */
class TestClient {
  readonly messages: unknown[] = [];
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);

  async connect(port: number, token: string, origin = ORIGIN): Promise<boolean> {
    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    this.socket.write(
      `GET /events?token=${encodeURIComponent(token)} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`,
    );
    const upgraded = await new Promise<boolean>((resolve) => {
      const onData = (chunk: Buffer) => {
        if (!chunk.toString('latin1').startsWith('HTTP/1.1 101')) return resolve(false);
        this.socket.off('data', onData);
        this.socket.on('data', (next) => this.onData(next));
        resolve(true);
      };
      this.socket.once('close', () => resolve(false));
      this.socket.on('data', onData);
    });
    return upgraded;
  }

  /** Writes the payload one byte per chunk, so frames arrive split across reads. */
  send(message: unknown, dribble = false): void {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
    const header =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    const frame = Buffer.concat([header, mask, masked]);
    if (!dribble) return void this.socket.write(frame);
    for (const byte of frame) this.socket.write(Buffer.from([byte]));
  }

  get closed(): boolean {
    return this.socket.destroyed || !this.socket.writable;
  }

  destroy(): void {
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      }
      if (this.buffer.length < offset + length) return;
      const payload = this.buffer.subarray(offset, offset + length);
      const opcode = this.buffer[0] & 0x0f;
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode !== 0x1) continue;
      try {
        this.messages.push(JSON.parse(payload.toString('utf8')));
      } catch {
        // Not a JSON frame; the tests only assert on JSON ones.
      }
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

function hello(instanceId: string, label: string) {
  return { type: 'hello', instanceId, label, browser: 'Chrome/143', protocolVersion: 2 };
}

describe('parseHello', () => {
  test('requires a well-formed instanceId and label', () => {
    expect(parseHello({ type: 'hello', instanceId: 'abcdefgh', label: 'A' })?.label).toBe('A');
    expect(parseHello({ type: 'hello', instanceId: 'short', label: 'A' })).toBeNull();
    expect(parseHello({ type: 'hello', instanceId: 'abcdefgh' })).toBeNull();
    expect(parseHello({ type: 'ping', instanceId: 'abcdefgh', label: 'A' })).toBeNull();
    expect(parseHello({ type: 'hello', instanceId: 'bad id!!', label: 'A' })).toBeNull();
  });

  test('strips control characters and rejects oversized labels', () => {
    expect(sanitizeLabel('Chrome\u0000 143')).toBe('Chrome 143');
    expect(sanitizeLabel('x'.repeat(65))).toBeNull();
    expect(sanitizeLabel('   ')).toBeNull();
  });
});

describe('LocalEventWebSocketServer', () => {
  let server: LocalEventWebSocketServer;
  let seen: ExtensionInstance[];
  let routed: Array<{ message: unknown; instanceId: string }>;

  beforeEach(() => {
    seen = [];
    routed = [];
    server = new LocalEventWebSocketServer({
      onMessage: (message, instance) => routed.push({ message, instanceId: instance.instanceId }),
      onHello: (instance) => seen.push(instance),
    });
  });

  afterEach(async () => {
    await server.stop();
  });

  test('keeps two connections isolated, including frames split across reads', async () => {
    const first = await server.start();
    const second = await server.start();
    const a = new TestClient();
    const b = new TestClient();
    expect(await a.connect(first.port, first.token)).toBe(true);
    expect(await b.connect(second.port, second.token)).toBe(true);

    // Interleaved and byte-dribbled: a shared parse buffer corrupts both.
    a.send(hello('instance-aaaa-1111', 'Chrome 143 (aaaa)'), true);
    b.send(hello('instance-bbbb-2222', 'Chrome 144 (bbbb)'), true);
    await settle();
    a.send({ type: 'from-a' });
    b.send({ type: 'from-b' });
    await settle();

    expect(
      server
        .instances()
        .map((instance) => instance.label)
        .sort(),
    ).toEqual(['Chrome 143 (aaaa)', 'Chrome 144 (bbbb)']);
    expect(routed).toEqual([
      { message: { type: 'from-a' }, instanceId: 'instance-aaaa-1111' },
      { message: { type: 'from-b' }, instanceId: 'instance-bbbb-2222' },
    ]);
    expect(seen).toHaveLength(2);
    a.destroy();
    b.destroy();
  });

  test('acks the hello and routes publishTo only to its own instance', async () => {
    const first = await server.start();
    const second = await server.start();
    const a = new TestClient();
    const b = new TestClient();
    await a.connect(first.port, first.token);
    await b.connect(second.port, second.token);
    a.send(hello('instance-aaaa-1111', 'A'));
    b.send(hello('instance-bbbb-2222', 'B'));
    await settle();

    // The ack carries the API key, because an extension cannot read the file it
    // lives in and the popup has to put it in the snippet people copy.
    expect(a.messages).toEqual([
      { type: 'hello-ack', instanceId: 'instance-aaaa-1111', apiKey: null },
    ]);
    expect(server.publishTo('instance-aaaa-1111', { type: 'event' })).toBe(true);
    expect(server.publishTo('instance-nope-0000', { type: 'event' })).toBe(false);
    await settle();

    expect(a.messages).toHaveLength(2);
    expect(b.messages).toHaveLength(1);
    expect(server.broadcast({ type: 'all' })).toBe(2);
    a.destroy();
    b.destroy();
  });

  test('surfaces the api key in the ack when one is supplied', async () => {
    server.setHandlers({ apiKey: () => 'generated-key' });
    const info = await server.start();
    const client = new TestClient();
    await client.connect(info.port, info.token);
    client.send(hello('instance-aaaa-1111', 'A'));
    await settle();

    expect(client.messages[0]).toMatchObject({ apiKey: 'generated-key' });
    client.destroy();
  });

  test('burns a token on use and refuses a replay of it', async () => {
    const info = await server.start();
    const a = new TestClient();
    expect(await a.connect(info.port, info.token)).toBe(true);
    const replay = new TestClient();
    expect(await replay.connect(info.port, info.token)).toBe(false);
    a.destroy();
  });

  test('refuses a non-extension origin without consuming the token', async () => {
    const info = await server.start();
    const page = new TestClient();
    expect(await page.connect(info.port, info.token, 'https://evil.example')).toBe(false);
    // The token must survive, or a drive-by upgrade would lock out the real extension.
    const real = new TestClient();
    expect(await real.connect(info.port, info.token)).toBe(true);
    real.destroy();
  });

  test('drops the older socket when the same instance reconnects', async () => {
    const first = await server.start();
    const second = await server.start();
    const stale = new TestClient();
    const fresh = new TestClient();
    await stale.connect(first.port, first.token);
    stale.send(hello('instance-aaaa-1111', 'A'));
    await settle();
    await fresh.connect(second.port, second.token);
    fresh.send(hello('instance-aaaa-1111', 'A again'));
    await settle();

    expect(server.instances()).toHaveLength(1);
    expect(server.instances()[0].label).toBe('A again');
    expect(stale.closed).toBe(true);
    fresh.destroy();
  });

  test('closes a connection whose first frame is not a hello', async () => {
    const info = await server.start();
    const client = new TestClient();
    await client.connect(info.port, info.token);
    client.send({ type: 'tool-call' });
    await settle();

    expect(server.instances()).toEqual([]);
    expect(routed).toEqual([]);
    expect(client.closed).toBe(true);
  });

  test('answers a ping before hello so a heartbeat cannot race the handshake', async () => {
    const info = await server.start();
    const client = new TestClient();
    await client.connect(info.port, info.token);
    client.send({ type: 'ping' });
    await settle();

    expect((client.messages[0] as { type: string }).type).toBe('pong');
    expect(client.closed).toBe(false);
    client.destroy();
  });
});
