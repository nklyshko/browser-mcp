import { AsyncLocalStorage } from 'node:async_hooks';
import { NativeProtocolError } from '@ethanwilkins/chrome-mcp-shared-2026';
import nativeMessagingHostInstance from './native-messaging-host.js';
import type { NativeMessagingHost } from './native-messaging-host.js';
import { resolveSessionHost, type InstanceDirectory } from './instance-selection.js';

let directory: InstanceDirectory = {
  instances: () => [],
  hostFor: () => null,
  soleHost: () => nativeMessagingHostInstance,
};

export function setInstanceDirectory(next: InstanceDirectory): void {
  directory = next;
}

export function getInstanceDirectory(): InstanceDirectory {
  return directory;
}

/**
 * Runs a tool call against the host this session is bound to.
 *
 * The session id comes from the request handler, so nothing has to be threaded through
 * the ~50 tool call sites; they keep asking the resolver, which now answers per session.
 *
 * AsyncLocalStorage rather than a swapped module variable: tool calls are async and two
 * sessions overlap freely, so a variable restored in a `finally` would let one session's
 * call resolve to the other's browser after an await. The plan said this machinery could
 * be skipped — true only while the browser was bound at server-creation time, which
 * tool-based selection replaced.
 */
const sessionHosts = new AsyncLocalStorage<NativeMessagingHost | null>();

export function withSessionHost<T>(sessionId: string | undefined, run: () => T): T {
  return sessionHosts.run(resolveSessionHost(directory, sessionId), run);
}

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
  // A session's bound host wins; otherwise fall back to whatever was wired globally.
  return sessionHosts.getStore() ?? resolver();
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
