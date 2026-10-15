#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { extensionRegistry } from './extension-registry';
import { setInstanceDirectory, setNativeHostResolver } from './native-host-resolver';
import { startIdleShutdown } from './idle-shutdown';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  extensionRegistry.adopt(nativeMessagingHostInstance.getEventChannel());
  extensionRegistry.setServer(serverInstance);
  // Tool calls only ever go to a browser on the other end of a socket. There is
  // deliberately no fallback to this process's own stdio host: now that the stub owns
  // bootstrap, that host has a null transport and is never connected, so falling back to
  // it turned "two browsers, pick one" and "no browser at all" into the same misleading
  // NATIVE_DISCONNECTED. Returning null lets each case report itself.
  setNativeHostResolver(() => extensionRegistry.soleHost());
  // Lets a session bind one browser and keeps ambiguity an error rather than a guess.
  setInstanceDirectory({
    instances: () => extensionRegistry.instances(),
    hostFor: (instanceId) => extensionRegistry.hostFor(instanceId),
    soleHost: () => extensionRegistry.soleHost(),
  });
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
