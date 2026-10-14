#!/usr/bin/env node
import serverInstance from './server';
import nativeMessagingHostInstance from './native-messaging-host';
import { extensionRegistry } from './extension-registry';
import { setNativeHostResolver } from './native-host-resolver';

try {
  serverInstance.setNativeHost(nativeMessagingHostInstance); // Server needs setNativeHost method
  nativeMessagingHostInstance.setServer(serverInstance); // NativeHost needs setServer method
  extensionRegistry.adopt(nativeMessagingHostInstance.getEventChannel());
  extensionRegistry.setServer(serverInstance);
  // Tool calls go to the browser on the other end of a socket. The stdio host remains
  // the fallback until the stub owns bootstrap, and it is also what a standalone server
  // has when nothing has dialled in yet.
  setNativeHostResolver(() => extensionRegistry.soleHost() ?? nativeMessagingHostInstance);
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
