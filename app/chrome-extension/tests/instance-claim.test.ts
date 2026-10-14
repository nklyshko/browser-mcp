/**
 * Instance claim tests
 * @description An AI agent launching Chrome knows which profile it started, but cannot
 * read the extension's storage and will never open the popup. The label is therefore
 * pushed in at launch through the start URL. The window matters: without it, any page
 * could relabel the instance and quietly point a selection at the wrong browser.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type UpdateListener = (tabId: number, changeInfo: { url?: string }) => void;

let listeners: UpdateListener[];
let stored: Record<string, any>;
let removed: number[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  listeners = [];
  stored = {};
  removed = [];
  (globalThis as any).chrome.tabs.onUpdated = {
    addListener: (fn: UpdateListener) => listeners.push(fn),
    removeListener: vi.fn(),
  };
  (globalThis as any).chrome.tabs.remove = vi.fn().mockImplementation(async (id: number) => {
    removed.push(id);
  });
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
});

async function claim(url: string) {
  const { initInstanceClaimListener } = await import('../entrypoints/background/native-host');
  initInstanceClaimListener();
  for (const fn of listeners) fn(7, { url });
  await vi.advanceTimersByTimeAsync(0);
}

describe('instance claim', () => {
  it('takes the label from the start URL and closes the tab', async () => {
    await claim('http://127.0.0.1:12306/claim?label=work');

    expect(stored.nativeInstanceIdentity.label).toBe('work');
    expect(stored.nativeInstanceIdentity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(removed).toEqual([7]);
  });

  it('overwrites an existing label, because profile dirs get reused', async () => {
    stored.nativeInstanceIdentity = { instanceId: 'kept-id', label: 'previous task' };
    await claim('http://127.0.0.1:12306/claim?label=next%20task');

    expect(stored.nativeInstanceIdentity).toEqual({
      instanceId: 'kept-id',
      label: 'next task',
    });
  });

  it('ignores a claim once the window has passed', async () => {
    const { initInstanceClaimListener } = await import('../entrypoints/background/native-host');
    initInstanceClaimListener();
    // A page that loads later must not be able to relabel this browser.
    vi.setSystemTime(Date.now() + 30_000);
    for (const fn of listeners) fn(7, { url: 'http://127.0.0.1:12306/claim?label=evil' });
    await vi.advanceTimersByTimeAsync(0);

    expect(stored.nativeInstanceIdentity).toBeUndefined();
    expect(removed).toEqual([]);
  });

  it('ignores a claim-looking URL on another host', async () => {
    await claim('https://evil.example/claim?label=evil');
    expect(stored.nativeInstanceIdentity).toBeUndefined();
  });

  it('ignores a claim with no label', async () => {
    await claim('http://127.0.0.1:12306/claim');
    expect(stored.nativeInstanceIdentity).toBeUndefined();
  });
});
