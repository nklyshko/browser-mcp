import { afterEach, describe, expect, test } from '@jest/globals';
import nativeMessagingHostInstance from './native-messaging-host.js';
import { extensionRegistry } from './extension-registry.js';
import { wireExtensionRouting } from './extension-routing.js';
import {
  activeNativeHost,
  getInstanceDirectory,
  setInstanceDirectory,
  setNativeHostResolver,
} from './native-host-resolver.js';
import server from './server.js';

function restoreUnwiredDefaults(): void {
  setNativeHostResolver(() => nativeMessagingHostInstance);
  setInstanceDirectory({
    instances: () => [],
    hostFor: () => null,
    soleHost: () => nativeMessagingHostInstance,
  });
}

describe('wireExtensionRouting (shared by index.js and cli.js start)', () => {
  afterEach(restoreUnwiredDefaults);

  test('unwired, tool calls resolve to the stdio host, which never connects in standalone', () => {
    expect(activeNativeHost()).toBe(nativeMessagingHostInstance);
    expect(getInstanceDirectory().soleHost()).toBe(nativeMessagingHostInstance);
  });

  test('wired with no browser connected, tool calls resolve to no host instead of the dead stdio one', () => {
    wireExtensionRouting(server, nativeMessagingHostInstance);

    expect(activeNativeHost()).toBeNull();
    expect(getInstanceDirectory().soleHost()).toBeNull();
    expect(getInstanceDirectory().instances()).toEqual(extensionRegistry.instances());
  });

  test('wired, a connected browser is the host tool calls resolve to', () => {
    wireExtensionRouting(server, nativeMessagingHostInstance);
    extensionRegistry.attach({
      instanceId: 'inst-canary-1',
      label: 'work',
      browser: 'Chrome/158',
      protocolVersion: 2,
      extensionVersion: '2.8.3',
      connectedAt: new Date().toISOString(),
    });

    try {
      expect(
        getInstanceDirectory()
          .instances()
          .map((i) => i.label),
      ).toEqual(['work']);
      expect(getInstanceDirectory().hostFor('inst-canary-1')).not.toBeNull();
      expect(activeNativeHost()).toBe(getInstanceDirectory().hostFor('inst-canary-1'));
    } finally {
      extensionRegistry.detach('inst-canary-1');
    }
  });
});
