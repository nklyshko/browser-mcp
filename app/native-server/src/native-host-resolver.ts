import { NativeProtocolError } from '@ethanwilkins/chrome-mcp-shared-2026';
import nativeMessagingHostInstance from './native-messaging-host.js';
import type { NativeMessagingHost } from './native-messaging-host.js';

/**
 * Defaults to the process's own stdio host, which is the right answer whenever nobody
 * has wired anything else: a standalone server, the CLI, or a test.
 */
let resolver: () => NativeMessagingHost | null = () => nativeMessagingHostInstance;

/**
 * Where the tool layer looks for the host to drive.
 *
 * The tool layer imported a module singleton, which is correct only while a process has
 * exactly one extension. One server with several browsers needs the choice made per
 * call, and P8 makes that choice session-aware; this is the seam it will hook.
 */
export function setNativeHostResolver(next: () => NativeMessagingHost | null): void {
  resolver = next;
}

export function activeNativeHost(): NativeMessagingHost | null {
  return resolver();
}

/**
 * For call sites that cannot proceed without a browser. Fails with the same code the
 * host itself uses for a dead channel, so existing error handling is unchanged.
 */
export function requireNativeHost(): NativeMessagingHost {
  const host = activeNativeHost();
  if (!host) {
    throw new NativeProtocolError(
      'NATIVE_DISCONNECTED',
      'No browser is connected to the native server.',
    );
  }
  return host;
}
