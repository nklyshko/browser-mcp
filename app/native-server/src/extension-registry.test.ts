import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { LocalEventWebSocketServer } from './event-websocket-server.js';
import { ExtensionRegistry } from './extension-registry.js';

/**
 * Drives the registry through the channel's own handlers, which is the path a real
 * socket takes: hello -> attach, close -> detach.
 */
describe('ExtensionRegistry', () => {
  let channel: LocalEventWebSocketServer;
  let registry: ExtensionRegistry;

  const instance = (instanceId: string, label: string) => ({
    instanceId,
    label,
    browser: 'Chrome/143',
    protocolVersion: 2,
    extensionVersion: '1.0.0',
    connectedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    channel = new LocalEventWebSocketServer();
    registry = new ExtensionRegistry();
    registry.adopt(channel);
  });

  afterEach(async () => {
    for (const { instanceId } of registry.instances()) registry.detach(instanceId);
    await channel.stop();
  });

  test('two browsers are two instances with their own hosts', () => {
    registry.attach(instance('inst-stable-1', 'Chrome 143 (aaaa)'));
    registry.attach(instance('inst-canary-2', 'Chrome 144 (bbbb)'));

    expect(registry.instances().map((i) => i.label)).toEqual([
      'Chrome 143 (aaaa)',
      'Chrome 144 (bbbb)',
    ]);
    const a = registry.hostFor('inst-stable-1');
    const b = registry.hostFor('inst-canary-2');
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  test('soleHost resolves only while unambiguous', () => {
    expect(registry.soleHost()).toBeNull();

    registry.attach(instance('inst-stable-1', 'A'));
    expect(registry.soleHost()).toBe(registry.hostFor('inst-stable-1'));

    // Two browsers: ambiguous, so nothing resolves rather than a guess.
    registry.attach(instance('inst-canary-2', 'B'));
    expect(registry.soleHost()).toBeNull();

    registry.detach('inst-canary-2');
    expect(registry.soleHost()).toBe(registry.hostFor('inst-stable-1'));
  });

  test('detaching rejects that host in-flight work and leaves the other alone', async () => {
    registry.attach(instance('inst-stable-1', 'A'));
    registry.attach(instance('inst-canary-2', 'B'));
    const a = registry.hostFor('inst-stable-1')!;
    const b = registry.hostFor('inst-canary-2')!;

    // Both hosts believe they are connected once their hello is negotiated.
    for (const host of [a, b]) {
      (host as any).connected = true;
    }
    const pending = a.sendRequestToExtensionAndWait({}, 'call_tool', 5_000);
    registry.detach('inst-stable-1');

    await expect(pending).rejects.toMatchObject({ code: 'NATIVE_DISCONNECTED' });
    expect(registry.instances().map((i) => i.instanceId)).toEqual(['inst-canary-2']);
    expect(b.getStatus().pendingRequests).toBe(0);
    a.getArtifactStore().dispose();
    b.getArtifactStore().dispose();
  });

  test('a reconnecting instance replaces its own entry rather than doubling up', () => {
    registry.attach(instance('inst-stable-1', 'A'));
    const first = registry.hostFor('inst-stable-1');

    // The channel detaches the stale socket before attaching the new one.
    registry.detach('inst-stable-1');
    registry.attach(instance('inst-stable-1', 'A again'));

    expect(registry.instances()).toHaveLength(1);
    expect(registry.instances()[0].label).toBe('A again');
    expect(registry.hostFor('inst-stable-1')).not.toBe(first);
  });
});
