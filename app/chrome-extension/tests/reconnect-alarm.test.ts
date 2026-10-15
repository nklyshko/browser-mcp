/**
 * Reconnect durability tests
 * @description Model B treats "no channel" as the normal state and reconnects out of it.
 * That only holds if the reconnect survives the service worker being evicted — and the
 * keepalive is released the moment the channel closes, so eviction is exactly what
 * happens next. A setTimeout dies with the worker; an alarm wakes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let alarms: Array<{ name: string; info: any }>;
let cleared: string[];
let alarmListeners: Array<(a: { name: string }) => void>;
let connectNative: any;
let port: any;

/** Enough of WebSocket for the channel to open and then drop. */
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
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

function makePort() {
  const listeners: Array<(m: unknown) => void> = [];
  return {
    posted: [] as any[],
    onMessage: { addListener: (f: any) => listeners.push(f), removeListener: vi.fn() },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    postMessage(m: unknown) {
      this.posted.push(m);
    },
    disconnect: vi.fn(),
    emit(m: unknown) {
      for (const f of listeners) f(m);
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  alarms = [];
  cleared = [];
  alarmListeners = [];
  port = makePort();
  FakeWebSocket.instances = [];
  (globalThis as any).WebSocket = FakeWebSocket;
  connectNative = vi.fn().mockReturnValue(port);
  (globalThis as any).chrome.runtime.connectNative = connectNative;
  (globalThis as any).chrome.storage.local.get = vi.fn().mockResolvedValue({});
  (globalThis as any).chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
  (globalThis as any).chrome.alarms = {
    create: vi.fn().mockImplementation(async (name: string, info: any) => {
      alarms.push({ name, info });
    }),
    clear: vi.fn().mockImplementation(async (name: string) => {
      cleared.push(name);
    }),
    onAlarm: { addListener: (fn: any) => alarmListeners.push(fn) },
  };
});

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as any).WebSocket;
});

describe('reconnect alarm', () => {
  it('registers a repeating watchdog, which cannot be cleared into uselessness', async () => {
    const mod = await import('../entrypoints/background/native-host');
    mod.initNativeReconnectAlarm();
    mod.connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);

    // Bring the channel up, then lose it — the moment the keepalive is released and
    // MV3 is free to evict the worker.
    port.emit({
      version: 2,
      type: 'event',
      event: 'native.eventChannelReady',
      data: { port: 51234, token: 'tok', expiresAt: Date.now() + 60_000 },
    });
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    socket.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    socket.drop();
    await vi.advanceTimersByTimeAsync(0);

    const reconnect = alarms.filter((a) => a.name === 'native-host-reconnect');
    expect(reconnect.length).toBe(1);
    // Repeating, not one-shot: an arm-and-clear scheme left a worker with nothing
    // scheduled if it was evicted at the wrong moment.
    expect(reconnect[0].info.periodInMinutes).toBe(1);
    // And a reconnect must never clear it.
    expect(cleared).not.toContain('native-host-reconnect');
  });

  it('retries when only the watchdog fires, with every timer lost', async () => {
    // No port can be obtained, so nothing else could mask the alarm doing the work.
    connectNative = vi.fn().mockImplementation(() => {
      throw new Error('native host unavailable');
    });
    (globalThis as any).chrome.runtime.connectNative = connectNative;
    const mod = await import('../entrypoints/background/native-host');
    mod.initNativeReconnectAlarm();
    mod.connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    const before = connectNative.mock.calls.length;

    // Simulate eviction: discard every pending timer, then deliver the alarm.
    vi.clearAllTimers();
    for (const fn of alarmListeners) fn({ name: 'native-host-reconnect' });
    await vi.advanceTimersByTimeAsync(0);

    expect(connectNative.mock.calls.length).toBeGreaterThan(before);
  });

  it('ignores unrelated alarms', async () => {
    connectNative = vi.fn().mockImplementation(() => {
      throw new Error('native host unavailable');
    });
    (globalThis as any).chrome.runtime.connectNative = connectNative;
    const mod = await import('../entrypoints/background/native-host');
    mod.initNativeReconnectAlarm();
    mod.connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);
    const before = connectNative.mock.calls.length;

    for (const fn of alarmListeners) fn({ name: 'some-other-feature' });
    await vi.advanceTimersByTimeAsync(0);

    expect(connectNative.mock.calls.length).toBe(before);
  });
});
