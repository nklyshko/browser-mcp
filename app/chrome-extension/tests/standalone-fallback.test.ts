/**
 * Standalone fallback tests
 * @description With no native messaging host registered, the extension has to reach a
 * hand-started server by itself. The catch: a missing host does not fail synchronously —
 * Chrome returns a Port and reports the problem through onDisconnect — so a fallback
 * guarded on the synchronous failure never runs. That is what these pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NATIVE_PROTOCOL_VERSION } from '@ethanwilkins/chrome-mcp-shared-2026';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  readonly OPEN = 1;
  readyState = 1;
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
}

let disconnectListeners: Array<() => void>;
let messageListeners: Array<(message: unknown) => void | Promise<void>>;
let stored: Record<string, any>;

function makePort() {
  disconnectListeners = [];
  messageListeners = [];
  return {
    posted: [] as any[],
    onMessage: {
      addListener: (fn: (message: unknown) => void | Promise<void>) => messageListeners.push(fn),
      removeListener: vi.fn(),
    },
    onDisconnect: {
      addListener: (fn: () => void) => disconnectListeners.push(fn),
      removeListener: vi.fn(),
    },
    postMessage(m: unknown) {
      this.posted.push(m);
    },
    disconnect: vi.fn(),
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeWebSocket.instances = [];
  stored = { mcpApiKey: 'stored-api-key', nativeServerPort: 12306 };
  (globalThis as any).WebSocket = FakeWebSocket;
  (globalThis as any).chrome.alarms = {
    create: vi.fn(),
    clear: vi.fn(),
    onAlarm: { addListener: vi.fn() },
  };
  // Chrome's real behaviour for an unregistered host: a Port, then onDisconnect.
  (globalThis as any).chrome.runtime.connectNative = vi.fn().mockReturnValue(makePort());
  (globalThis as any).chrome.runtime.lastError = { message: 'host not found' };
  (globalThis as any).chrome.storage.local.get = vi
    .fn()
    .mockImplementation(async (keys: string[]) =>
      Object.fromEntries(keys.filter((k) => k in stored).map((k) => [k, stored[k]])),
    );
  (globalThis as any).chrome.storage.local.set = vi.fn().mockImplementation(async (p: any) => {
    Object.assign(stored, p);
  });
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).WebSocket;
});

describe('standalone fallback', () => {
  it('dials the channel directly when the port disconnects with no channel', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeWebSocket.instances).toHaveLength(0);

    // The only signal a missing host ever gives.
    for (const fn of disconnectListeners) fn();
    await vi.advanceTimersByTimeAsync(10);

    expect(FakeWebSocket.instances).toHaveLength(1);
    const url = FakeWebSocket.instances[0].url;
    expect(url).toContain('127.0.0.1:12306/events');
    // The stored API key stands in for a channel token nobody minted.
    expect(url).toContain('token=stored-api-key');
  });

  it('falls back to a reconnect when no key has been stored', async () => {
    delete stored.mcpApiKey;
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    for (const fn of disconnectListeners) fn();
    await vi.advanceTimersByTimeAsync(10);

    // Nothing to authenticate with, so it must not dial, and must keep retrying.
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(stored.nativeConnectionState?.state).toBe('degraded');
  });

  async function offerChannelFromStubThenExit(
    readyState: number = FakeWebSocket.CONNECTING,
  ): Promise<FakeWebSocket> {
    for (const fn of messageListeners) {
      await fn({
        version: NATIVE_PROTOCOL_VERSION,
        type: 'event',
        event: 'native.eventChannelReady',
        data: { port: 12306, token: 'minted-token', expiresAt: Date.now() + 60_000 },
      });
    }
    const socket = FakeWebSocket.instances[0];
    socket.readyState = readyState;
    for (const fn of disconnectListeners) fn();
    await vi.advanceTimersByTimeAsync(10);
    return socket;
  }

  it.each([
    { state: 'connecting', readyState: FakeWebSocket.CONNECTING },
    { state: 'open but awaiting hello-ack', readyState: FakeWebSocket.OPEN },
  ])(
    'keeps a $state channel when the stub exits without a stored fallback key',
    async ({ readyState }) => {
      delete stored.mcpApiKey;
      const { connectNativeHost } = await import('../entrypoints/background/native-host');
      connectNativeHost(12306);
      await vi.advanceTimersByTimeAsync(0);

      const socket = await offerChannelFromStubThenExit(readyState);

      expect(socket.url).toContain('token=minted-token');
      expect(socket.closed).toBe(false);
      expect(FakeWebSocket.instances).toHaveLength(1);
    },
  );

  it('reconnects right away when that still-handshaking channel then fails', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    const socket = await offerChannelFromStubThenExit();
    const connectNative = (globalThis as any).chrome.runtime.connectNative;
    const attemptsBeforeFailure = connectNative.mock.calls.length;

    socket.onerror?.();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(connectNative.mock.calls.length).toBeGreaterThan(attemptsBeforeFailure);
  });
});
