import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import crypto from 'node:crypto';
import net from 'node:net';
import { LocalEventWebSocketServer } from './event-websocket-server.js';
import { ExtensionRegistry } from './extension-registry.js';
import {
  clearSelection,
  listInstances,
  resolveSessionHost,
  selectInstance,
  type InstanceDirectory,
} from './instance-selection.js';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;

/**
 * Two real sockets through the real channel, registry and selection path — the closest
 * thing to two browsers without launching Chrome.
 */
class FakeBrowser {
  private socket!: net.Socket;
  private buffer = Buffer.alloc(0);
  readonly received: any[] = [];

  constructor(
    readonly instanceId: string,
    readonly label: string,
  ) {}

  async connect(port: number, token: string): Promise<void> {
    const key = crypto.randomBytes(16).toString('base64');
    this.socket = net.connect(port, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      this.socket.once('connect', resolve);
      this.socket.once('error', reject);
    });
    this.socket.write(
      `GET /events?token=${encodeURIComponent(token)} HTTP/1.1\r\nHost: 127.0.0.1\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\n` +
        `Sec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`,
    );
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        if (!chunk.toString('latin1').startsWith('HTTP/1.1 101')) {
          reject(new Error('upgrade refused'));
          return;
        }
        this.socket.off('data', onData);
        this.socket.on('data', (next) => this.onData(next));
        resolve();
      };
      this.socket.on('data', onData);
    });
    this.send({
      type: 'hello',
      instanceId: this.instanceId,
      label: this.label,
      browser: 'Chrome/143',
      protocolVersion: 2,
      extensionVersion: '1.0.0',
    });
    // Then the protocol handshake on the same socket, as the extension does once the
    // channel acks: the host on this end has its own version to negotiate.
    this.send({
      version: 2,
      type: 'hello',
      traceId: crypto.randomUUID(),
      role: 'extension-background',
      agent: { name: 'chrome-mcp-extension', version: '2' },
      supportedVersions: [2],
    });
  }

  send(message: unknown): void {
    const payload = Buffer.from(JSON.stringify(message));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const header =
      payload.length < 126
        ? Buffer.from([0x81, 0x80 | payload.length])
        : Buffer.from([0x81, 0x80 | 126, payload.length >> 8, payload.length & 0xff]);
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  /** Answers whatever request arrived last, as a real extension would. */
  answerLastRequest(result: unknown): void {
    const request = [...this.received].reverse().find((m) => m?.type === 'request');
    if (!request) throw new Error('no request to answer');
    this.send({
      version: 2,
      type: 'response',
      requestId: request.requestId,
      traceId: request.traceId,
      ok: true,
      result,
    });
  }

  close(): void {
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
        this.received.push(JSON.parse(payload.toString('utf8')));
      } catch {
        // Only JSON frames matter here.
      }
    }
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80));

describe('two browsers on one server', () => {
  let channel: LocalEventWebSocketServer;
  let registry: ExtensionRegistry;
  let directory: InstanceDirectory;
  let work: FakeBrowser;
  let personal: FakeBrowser;

  beforeEach(async () => {
    channel = new LocalEventWebSocketServer();
    registry = new ExtensionRegistry();
    registry.adopt(channel);
    directory = {
      instances: () => registry.instances(),
      hostFor: (id) => registry.hostFor(id),
      soleHost: () => registry.soleHost(),
    };
    for (const session of ['s1', 's2']) clearSelection(session);

    work = new FakeBrowser('11111111-1111-4111-8111-111111111111', 'Work');
    personal = new FakeBrowser('22222222-2222-4222-8222-222222222222', 'Personal');
    const first = await channel.start();
    await work.connect(first.port, first.token);
    const second = await channel.start();
    await personal.connect(second.port, second.token);
    await settle();
  });

  afterEach(async () => {
    work.close();
    personal.close();
    for (const { instanceId } of registry.instances()) {
      registry.hostFor(instanceId)?.getArtifactStore().dispose();
      registry.detach(instanceId);
    }
    await channel.stop();
  });

  test('both arrive as separate instances with their own hosts', () => {
    expect(
      registry
        .instances()
        .map((i) => i.label)
        .sort(),
    ).toEqual(['Personal', 'Work']);
    expect(registry.hostFor(work.instanceId)).not.toBe(registry.hostFor(personal.instanceId));
  });

  test('a tool call reaches only the selected browser', async () => {
    selectInstance(directory, 's1', 'Work');
    const host = resolveSessionHost(directory, 's1')!;

    const call = host.sendRequestToExtensionAndWait(
      { name: 'chrome_navigate' },
      'call_tool',
      4_000,
    );
    await settle();

    // The frame landed on Work's socket and nowhere near Personal's.
    expect(work.received.filter((m) => m?.type === 'request')).toHaveLength(1);
    expect(personal.received.filter((m) => m?.type === 'request')).toHaveLength(0);

    work.answerLastRequest({ status: 'success', from: 'work' });
    await expect(call).resolves.toMatchObject({ from: 'work' });
  });

  test('two sessions drive different browsers concurrently without crossing', async () => {
    selectInstance(directory, 's1', 'Work');
    selectInstance(directory, 's2', 'Personal');

    const a = resolveSessionHost(directory, 's1')!.sendRequestToExtensionAndWait(
      { name: 'chrome_navigate' },
      'call_tool',
      4_000,
    );
    const b = resolveSessionHost(directory, 's2')!.sendRequestToExtensionAndWait(
      { name: 'chrome_navigate' },
      'call_tool',
      4_000,
    );
    await settle();

    // Answered out of order on purpose: results must follow the socket, not the clock.
    personal.answerLastRequest({ status: 'success', from: 'personal' });
    work.answerLastRequest({ status: 'success', from: 'work' });

    await expect(a).resolves.toMatchObject({ from: 'work' });
    await expect(b).resolves.toMatchObject({ from: 'personal' });
  });

  test('an unselected session refuses to guess between them', () => {
    expect(() => resolveSessionHost(directory, 's1')).toThrow(/More than one browser/);
  });

  test('closing one browser leaves the other working and fails the bound session', async () => {
    selectInstance(directory, 's1', 'Personal');
    selectInstance(directory, 's2', 'Work');
    const doomed = resolveSessionHost(directory, 's1')!;

    const inflight = doomed.sendRequestToExtensionAndWait(
      { name: 'chrome_click_element' },
      'call_tool',
      4_000,
    );
    // Attached before the socket drops: otherwise the rejection lands during settle()
    // with no handler and surfaces as an unhandled rejection.
    // Side-effecting call on a dropped socket: the state is unknown, not merely cancelled.
    const rejected = expect(inflight).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    personal.close();
    await settle();
    await rejected;
    expect(() => resolveSessionHost(directory, 's1')).toThrow(/no longer connected/);

    // The survivor is untouched and still resolvable for its own session.
    expect(registry.instances().map((i) => i.label)).toEqual(['Work']);
    const survivor = resolveSessionHost(directory, 's2')!;
    const call = survivor.sendRequestToExtensionAndWait(
      { name: 'chrome_navigate' },
      'call_tool',
      4_000,
    );
    await settle();
    work.answerLastRequest({ status: 'success', from: 'work' });
    await expect(call).resolves.toMatchObject({ from: 'work' });
  });

  test('the listing reflects per-session selection', () => {
    selectInstance(directory, 's1', 'Work');
    expect(listInstances(directory, 's1').find((i) => i.selected)?.label).toBe('Work');
    expect(listInstances(directory, 's2').some((i) => i.selected)).toBe(false);
  });
});
