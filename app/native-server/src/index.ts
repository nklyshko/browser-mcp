#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { extensionRegistry } from './extension-registry';
import { wireExtensionRouting } from './extension-routing';
import { startIdleShutdown } from './idle-shutdown';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  wireExtensionRouting(serverInstance, nativeMessagingHostInstance);
  startIdleShutdown(
    {
      connectedBrowsers: () => extensionRegistry.instances().length,
      activeSessions: () => serverInstance.activeSessionCount,
      nativePeerConnected: () => nativeMessagingHostInstance.isExtensionConnected(),
    },
    () => {
      void serverInstance.stop().finally(() => process.exit(0));
    },
  );
  nativeMessagingHostInstance.start();
} catch (error) {
  process.exit(1);
}

process.on('error', (error) => {
  process.exit(1);
});

// Handle process signals and uncaught exceptions
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('exit', (code) => {});

process.on('uncaughtException', (error) => {
  console.error('[NativeHost] Uncaught exception:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // Keep the host alive, but retain the failure in the native-host stderr log.
  console.error('[NativeHost] Unhandled rejection:', reason);
});
