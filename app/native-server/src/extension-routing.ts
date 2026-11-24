import type { Server } from './server';
import type { NativeMessagingHost } from './native-messaging-host';
import { extensionRegistry } from './extension-registry';
import { setInstanceDirectory, setNativeHostResolver } from './native-host-resolver';

export function wireExtensionRouting(server: Server, nativeHost: NativeMessagingHost): void {
  extensionRegistry.adopt(nativeHost.getEventChannel());
  extensionRegistry.setServer(server);
  const connectedBrowserOrNull = () => extensionRegistry.soleHost();
  setNativeHostResolver(connectedBrowserOrNull);
  setInstanceDirectory({
    instances: () => extensionRegistry.instances(),
    hostFor: (instanceId) => extensionRegistry.hostFor(instanceId),
    soleHost: connectedBrowserOrNull,
  });
}
