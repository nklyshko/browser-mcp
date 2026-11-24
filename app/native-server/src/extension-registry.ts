import { LocalEventWebSocketServer, type ExtensionInstance } from './event-websocket-server.js';
import { NativeMessagingHost } from './native-messaging-host.js';
import { WebSocketNativeTransport } from './native-transport.js';
import { resolveApiKey } from './api-key.js';
import { structuredLog } from './observability.js';
import type { Server } from './server';

interface Connected {
  instance: ExtensionInstance;
  host: NativeMessagingHost;
  transport: WebSocketNativeTransport;
}

/**
 * The registry *is* the instance registry: one entry per live extension socket, with
 * liveness being TCP state rather than a heartbeat. Nothing here binds a port, so two
 * browsers never compete — they are two rows in this map.
 */
export class ExtensionRegistry {
  private readonly connections = new Map<string, Connected>();
  private eventChannel: LocalEventWebSocketServer | null = null;
  private associatedServer: Server | null = null;

  /**
   * Takes over an existing channel's handlers rather than creating its own, so the one
   * channel whose `{port, token}` the extension was given is the one being watched.
   */
  adopt(channel: LocalEventWebSocketServer): void {
    this.eventChannel = channel;
    channel.setHandlers({
      apiKey: () => resolveApiKey(),
      onMessage: (message, instance) => this.route(message, instance),
      onHello: (instance) => this.attach(instance),
      onGone: (instance, endedBy) => this.detach(instance.instanceId, endedBy),
    });
  }

  setServer(server: Server): void {
    this.associatedServer = server;
    for (const { host } of this.connections.values()) host.setServer(server);
  }

  instances(): ExtensionInstance[] {
    return [...this.connections.values()].map((entry) => entry.instance);
  }

  hostFor(instanceId: string): NativeMessagingHost | null {
    return this.connections.get(instanceId)?.host ?? null;
  }

  /** Resolves only while unambiguous, per the latch rule: one instance or nothing. */
  soleHost(): NativeMessagingHost | null {
    if (this.connections.size !== 1) return null;
    return [...this.connections.values()][0].host;
  }

  /** Called when a socket completes its hello. */
  attach(instance: ExtensionInstance): void {
    const channel = this.eventChannel;
    if (!channel) return;
    const transport = new WebSocketNativeTransport((payload) =>
      channel.publishRaw(instance.instanceId, payload),
    );
    const host = new NativeMessagingHost({
      transport,
      eventChannel: channel,
      exitProcessOnClose: false,
    });
    if (this.associatedServer) host.setServer(this.associatedServer);
    host.listen();
    this.connections.set(instance.instanceId, { instance, host, transport });
    structuredLog('extension.connected', {
      instanceId: instance.instanceId,
      label: instance.label,
      browser: instance.browser,
      protocolVersion: instance.protocolVersion,
      extensionVersion: instance.extensionVersion,
      total: this.connections.size,
    });
  }

  private route(message: unknown, instance: ExtensionInstance): void {
    const entry = this.connections.get(instance.instanceId);
    if (!entry) return;
    entry.transport.accept(message);
  }

  /** Called when a socket closes; rejects that connection's in-flight work only. */
  detach(instanceId: string, endedBy?: string): void {
    const entry = this.connections.get(instanceId);
    if (!entry) return;
    this.connections.delete(instanceId);
    entry.transport.disconnected();
    structuredLog('extension.disconnected', {
      instanceId,
      total: this.connections.size,
      endedBy: endedBy ?? 'socket_closed',
    });
  }
}

export const extensionRegistry = new ExtensionRegistry();
