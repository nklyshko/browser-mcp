/**
 * Standalone fallback tests
 * @description With no native messaging host registered, the extension has to reach a
 * hand-started server by itself. The catch: a missing host does not fail synchronously —
 * Chrome returns a Port and reports the problem through onDisconnect — so a fallback
 * guarded on the synchronous failure never runs. That is what these pin.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readonly OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(): void {}
  close(): void {
    this.readyState = 3;
  }
}

let disconnectListeners: Array<() => void>;
let stored: Record<string, any>;

function makePort() {
  disconnectListeners = [];
  return {
    posted: [] as any[],
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
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
});
