import { structuredLog } from './observability.js';

export interface IdleShutdownSources {
  /** Browsers currently dialled in over the WS channel. */
  connectedBrowsers(): number;
  /** MCP sessions a client is holding open. */
  activeSessions(): number;
  /** A native peer on stdio, which means a browser is mid-bootstrap. */
  nativePeerConnected(): boolean;
}

export const IDLE_CHECK_INTERVAL_MS = 60_000;
export const IDLE_SHUTDOWN_AFTER_MS = 5 * 60_000;

/**
 * The server now owns its lifetime instead of inheriting it from the browser that
 * spawned it, so something has to stop it leaking across reboots.
 *
 * It stays up while anything is using it: a browser on the channel, an MCP session, or
 * a native peer still bootstrapping. Counting only browsers would exit the server
 * underneath a live client the moment the last browser closed, turning a working
 * session into a dead endpoint — and MCP clients cache failures badly. Being generous
 * costs one idle process; being strict costs a confusing failure.
 */
export function startIdleShutdown(
  sources: IdleShutdownSources,
  onIdle: () => void,
  intervalMs = IDLE_CHECK_INTERVAL_MS,
  afterMs = IDLE_SHUTDOWN_AFTER_MS,
): () => void {
  let idleSince: number | null = null;

  // Polled rather than hooked into every mutation site: the transports map is written
  // in a dozen places and a missed hook would be an invisible leak.
  const timer = setInterval(() => {
    const browsers = sources.connectedBrowsers();
    const sessions = sources.activeSessions();
    const native = sources.nativePeerConnected();
    if (browsers > 0 || sessions > 0 || native) {
      if (idleSince !== null) structuredLog('server.idle_cancelled', { browsers, sessions });
      idleSince = null;
      return;
    }
    if (idleSince === null) {
      idleSince = Date.now();
      structuredLog('server.idle_started', { shutdownAfterMs: afterMs });
      return;
    }
    if (Date.now() - idleSince < afterMs) return;
    structuredLog('server.idle_shutdown', { idleForMs: Date.now() - idleSince });
    onIdle();
  }, intervalMs);

  timer.unref();
  return () => clearInterval(timer);
}
