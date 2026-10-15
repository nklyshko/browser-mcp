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
let updated: Array<[number, string]>;
let openTabs: unknown[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  listeners = [];
  stored = {};
  removed = [];
  updated = [];
  openTabs = [{ id: 7 }, { id: 8 }];
  (globalThis as any).chrome.tabs.onUpdated = {
    addListener: (fn: UpdateListener) => listeners.push(fn),
    removeListener: vi.fn(),
  };
  (globalThis as any).chrome.tabs.remove = vi.fn().mockImplementation(async (id: number) => {
    removed.push(id);
  });
  (globalThis as any).chrome.tabs.update = vi
    .fn()
    .mockImplementation(async (id: number, p: any) => {
      updated.push([id, p.url]);
    });
  // Two tabs by default, so the claim tab is safe to close.
  (globalThis as any).chrome.tabs.query = vi.fn().mockImplementation(async () => openTabs);
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

  it('navigates away instead of closing the only tab, which would quit the browser', async () => {
    // A launcher normally passes the claim URL as the only thing to open, so this is
    // the common case: closing it would kill the browser the agent just started.
    openTabs = [{ id: 7 }];
    await claim('http://127.0.0.1:12306/claim?label=work');

    expect(stored.nativeInstanceIdentity.label).toBe('work');
    expect(removed).toEqual([]);
    expect(updated).toEqual([[7, 'about:blank']]);
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
