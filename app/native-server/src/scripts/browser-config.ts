import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { HOST_NAME } from './constant';

export enum BrowserType {
  CHROME = 'chrome',
  CHROMIUM = 'chromium',
  CANARY = 'canary',
}

/**
 * Single source of truth for "all browsers". Callers used to spell the list out,
 * so every new browser meant hunting down each copy.
 */
export const ALL_BROWSER_TYPES: BrowserType[] = Object.values(BrowserType);

/** Human-readable names; the enum values are too terse for 'canary'. */
const DISPLAY_NAMES: Record<BrowserType, string> = {
  [BrowserType.CHROME]: 'Chrome',
  [BrowserType.CHROMIUM]: 'Chromium',
  [BrowserType.CANARY]: 'Chrome Canary',
};

/** Message fragment for CLI validation errors, derived so it cannot drift. */
export const BROWSER_CHOICES_HINT = `${ALL_BROWSER_TYPES.map((type) => `'${type}'`).join(', ')}, or 'all'`;

/** Unquoted variant for --help option descriptions. */
export const BROWSER_LIST_HINT = `${ALL_BROWSER_TYPES.join(', ')}, or all`;

export interface BrowserConfig {
  type: BrowserType;
  displayName: string;
  userManifestPath: string;
  systemManifestPath: string;
  registryKey?: string; // Windows only
  systemRegistryKey?: string; // Windows only
}

/**
 * Get the user-level manifest path for a specific browser
 */
function getUserManifestPathForBrowser(browser: BrowserType): string {
  const platform = os.platform();

  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(appData, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.CHROMIUM:
        return path.join(appData, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.CANARY:
        // Canary installs side-by-side with stable under the "Chrome SxS" name.
        return path.join(
          appData,
          'Google',
          'Chrome SxS',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(appData, 'Google', 'Chrome', 'NativeMessagingHosts', `${HOST_NAME}.json`);
    }
  } else if (platform === 'darwin') {
    const home = os.homedir();
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CANARY:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome Canary',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          home,
          'Library',
          'Application Support',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else {
    // Linux
    const home = os.homedir();
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          home,
          '.config',
          'google-chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(home, '.config', 'chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.CANARY:
        // Linux has no Canary channel; google-chrome-unstable is the dev-channel
        // equivalent and keeps its own profile directory.
        return path.join(
          home,
          '.config',
          'google-chrome-unstable',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          home,
          '.config',
          'google-chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  }
}

/**
 * Get the system-level manifest path for a specific browser
 */
function getSystemManifestPathForBrowser(browser: BrowserType): string {
  const platform = os.platform();

  if (platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          programFiles,
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(programFiles, 'Chromium', 'NativeMessagingHosts', `${HOST_NAME}.json`);
      case BrowserType.CANARY:
        return path.join(
          programFiles,
          'Google',
          'Chrome SxS',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          programFiles,
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else if (platform === 'darwin') {
    switch (browser) {
      case BrowserType.CHROME:
        return path.join(
          '/Library',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CHROMIUM:
        return path.join(
          '/Library',
          'Application Support',
          'Chromium',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      case BrowserType.CANARY:
        return path.join(
          '/Library',
          'Google',
          'Chrome Canary',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
      default:
        return path.join(
          '/Library',
          'Google',
          'Chrome',
          'NativeMessagingHosts',
          `${HOST_NAME}.json`,
        );
    }
  } else {
    // Linux
    switch (browser) {
      case BrowserType.CHROME:
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
      case BrowserType.CHROMIUM:
        return path.join('/etc', 'chromium', 'native-messaging-hosts', `${HOST_NAME}.json`);
      case BrowserType.CANARY:
        // The google-chrome-* Debian/RPM packages share /etc/opt/chrome, so this is
        // intentionally the same directory as stable. Both would write an identical
        // manifest, which makes the overlap harmless.
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
      default:
        return path.join('/etc', 'opt', 'chrome', 'native-messaging-hosts', `${HOST_NAME}.json`);
    }
  }
}

/**
 * Get Windows registry keys for a browser
 */
function getRegistryKeys(browser: BrowserType): { user: string; system: string } | undefined {
  if (os.platform() !== 'win32') return undefined;

  const browserPaths: Record<BrowserType, { user: string; system: string }> = {
    [BrowserType.CHROME]: {
      user: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    [BrowserType.CHROMIUM]: {
      user: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Chromium\\NativeMessagingHosts\\${HOST_NAME}`,
    },
    [BrowserType.CANARY]: {
      user: `HKCU\\Software\\Google\\Chrome SxS\\NativeMessagingHosts\\${HOST_NAME}`,
      system: `HKLM\\Software\\Google\\Chrome SxS\\NativeMessagingHosts\\${HOST_NAME}`,
    },
  };

  return browserPaths[browser];
}

/**
 * Get browser configuration
 */
export function getBrowserConfig(browser: BrowserType): BrowserConfig {
  const registryKeys = getRegistryKeys(browser);

  return {
    type: browser,
    displayName: DISPLAY_NAMES[browser],
    userManifestPath: getUserManifestPathForBrowser(browser),
    systemManifestPath: getSystemManifestPathForBrowser(browser),
    registryKey: registryKeys?.user,
    systemRegistryKey: registryKeys?.system,
  };
}

/**
 * Detect installed browsers on the system
 */
export function detectInstalledBrowsers(): BrowserType[] {
  const detectedBrowsers: BrowserType[] = [];
  const platform = os.platform();

  if (platform === 'win32') {
    // Canary installs per-user, so it is absent from HKLM; each browser gets a list
    // and counts as present when any one path resolves.
    const browsers: Array<{ type: BrowserType; registryPaths: string[] }> = [
      { type: BrowserType.CHROME, registryPaths: ['HKLM\\SOFTWARE\\Google\\Chrome'] },
      { type: BrowserType.CHROMIUM, registryPaths: ['HKLM\\SOFTWARE\\Chromium'] },
      {
        type: BrowserType.CANARY,
        registryPaths: ['HKCU\\SOFTWARE\\Google\\Chrome SxS', 'HKLM\\SOFTWARE\\Google\\Chrome SxS'],
      },
    ];

    for (const browser of browsers) {
      for (const registryPath of browser.registryPaths) {
        try {
          execSync(`reg query "${registryPath}" 2>nul`, { stdio: 'pipe' });
          detectedBrowsers.push(browser.type);
          break;
        } catch {
          // Try the next path for this browser
        }
      }
    }
  } else if (platform === 'darwin') {
    // Checked in order; Canary is often installed to ~/Applications when the user
    // lacks admin rights.
    const browsers: Array<{ type: BrowserType; appPaths: string[] }> = [
      { type: BrowserType.CHROME, appPaths: ['/Applications/Google Chrome.app'] },
      { type: BrowserType.CHROMIUM, appPaths: ['/Applications/Chromium.app'] },
      {
        type: BrowserType.CANARY,
        appPaths: [
          '/Applications/Google Chrome Canary.app',
          path.join(os.homedir(), 'Applications', 'Google Chrome Canary.app'),
        ],
      },
    ];

    for (const browser of browsers) {
      if (browser.appPaths.some((appPath) => fs.existsSync(appPath))) {
        detectedBrowsers.push(browser.type);
      }
    }
  } else {
    // Check Linux paths using which command
    const browsers: Array<{ type: BrowserType; commands: string[] }> = [
      { type: BrowserType.CHROME, commands: ['google-chrome', 'google-chrome-stable'] },
      { type: BrowserType.CHROMIUM, commands: ['chromium', 'chromium-browser'] },
      { type: BrowserType.CANARY, commands: ['google-chrome-unstable'] },
    ];

    for (const browser of browsers) {
      for (const cmd of browser.commands) {
        try {
          execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
          detectedBrowsers.push(browser.type);
          break; // Found one command, no need to check others
        } catch {
          // Command not found
        }
      }
    }
  }

  return detectedBrowsers;
}

/**
 * Get all supported browser configs
 */
export function getAllBrowserConfigs(): BrowserConfig[] {
  return Object.values(BrowserType).map((browser) => getBrowserConfig(browser));
}

/**
 * Parse browser type from string
 */
export function parseBrowserType(browserStr: string): BrowserType | undefined {
  const normalized = browserStr.toLowerCase();
  return Object.values(BrowserType).find((type) => type === normalized);
}
