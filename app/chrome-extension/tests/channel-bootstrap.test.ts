/**
 * Channel bootstrap tests
 * @description Two things this pins. First, a browser whose host could not bind the
 * HTTP port is still serving once it has joined the incumbent, so it must not report
 * itself degraded. Second, Model B: losing the socket is the normal state, and the way
 * out is the same bootstrap that runs when a browser opens — not a separate recovery
 * branch that only ever executes in rare conditions.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (message: unknown) => void;

function makePort() {
  const messageListeners: Listener[] = [];
  const disconnectListeners: Array<() => void> = [];
  return {
    posted: [] as any[],
    disconnected: false,
    onMessage: {
      addListener: (fn: Listener) => messageListeners.push(fn),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.push(fn),
      removeListener: vi.fn(),
    },
    postMessage(message: unknown) {
      (this.posted as unknown[]).push(message);
    },
    disconnect() {
      this.disconnected = true;
    },
    emit(message: unknown) {
      for (const fn of messageListeners) fn(message);
    },
  };
}

/** Enough of WebSocket for the bootstrap path, with the frames the extension sent. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  readonly OPEN = 1;
  readonly sent: string[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(): void {
    this.readyState = 3;
  }

  /** The server accepting our hello, which is what makes the socket the data path. */
  ack(): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'hello-ack', instanceId: 'x' }) });
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

const channelReady = () => ({
  version: 2,
  type: 'event',
  event: 'native.eventChannelReady',
  data: { port: 51234, token: 'tok', expiresAt: Date.now() + 60_000 },
});

const serverStarted = (data: Record<string, unknown>) => ({
  version: 2,
  type: 'event',
  event: 'native.serverStarted',
  data: { port: 12306, ...data },
});

let port: ReturnType<typeof makePort>;
let stored: Record<string, any>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  port = makePort();
  stored = {};
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).chrome.runtime.connectNative = vi.fn().mockReturnValue(port);
  (globalThis as any).chrome.runtime.getManifest = vi.fn().mockReturnValue({ version: '1.2.3' });
  (globalThis as any).chrome.storage.local.get = vi
    .fn()
    .mockImplementation(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
    );
  (globalThis as any).chrome.storage.local.set = vi.fn().mockImplementation(async (patch: any) => {
    Object.assign(stored, patch);
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).WebSocket;
});

describe('instance identity', () => {
  it('mints a stable id, labels it, and sends it in the hello frame', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);

    port.emit(channelReady());
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();
    await vi.advanceTimersByTimeAsync(0);

    const hello = JSON.parse(socket.sent[0]);
    expect(hello).toMatchObject({
      type: 'hello',
      protocolVersion: 2,
      extensionVersion: '1.2.3',
    });
    expect(hello.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    // The label carries the id's prefix, which is what makes two same-brand
    // profiles distinguishable without any brand detection.
    expect(hello.label).toContain(hello.instanceId.slice(0, 4));

    // Persisted, so the identity survives a reload rather than being re-minted.
    expect(stored.nativeInstanceIdentity).toMatchObject({ instanceId: hello.instanceId });
  });

  it('reuses a stored identity instead of minting a new one', async () => {
    stored.nativeInstanceIdentity = { instanceId: 'kept-instance-id', label: 'My Profile' };
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    port.emit(channelReady());
    await vi.advanceTimersByTimeAsync(0);
    FakeWebSocket.instances[0].onopen?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(JSON.parse(FakeWebSocket.instances[0].sent[0])).toMatchObject({
      instanceId: 'kept-instance-id',
      label: 'My Profile',
    });
  });
});

describe('joining an incumbent', () => {
  it('reports the service as running, with no reclaim retries', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    const before = port.posted.filter((m) => m?.method === 'native.start').length;

    port.emit(serverStarted({ viaIncumbent: true }));
    await vi.advanceTimersByTimeAsync(0);

    expect(stored.serverStatus).toMatchObject({ isRunning: true, port: 12306 });
    // Joining is not a degraded state, so nothing re-asks for the port.
    await vi.advanceTimersByTimeAsync(61_000);
    expect(port.posted.filter((m) => m?.method === 'native.start').length).toBe(before);
  });
});

describe('model B: reconnect is the primary mechanism', () => {
  it('re-runs bootstrap when the socket drops', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    port.emit(channelReady());
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();
    socket.ack();
    await vi.advanceTimersByTimeAsync(0);

    expect(port.disconnected).toBe(false);
    socket.drop();
    await vi.advanceTimersByTimeAsync(0);

    // The port is dropped so the whole bootstrap can run again, rather than a
    // separate recovery path that patches the channel back up.
    expect(port.disconnected).toBe(true);

    const second = makePort();
    (globalThis as any).chrome.runtime.connectNative = vi.fn().mockReturnValue(second);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((globalThis as any).chrome.runtime.connectNative).toHaveBeenCalled();
  });
});
