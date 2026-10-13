/**
 * Port-reclaim retry tests
 * @description When two browsers run the extension, only one host can bind the
 * HTTP port. The loser used to give up permanently: the native channel stays up,
 * so nothing fires onDisconnect and the reconnect path is never entered, which
 * meant closing the winner left MCP dead until the loser's browser restarted.
 * These tests pin the retry that fixes it, and that it stops once the bind lands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (message: unknown) => void;

/** A stand-in for the native messaging Port, with the messages it received. */
function makePort() {
  const messageListeners: Listener[] = [];
  return {
    posted: [] as any[],
    onMessage: {
      addListener: (fn: Listener) => messageListeners.push(fn),
      removeListener: vi.fn(),
    },
    onDisconnect: { addListener: vi.fn(), removeListener: vi.fn() },
    postMessage(message: unknown) {
      (this.posted as unknown[]).push(message);
    },
    disconnect: vi.fn(),
    /** Push a protocol message as if the host had sent it. */
    emit(message: unknown) {
      for (const fn of messageListeners) fn(message);
    },
  };
}

const serverStarted = (reused: boolean) => ({
  version: 2,
  type: 'event',
  event: 'native.serverStarted',
  data: { port: 12306, reused },
});

const startRequests = (port: ReturnType<typeof makePort>) =>
  port.posted.filter((m) => m?.method === 'native.start');

let port: ReturnType<typeof makePort>;

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  port = makePort();
  (globalThis as any).chrome.runtime.connectNative = vi.fn().mockReturnValue(port);
  (globalThis as any).chrome.storage.local.get = vi.fn().mockResolvedValue({});
  (globalThis as any).chrome.storage.local.set = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('port reclaim', () => {
  it('keeps retrying the bind while another browser owns the port', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);

    const initial = startRequests(port).length;
    expect(initial).toBe(1); // the connect path asks once

    port.emit(serverStarted(true)); // another browser owns it
    await vi.advanceTimersByTimeAsync(0);

    // Giving up here is the bug: nothing else would ever retry.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(startRequests(port).length).toBe(initial + 1);

    await vi.advanceTimersByTimeAsync(21_000);
    expect(startRequests(port).length).toBe(initial + 2);
  });

  it('stops retrying once the bind succeeds', async () => {
    const { connectNativeHost } = await import('../entrypoints/background/native-host');
    connectNativeHost(12306);
    await vi.advanceTimersByTimeAsync(0);

    port.emit(serverStarted(true));
    await vi.advanceTimersByTimeAsync(21_000);
    const whileDegraded = startRequests(port).length;

    // The other browser exited and this host got the port.
    port.emit(serverStarted(false));
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(startRequests(port).length).toBe(whileDegraded);
  });
});
