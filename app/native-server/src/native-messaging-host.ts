import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { Server } from './server';
import {
  NativeProtocolError,
  NATIVE_PROTOCOL_VERSION,
  createNativeCapabilities,
  createNativeErrorResponse,
  createNativeHello,
  createNativeResponse,
  negotiateNativeProtocolVersion,
  parseNativeProtocolMessage,
  type NativeProtocolMessage,
  type NativeRequest,
  type NativeResponse,
  type NativeConnectionState,
  type NativeArtifact,
} from '@ethanwilkins/chrome-mcp-shared-2026';
import { NATIVE_SERVER_PORT, TIMEOUTS } from './constant';
import fileHandler from './file-handler';
import { ArtifactStore } from './artifact-store.js';
import { resolveApiKey } from './api-key.js';
import { LocalEventWebSocketServer, type EventChannelInfo } from './event-websocket-server.js';
import { RequestStageTimings, structuredLog } from './observability.js';
import {
  NullNativeTransport,
  StdioNativeTransport,
  type NativeTransport,
} from './native-transport.js';

export interface NativeMessagingHostOptions {
  transport?: NativeTransport;
  eventChannel?: LocalEventWebSocketServer;
  exitProcessOnClose?: boolean;
}

/**
 * A server started by hand or by a stdio proxy has no native peer, so it must not touch
 * stdin/stdout. That is what CHROME_MCP_STANDALONE has always meant; it is now a choice
 * of transport rather than a pair of early returns.
 */
function defaultNativeTransport(): NativeTransport {
  return process.env.CHROME_MCP_STANDALONE === '1'
    ? new NullNativeTransport()
    : new StdioNativeTransport();
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (reason?: any) => void;
  onProgress?: (payload: any) => void | Promise<void>;
  timeoutId: NodeJS.Timeout;
  traceId: string;
  method: string;
  sideEffect: boolean;
  settled: boolean;
}

export interface NativeHostStatus {
  connected: boolean;
  state: NativeConnectionState;
  pendingRequests: number;
  lastActivityAt: string | null;
  lastSuccessAt: string | null;
  reconnectCount: number;
  timeoutCount: number;
  cancelCount: number;
  lastError: string | null;
  lastTimings: RequestStageTimings | null;
}

function resolveServerPort(requested?: unknown): number {
  const configured = process.env.CHROME_MCP_PORT || process.env.MCP_HTTP_PORT;
  if (configured) {
    const port = Number.parseInt(configured, 10);
    if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  }
  const port = typeof requested === 'number' ? requested : Number(requested);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : NATIVE_SERVER_PORT;
}

function isAddressInUse(error: any): boolean {
  return error?.code === 'EADDRINUSE' || String(error?.message || '').includes('EADDRINUSE');
}

export class NativeMessagingHost {
  private readonly transportOverride: NativeTransport | undefined;
  private resolvedTransport: NativeTransport | null = null;
  private readonly eventChannel: LocalEventWebSocketServer;
  private readonly ownsEventChannel: boolean;
  private readonly exitProcessOnCloseOverride: boolean | undefined;
  private associatedServer: Server | null = null;
  private pendingRequests: Map<string, PendingRequest> = new Map();
  private connected = false;
  private connectionState: NativeConnectionState = 'stopped';
  private lastActivityAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private reconnectCount = 0;
  private timeoutCount = 0;
  private cancelCount = 0;
  private lastError: string | null = null;
  private lastTimings: RequestStageTimings | null = null;
  private respondedProtocolRequests = new Set<string>();
  private activeProtocolRequests = new Set<string>();
  private activeProtocolControllers = new Map<string, AbortController>();
  private failedArtifactUploads = new Set<string>();
  private readonly maxDeduplicatedRequests = 4096;
  private readonly artifactStore = new ArtifactStore();
  private eventChannelInfo: EventChannelInfo | null = null;

  constructor(options: NativeMessagingHostOptions = {}) {
    this.transportOverride = options.transport;
    this.eventChannel = options.eventChannel ?? new LocalEventWebSocketServer();
    this.ownsEventChannel = options.eventChannel === undefined;
    this.exitProcessOnCloseOverride = options.exitProcessOnClose;
  }

  /**
   * Resolved on first use, not in the constructor: this class is a module singleton, so
   * deciding at construction time would read the environment before an entry point such
   * as `cli.ts start` has had any chance to set it.
   */
  private get transport(): NativeTransport {
    if (!this.resolvedTransport) {
      this.resolvedTransport = this.transportOverride ?? defaultNativeTransport();
    }
    return this.resolvedTransport;
  }

  /** Only the process-owning stdio host exits when its peer goes away. */
  private get exitProcessOnClose(): boolean {
    return this.exitProcessOnCloseOverride ?? this.transport.kind === 'stdio';
  }

  public getStatus(): NativeHostStatus {
    return {
      connected: this.connected,
      state: this.connectionState,
      pendingRequests: this.pendingRequests.size,
      lastActivityAt: this.lastActivityAt?.toISOString() ?? null,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      reconnectCount: this.reconnectCount,
      timeoutCount: this.timeoutCount,
      cancelCount: this.cancelCount,
      lastError: this.lastError,
      lastTimings: this.lastTimings,
    };
  }

  public recordRequestTimings(traceId: string, timings: RequestStageTimings): void {
    this.lastTimings = timings;
    structuredLog('request.completed', { traceId, timings });
  }

  public isExtensionConnected(): boolean {
    return this.connected;
  }

  public setServer(serverInstance: Server): void {
    this.associatedServer = serverInstance;
  }

  /** The channel this host hands to its extension; the registry adopts it. */
  public getEventChannel(): LocalEventWebSocketServer {
    return this.eventChannel;
  }

  public getArtifactStore(): ArtifactStore {
    return this.artifactStore;
  }

  /**
   * Begin consuming the transport without touching the HTTP server's lifecycle. A
   * WS-backed connection arrives at an already-running server; only the stdio host that
   * owns the process starts one.
   */
  public listen(): void {
    this.connected = false;
    this.connectionState = 'starting';
    this.lastActivityAt = new Date();
    this.setupMessageHandling();
  }

  // Start the HTTP server as soon as the native host is connected. The
  // extension still sends START, but startup must not depend on that single
  // message arriving after a reconnect.
  public start(): void {
    try {
      // The process can be launched by Chrome before the extension has sent
      // its first message. Mark the session ready only after a valid message
      // arrives so callers do not wait for a request that cannot be delivered.
      this.listen();
      void this.startServer(resolveServerPort(NATIVE_SERVER_PORT));
    } catch (error: any) {
      process.exit(1);
    }
  }

  private setupMessageHandling(): void {
    this.transport.listen({
      onMessage: (message) => void this.handleMessage(message),
      onClose: () => this.cleanup(),
      onError: (message) => this.sendError(message),
    });
  }

  private async handleMessage(message: any): Promise<void> {
    this.lastActivityAt = new Date();
    if (!message || typeof message !== 'object') {
      this.sendError('Invalid message format');
      return;
    }
    try {
      await this.handleProtocolMessage(parseNativeProtocolMessage(message));
    } catch (error) {
      const protocolError =
        error instanceof NativeProtocolError
          ? error
          : new NativeProtocolError(
              'INVALID_REQUEST',
              error instanceof Error ? error.message : String(error),
            );
      this.lastError = protocolError.message;
      structuredLog('protocol.error', {
        code: protocolError.code,
        message: protocolError.message,
        requestId: typeof message.requestId === 'string' ? message.requestId : undefined,
        traceId: typeof message.traceId === 'string' ? message.traceId : undefined,
      });
      if (typeof message.requestId === 'string' && typeof message.traceId === 'string') {
        this.sendMessage({
          version: NATIVE_PROTOCOL_VERSION,
          type: 'response',
          requestId: message.requestId,
          traceId: message.traceId,
          ok: false,
          error: { code: protocolError.code, message: protocolError.message },
        });
      } else {
        this.sendError(protocolError.message, protocolError.code);
      }
    }
  }

  private async handleProtocolMessage(message: NativeProtocolMessage): Promise<void> {
    if (!this.connected && this.connectionState !== 'starting') this.reconnectCount += 1;
    this.connected = true;
    if (this.connectionState === 'starting' || this.connectionState === 'stopped') {
      this.connectionState = 'connected';
    }

    switch (message.type) {
      case 'hello': {
        const selectedVersion = negotiateNativeProtocolVersion(message.supportedVersions);
        if (selectedVersion === null) {
          throw new NativeProtocolError(
            'UNSUPPORTED_VERSION',
            'No mutually supported protocol version',
          );
        }
        this.sendMessage({
          ...createNativeHello(
            'native-service',
            { name: 'chrome-mcp-native', version: '2' },
            message.traceId,
          ),
          selectedVersion,
        });
        this.sendMessage(createNativeCapabilities(message.traceId));
        this.connectionState = 'ready';
        // Only the bootstrap host hands out `{port, token}`. A host that already *is* a
        // socket on that channel would otherwise bind a second listener and invite its
        // extension to reconnect to it.
        if (this.ownsEventChannel) void this.openEventChannel(message.traceId);
        return;
      }
      case 'ping':
        this.sendMessage({
          version: NATIVE_PROTOCOL_VERSION,
          type: 'pong',
          nonce: message.nonce,
          traceId: message.traceId,
        });
        return;
      case 'pong':
      case 'capabilities':
      case 'event':
        if (message.type === 'event' && message.requestId) {
          this.pendingRequests.get(message.requestId)?.onProgress?.(message.data);
        }
        return;
      case 'artifact':
        try {
          this.handleArtifact(message);
        } catch (error) {
          this.failedArtifactUploads.add(message.artifactId);
          throw error;
        }
        return;
      case 'cancel':
        {
          this.cancelCount += 1;
          this.activeProtocolControllers.get(message.requestId)?.abort();
          const pending = this.pendingRequests.get(message.requestId);
          if (pending && !pending.settled) {
            clearTimeout(pending.timeoutId);
            pending.settled = true;
            this.pendingRequests.delete(message.requestId);
            pending.reject(
              new NativeProtocolError('CANCELED', message.reason || 'Request canceled'),
            );
          }
        }
        return;
      case 'response':
        this.resolveProtocolResponse(message);
        return;
      case 'request':
        await this.handleProtocolRequest(message);
        return;
    }
  }

  private async openEventChannel(traceId?: string): Promise<void> {
    try {
      this.eventChannelInfo = await this.eventChannel.start();
      this.sendMessage({
        version: NATIVE_PROTOCOL_VERSION,
        type: 'event',
        traceId,
        event: 'native.eventChannelReady',
        data: this.eventChannelInfo,
      });
    } catch (error) {
      this.sendError(
        `Failed to start event channel: ${error instanceof Error ? error.message : String(error)}`,
        'BROWSER_ERROR',
      );
    }
  }

  private handleArtifact(message: NativeArtifact): void {
    if (message.data === undefined || message.seq === undefined || message.eof === undefined)
      return;
    this.artifactStore.receiveChunk({
      artifactId: message.artifactId,
      contentType: message.contentType,
      size: message.size,
      sha256: message.sha256,
      seq: message.seq,
      eof: message.eof,
      data: message.data,
    });
  }

  private resolveProtocolResponse(message: NativeResponse): void {
    const pending = this.pendingRequests.get(message.requestId);
    if (!pending || pending.settled || pending.traceId !== message.traceId) return;
    clearTimeout(pending.timeoutId);
    pending.settled = true;
    this.pendingRequests.delete(message.requestId);
    if (message.ok) {
      const result = message.result as Record<string, unknown> | undefined;
      const artifactId = typeof result?.artifactId === 'string' ? result.artifactId : undefined;
      if (artifactId && this.failedArtifactUploads.has(artifactId)) {
        this.failedArtifactUploads.delete(artifactId);
        pending.reject(
          new NativeProtocolError('BROWSER_ERROR', 'Artifact upload did not complete'),
        );
        return;
      }
      this.associatedServer?.observeNativeResponse(pending.method, message.result);
      pending.resolve(
        artifactId && this.artifactStore.get(artifactId)
          ? {
              ...result,
              url: `http://127.0.0.1:${resolveServerPort()}/artifacts/${artifactId}?token=${encodeURIComponent(this.artifactStore.get(artifactId)!.downloadToken)}`,
            }
          : message.result,
      );
      this.lastSuccessAt = new Date();
    } else {
      const error = message.error!;
      this.lastError = error.message;
      pending.reject(new NativeProtocolError(error.code, error.message, error.details));
    }
  }

  private async handleProtocolRequest(message: NativeRequest): Promise<void> {
    if (
      this.respondedProtocolRequests.has(message.requestId) ||
      this.activeProtocolRequests.has(message.requestId)
    )
      return;
    this.activeProtocolRequests.add(message.requestId);
    const controller = new AbortController();
    this.activeProtocolControllers.set(message.requestId, controller);
    const deadlineTimer = setTimeout(
      () => controller.abort(),
      Math.max(1, message.deadlineAt - Date.now()),
    );
    if (message.deadlineAt <= Date.now()) {
      this.sendProtocolResponseOnce(
        message,
        createNativeErrorResponse(
          message,
          new NativeProtocolError('DEADLINE_EXCEEDED', 'Request deadline exceeded'),
        ),
      );
      clearTimeout(deadlineTimer);
      this.activeProtocolControllers.delete(message.requestId);
      this.activeProtocolRequests.delete(message.requestId);
      return;
    }
    try {
      switch (message.method) {
        case 'native.start':
          await this.startServer(resolveServerPort((message.params as any)?.port));
          if (controller.signal.aborted)
            throw new NativeProtocolError('CANCELED', 'Request canceled');
          this.sendProtocolResponseOnce(message, {
            version: NATIVE_PROTOCOL_VERSION,
            type: 'response',
            requestId: message.requestId,
            traceId: message.traceId,
            ok: true,
            result: { started: true },
          });
          return;
        case 'native.stop':
          await this.stopServer();
          if (controller.signal.aborted)
            throw new NativeProtocolError('CANCELED', 'Request canceled');
          this.sendProtocolResponseOnce(message, {
            version: NATIVE_PROTOCOL_VERSION,
            type: 'response',
            requestId: message.requestId,
            traceId: message.traceId,
            ok: true,
            result: { stopped: true },
          });
          return;
        case 'file.operation':
          {
            const result = await fileHandler.handleFileRequest(message.params);
            if (controller.signal.aborted) {
              throw new NativeProtocolError(
                message.deadlineAt <= Date.now() ? 'DEADLINE_EXCEEDED' : 'CANCELED',
                'Request canceled',
              );
            }
            this.sendProtocolResponseOnce(message, createNativeResponse(message, result));
          }
          return;
        default:
          this.sendProtocolResponseOnce(
            message,
            createNativeErrorResponse(
              message,
              new NativeProtocolError('EXECUTION_UNKNOWN', `Unsupported method: ${message.method}`),
            ),
          );
      }
    } catch (error) {
      const errorCode = controller.signal.aborted
        ? message.deadlineAt <= Date.now()
          ? 'DEADLINE_EXCEEDED'
          : 'CANCELED'
        : error instanceof NativeProtocolError
          ? error.code
          : 'BROWSER_ERROR';
      this.sendProtocolResponseOnce(
        message,
        createNativeErrorResponse(
          message,
          new NativeProtocolError(
            errorCode,
            error instanceof Error ? error.message : String(error),
          ),
        ),
      );
    } finally {
      clearTimeout(deadlineTimer);
      this.activeProtocolRequests.delete(message.requestId);
      this.activeProtocolControllers.delete(message.requestId);
    }
  }

  private sendProtocolResponseOnce(request: NativeRequest, response: object): void {
    if (this.respondedProtocolRequests.has(request.requestId)) return;
    if (this.respondedProtocolRequests.size >= this.maxDeduplicatedRequests) {
      const oldest = this.respondedProtocolRequests.values().next().value;
      if (typeof oldest === 'string') this.respondedProtocolRequests.delete(oldest);
    }
    this.respondedProtocolRequests.add(request.requestId);
    this.sendMessage(response);
  }

  /**
   * Send request to Chrome and wait for response
   * @param messagePayload Data to send to Chrome
   * @param timeoutMs Timeout for waiting response (milliseconds)
   * @returns Promise, resolves to Chrome's returned payload on success, rejects on failure
   */
  public sendRequestToExtensionAndWait(
    messagePayload: any,
    messageType: string = 'request_data',
    timeoutMs: number = TIMEOUTS.DEFAULT_REQUEST_TIMEOUT,
    signal?: AbortSignal,
    onProgress?: (payload: any) => void | Promise<void>,
    traceIdOverride?: string,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(
          new NativeProtocolError(
            'NATIVE_DISCONNECTED',
            'Chrome extension is not connected to the Native Host.',
          ),
        );
        return;
      }
      const requestId = randomUUID();
      const traceId = traceIdOverride || randomUUID();
      const deadlineAt = Date.now() + timeoutMs;
      const method = this.protocolMethodFor(messageType);
      const sideEffect = this.isSideEffectRequest(method, messagePayload);
      let settled = false;

      const cancel = () => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending || pending.settled) return;
        clearTimeout(pending.timeoutId);
        pending.settled = true;
        this.pendingRequests.delete(requestId);
        this.cancelCount += 1;
        structuredLog('request.canceled', { requestId, traceId, method });
        this.sendMessage({
          version: NATIVE_PROTOCOL_VERSION,
          type: 'cancel',
          requestId,
          traceId,
          reason: 'client_abort',
        });
        reject(
          new NativeProtocolError(
            sideEffect ? 'EXECUTION_UNKNOWN' : 'CANCELED',
            sideEffect
              ? 'Side-effect execution state is unknown after cancellation'
              : 'Request canceled',
          ),
        );
      };
      if (signal?.aborted) {
        reject(new NativeProtocolError('CANCELED', 'Request canceled'));
        return;
      }
      signal?.addEventListener('abort', cancel, { once: true });

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending || pending.settled) return;
        pending.settled = true;
        this.pendingRequests.delete(requestId);
        this.timeoutCount += 1;
        this.lastError = `Request deadline exceeded at ${deadlineAt}`;
        structuredLog('request.timeout', { requestId, traceId, method, deadlineAt });
        signal?.removeEventListener('abort', cancel);
        this.sendMessage({
          version: NATIVE_PROTOCOL_VERSION,
          type: 'cancel',
          requestId,
          traceId,
          reason: 'deadline_exceeded',
        });
        reject(
          new NativeProtocolError(
            sideEffect ? 'EXECUTION_UNKNOWN' : 'DEADLINE_EXCEEDED',
            sideEffect
              ? 'Side-effect execution state is unknown after deadline cancellation'
              : `Request deadline exceeded at ${deadlineAt}`,
          ),
        );
      }, timeoutMs);

      // Store request's resolve/reject functions and timeout ID
      this.pendingRequests.set(requestId, {
        resolve: (value) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', cancel);
          resolve(value);
        },
        reject: (reason) => {
          if (settled) return;
          settled = true;
          signal?.removeEventListener('abort', cancel);
          reject(reason);
        },
        onProgress,
        timeoutId,
        traceId,
        method,
        sideEffect,
        settled: false,
      });

      // Send message with requestId to Chrome
      void this.writeNativeMessage({
        version: NATIVE_PROTOCOL_VERSION,
        type: 'request',
        requestId,
        traceId,
        method,
        deadlineAt,
        params: messagePayload,
      }).catch((error: unknown) => {
        const pending = this.pendingRequests.get(requestId);
        if (!pending || pending.settled) return;

        clearTimeout(pending.timeoutId);
        pending.settled = true;
        this.pendingRequests.delete(requestId);
        const writeError = error instanceof Error ? error : new Error(String(error));
        const reason = pending.sideEffect
          ? new NativeProtocolError(
              'EXECUTION_UNKNOWN',
              'Side-effect execution state is unknown after native message send failure',
            )
          : writeError;
        this.lastError = writeError.message;
        structuredLog('native.request_send_error', {
          requestId,
          traceId,
          method,
          error: writeError.message,
        });
        pending.reject(reason);
      });
    });
  }

  private isSideEffectRequest(method: string, payload: any): boolean {
    if (
      method === 'rr.runFlow' ||
      method === 'file.operation' ||
      /^rr_v3\.(cancel|pause|resume)Run$/.test(method)
    )
      return true;
    if (method !== 'browser.callTool') return false;
    const name = typeof payload?.name === 'string' ? payload.name : '';
    return /(?:click|submit|delete|download|upload|create|close|navigate|fill|select|keyboard|paste|bookmark|storage_(?:set|delete)|dialog|userscript|proxy|record|rotate|post_to)/i.test(
      name,
    );
  }

  private protocolMethodFor(messageType: string): string {
    switch (messageType) {
      case 'call_tool':
        return 'browser.callTool';
      case 'process_data':
        return 'browser.processData';
      case 'rr_list_published_flows':
        return 'rr.listPublishedFlows';
      case 'rr_run_flow':
        return 'rr.runFlow';
      default:
        return messageType;
    }
  }

  /**
   * Start Fastify server (now accepts Server instance)
   */
  private async startServer(port: number): Promise<void> {
    if (!this.associatedServer) {
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      if (this.associatedServer.isRunning) {
        await this.associatedServer.startService();
        this.sendMessage({
          version: NATIVE_PROTOCOL_VERSION,
          type: 'event',
          event: 'native.serverStarted',
          data: { port },
        });
        return;
      }

      await this.associatedServer.start(port, this);

      this.sendMessage({
        version: NATIVE_PROTOCOL_VERSION,
        type: 'event',
        event: 'native.serverStarted',
        data: { port },
      });
    } catch (error: any) {
      if (isAddressInUse(error)) {
        // Decision 13: the bind is the lock, so the loser of a spawn race simply exits
        // and the stub polls for whoever won. Only a stub-spawned server may do that
        // silently — a human running `start` deserves the error below.
        if (process.env.CHROME_MCP_SPAWNED_BY_STUB === '1') {
          structuredLog('native.lost_bind_race', { port });
          process.exit(0);
        }
        structuredLog('native.port_unavailable', { port });
        this.sendError(`Port ${port} is already in use.`, 'BROWSER_ERROR');
        return;
      }
      this.sendError(`Failed to start server: ${error.message}`);
    }
  }

  /**
   * Stop Fastify server
   */
  public async stopService(): Promise<void> {
    if (!this.associatedServer) {
      this.sendError('Internal error: server instance not set');
      return;
    }
    try {
      // Check status through associatedServer
      if (!this.associatedServer.isRunning) {
        this.sendError('Server is not running', 'BROWSER_ERROR');
        return;
      }

      await this.associatedServer.stopService();

      this.sendMessage({
        version: NATIVE_PROTOCOL_VERSION,
        type: 'event',
        event: 'native.serverStopped',
      });
    } catch (error: any) {
      this.sendError(`Failed to stop server: ${error.message}`);
    }
  }

  public async startService(port = resolveServerPort(NATIVE_SERVER_PORT)): Promise<void> {
    await this.startServer(port);
  }

  private async stopServer(): Promise<void> {
    await this.stopService();
  }

  /**
   * Send message to Chrome extension
   */
  private writeNativeMessage(message: any): Promise<void> {
    let payload: string;
    try {
      payload = JSON.stringify(message);
      const limit = this.transport.maxMessageBytes;
      // Checked here, synchronously, so an oversized message fails before any I/O
      // rather than on a later microtask.
      if (limit !== undefined && Buffer.byteLength(payload) > limit) {
        throw new Error(`Native output exceeds ${limit} bytes`);
      }
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : String(error);
      structuredLog('native.send_error', { error: this.lastError });
      return Promise.reject(error instanceof Error ? error : new Error(this.lastError));
    }
    return this.transport.send(payload).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      structuredLog('native.send_error', { error: this.lastError });
      throw error instanceof Error ? error : new Error(this.lastError);
    });
  }

  public sendMessage(message: any): void {
    void this.writeNativeMessage(message).catch((error: unknown) => {
      this.lastError = error instanceof Error ? error.message : String(error);
      structuredLog('native.send_error', { error: this.lastError });
    });
  }

  /**
   * Send error message to Chrome extension (mainly for sending non-request-response type errors)
   */
  private sendError(errorMessage: string, code: string = 'INVALID_REQUEST'): void {
    this.sendMessage({
      version: NATIVE_PROTOCOL_VERSION,
      type: 'event',
      event: 'native.error',
      data: { code, message: errorMessage },
    });
  }

  /**
   * Reject this connection's in-flight work and release its resources.
   *
   * Nothing is replayed. The server cannot distinguish "never arrived" from "executed,
   * reply lost", so re-dispatching on a fresh socket would risk firing a click twice.
   * Retry is the caller's decision.
   */
  public dispose(reason = 'Native host is shutting down or Chrome disconnected.'): void {
    this.connected = false;
    this.connectionState = 'stopped';
    this.lastError = reason;
    this.artifactStore.cleanupIncomplete();
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeoutId);
      pending.reject(
        new NativeProtocolError(
          pending.sideEffect ? 'EXECUTION_UNKNOWN' : 'NATIVE_DISCONNECTED',
          reason,
        ),
      );
    });
    this.pendingRequests.clear();
    for (const controller of this.activeProtocolControllers.values()) controller.abort();
    this.activeProtocolControllers.clear();
  }

  /**
   * Clean up resources
   */
  private cleanup(): void {
    this.dispose();
    // A shared event channel outlives any one connection, so only its owner stops it.
    if (this.ownsEventChannel) void this.eventChannel.stop();
    // One server now serves several browsers: a closing socket must not take it down.
    if (!this.exitProcessOnClose) return;

    if (this.associatedServer && this.associatedServer.isRunning) {
      this.associatedServer
        .stop()
        .then(() => {
          process.exit(0);
        })
        .catch(() => {
          process.exit(1);
        });
    } else {
      process.exit(0);
    }
  }
}

const nativeMessagingHostInstance = new NativeMessagingHost();
export default nativeMessagingHostInstance;
