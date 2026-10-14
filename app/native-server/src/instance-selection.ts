import { NativeProtocolError } from '@ethanwilkins/chrome-mcp-shared-2026';
import type { ExtensionInstance } from './event-websocket-server.js';
import type { NativeMessagingHost } from './native-messaging-host.js';

export interface InstanceDirectory {
  instances(): ExtensionInstance[];
  hostFor(instanceId: string): NativeMessagingHost | null;
  soleHost(): NativeMessagingHost | null;
}

/**
 * Which browser a given MCP session drives.
 *
 * Keyed by the transport's session id, which request handlers already receive, so the
 * tool layer needs no reference back to the session record. Selection dies with the
 * session: a client that re-initializes starts unbound, which is accepted — with two
 * browsers still connected it hits the ambiguity error and is forced to re-select.
 */
const selections = new Map<string, string>();

function describe(instances: ExtensionInstance[]): string {
  return instances
    .map((instance) => `${instance.label} [${instance.instanceId.slice(0, 8)}]`)
    .join(', ');
}

export function clearSelection(sessionId: string): void {
  selections.delete(sessionId);
}

/** Resolves a label or an id prefix. Ambiguity is an error, never a guess. */
export function selectInstance(
  directory: InstanceDirectory,
  sessionId: string,
  selector: string,
): ExtensionInstance {
  const instances = directory.instances();
  const needle = selector.trim().toLowerCase();
  const matches = instances.filter(
    (instance) =>
      instance.instanceId.toLowerCase() === needle ||
      instance.instanceId.toLowerCase().startsWith(needle) ||
      instance.label.toLowerCase() === needle,
  );

  if (matches.length === 0) {
    throw new NativeProtocolError(
      'INVALID_REQUEST',
      `No connected browser matches "${selector}". Connected: ${describe(instances) || 'none'}`,
    );
  }
  if (matches.length > 1) {
    // Two launchers can pick the same label; that is legal, and resolved by id prefix.
    throw new NativeProtocolError(
      'INVALID_REQUEST',
      `"${selector}" matches more than one browser: ${describe(matches)}. ` +
        'Select by id prefix instead.',
    );
  }
  selections.set(sessionId, matches[0].instanceId);
  return matches[0];
}

/**
 * The host a session's tool call should drive.
 *
 * An explicitly bound session is never silently re-pointed: if its browser is gone the
 * call fails and says so. Quiet fallback to a survivor is the one failure that would
 * outlive all of this work — an agent believing it drives Canary while clicking in a
 * logged-in stable profile.
 */
export function resolveSessionHost(
  directory: InstanceDirectory,
  sessionId: string | undefined,
): NativeMessagingHost | null {
  const bound = sessionId ? selections.get(sessionId) : undefined;
  if (bound) {
    const host = directory.hostFor(bound);
    if (host) return host;
    throw new NativeProtocolError(
      'NATIVE_DISCONNECTED',
      `The selected browser [${bound.slice(0, 8)}] is no longer connected. ` +
        `Connected: ${describe(directory.instances()) || 'none'}. Select one again.`,
    );
  }

  const sole = directory.soleHost();
  if (sole) return sole;

  const instances = directory.instances();
  if (instances.length > 1) {
    throw new NativeProtocolError(
      'INVALID_REQUEST',
      `More than one browser is connected: ${describe(instances)}. ` +
        'Call chrome_select_instance to choose one.',
    );
  }
  return null;
}

export function listInstances(directory: InstanceDirectory, sessionId: string | undefined) {
  const bound = sessionId ? selections.get(sessionId) : undefined;
  return directory.instances().map((instance) => ({
    instanceId: instance.instanceId,
    label: instance.label,
    browser: instance.browser,
    connectedAt: instance.connectedAt,
    protocolVersion: instance.protocolVersion,
    selected: instance.instanceId === bound,
  }));
}
