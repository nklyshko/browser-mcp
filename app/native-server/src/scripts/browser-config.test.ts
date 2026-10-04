import { describe, expect, test, jest, afterEach } from '@jest/globals';

// browser-config branches on os.platform(), which is a native binding rather than a
// read of process.platform, so the module itself has to be mocked. State lives on
// globalThis to stay clear of the temporal dead zone created by jest.mock hoisting.
jest.mock('os', () => {
  const actual = jest.requireActual<typeof import('os')>('os');
  return {
    ...actual,
    platform: () => (globalThis as Record<string, unknown>).__fakePlatform ?? actual.platform(),
  };
});

import {
  ALL_BROWSER_TYPES,
  BROWSER_CHOICES_HINT,
  BrowserType,
  getAllBrowserConfigs,
  getBrowserConfig,
  parseBrowserType,
} from './browser-config';

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  (globalThis as Record<string, unknown>).__fakePlatform = platform;
  try {
    return run();
  } finally {
    delete (globalThis as Record<string, unknown>).__fakePlatform;
  }
}

// The manifest path is the whole feature: write it in the wrong directory and the
// browser silently never sees the native host.
function userPathOn(platform: NodeJS.Platform, browser: BrowserType): string {
  return withPlatform(platform, () => getBrowserConfig(browser).userManifestPath);
}

describe('browser-config', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    delete (globalThis as Record<string, unknown>).__fakePlatform;
  });

  test('canary is a supported browser everywhere the list is derived', () => {
    expect(ALL_BROWSER_TYPES).toEqual([
      BrowserType.CHROME,
      BrowserType.CHROMIUM,
      BrowserType.CANARY,
    ]);
    expect(parseBrowserType('canary')).toBe(BrowserType.CANARY);
    expect(parseBrowserType('CANARY')).toBe(BrowserType.CANARY);
    expect(parseBrowserType('nope')).toBeUndefined();
    expect(getAllBrowserConfigs().map((config) => config.type)).toContain(BrowserType.CANARY);
    expect(BROWSER_CHOICES_HINT).toContain("'canary'");
  });

  test('canary resolves to its own profile directory, never stable Chrome', () => {
    expect(userPathOn('darwin', BrowserType.CANARY)).toContain(
      'Google/Chrome Canary/NativeMessagingHosts',
    );

    // Canary ships side-by-side with stable on Windows under the SxS name.
    expect(userPathOn('win32', BrowserType.CANARY)).toContain('Chrome SxS');

    // Linux has no Canary channel; the dev channel stands in for it.
    expect(userPathOn('linux', BrowserType.CANARY)).toContain('google-chrome-unstable');
  });

  test('every browser gets a distinct user manifest path per platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as NodeJS.Platform[]) {
      const paths = ALL_BROWSER_TYPES.map((browser) => userPathOn(platform, browser));
      // A collision here would mean one browser overwrites another's manifest.
      expect(new Set(paths).size).toBe(ALL_BROWSER_TYPES.length);
    }
  });

  test('canary carries its own Windows registry keys', () => {
    withPlatform('win32', () => {
      const canary = getBrowserConfig(BrowserType.CANARY);
      const chrome = getBrowserConfig(BrowserType.CHROME);
      expect(canary.registryKey).toContain('Chrome SxS');
      expect(canary.registryKey).not.toBe(chrome.registryKey);
      expect(canary.systemRegistryKey).not.toBe(chrome.systemRegistryKey);
    });
  });

  test('display names stay readable', () => {
    expect(getBrowserConfig(BrowserType.CANARY).displayName).toBe('Chrome Canary');
    expect(getBrowserConfig(BrowserType.CHROME).displayName).toBe('Chrome');
    expect(getBrowserConfig(BrowserType.CHROMIUM).displayName).toBe('Chromium');
  });
});
