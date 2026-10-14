/**
 * HTTP Server - Core server implementation.
 *
 * Responsibilities:
 * - Fastify instance management
 * - Plugin registration (CORS, etc.)
 * - Route delegation to specialized modules
 * - MCP transport handling
 * - Server lifecycle management
 */
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import cors from '@fastify/cors';
import {
  NATIVE_SERVER_PORT,
  TIMEOUTS,
  SERVER_CONFIG,
  HTTP_STATUS,
  ERROR_MESSAGES,
  isAllowedCorsOrigin,
  MCP_ENABLE_DEBUG_ENDPOINTS_ENV,
  MCP_MAX_HTTP_BODY_BYTES_ENV,
  MCP_API_KEY_ENV,
} from '../constant';
import { resolveApiKey } from '../api-key.js';
import { NativeMessagingHost } from '../native-messaging-host';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { randomUUID } from 'node:crypto';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { getMcpServer } from '../mcp/mcp-server';
import { getModernMcpServer } from '../mcp/mcp-server-modern.js';
import { getLegacyMcpServer } from '../mcp/mcp-server-legacy.js';
import { AgentStreamManager } from '../agent/stream-manager';
import { AgentChatService } from '../agent/chat-service';
import { CodexEngine } from '../agent/engines/codex';
import { ClaudeEngine } from '../agent/engines/claude';
import { DeepSeekEngine } from '../agent/engines/deepseek';
import { closeDb } from '../agent/db';
import { registerAgentRoutes } from './routes';
import { NATIVE_PROTOCOL_VERSION, TOOL_SCHEMAS } from '@ethanwilkins/chrome-mcp-shared-2026';
import packageJson from '../../package.json';
import {
  getRecentToolCalls,
  getToolAdmissionStats,
  getToolObservabilityStats,
} from '../mcp/register-tools';
import { NativeMessageType } from '@ethanwilkins/chrome-mcp-shared-2026';
import { browserProfileManager } from '../browser-profile-manager.js';
import { createReadStream } from 'node:fs';
import { RuntimeRegistry } from '../runtime-registry';

// ============================================================
// Types
// ============================================================

interface ExtensionRequestPayload {
  data?: unknown;
}

type McpTransport = StreamableHTTPServerTransport | SSEServerTransport;
type McpTransportType = 'streamable-http' | 'sse' | 'stdio';
type McpEndpoint = '/mcp' | '/mcp-new' | '/sse';
const STDIO_MCP_ORIGIN = 'chrome-extension://mcp-stdio';

interface McpClientInfo {
  name: string;
  version: string;
}

interface McpSessionMetadata {
  transportType: McpTransportType;
  endpoint: McpEndpoint;
  clientInfo?: McpClientInfo | null;
  remoteAddress?: string | null;
  userAgent?: string | null;
}

interface McpSession {
  transport: McpTransport;
  transportType: McpTransportType;
  endpoint: McpEndpoint;
  clientInfo: McpClientInfo | null;
  remoteAddress: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastActivityAt: Date;
  activeRequests: number;
  requestCount: number;
  totalRequestLatencyMs: number;
  lastRequestLatencyMs: number | null;
  maxRequestLatencyMs: number | null;
  latencySamplesMs: number[];
  errorCount: number;
  lastError: string | null;
}

interface StatelessMcpStats {
  activeRequests: number;
  requestCount: number;
  lastRequestAt: Date | null;
  lastRequestLatencyMs: number | null;
  clientInfo: McpClientInfo | null;
  remoteAddress: string | null;
  userAgent: string | null;
  errorCount: number;
}

interface ActiveMcpRequest {
  requestId: string;
  method: string;
  toolName: string | null;
  jsonRpcId: string | number | null;
  endpoint?: McpEndpoint;
  transport?: McpTransportType;
  sessionId?: string | null;
  clientInfo: McpClientInfo | null;
  remoteAddress: string | null;
  userAgent: string | null;
  startedAt: string;
  cancelRequestedAt: string | null;
  cancel: () => boolean;
}

type McpRequestStatus = 'running' | 'success' | 'error' | 'cancelled';

interface McpRequestRecord {
  requestId: string;
  method: string;
  toolName: string | null;
  jsonRpcId: string | number | null;
  endpoint: McpEndpoint;
  transport: McpTransportType;
  sessionId: string | null;
  clientInfo: McpClientInfo | null;
  remoteAddress: string | null;
  userAgent: string | null;
  startedAt: string;
  elapsedMs: number;
  status: McpRequestStatus;
  cancelRequestedAt: string | null;
  error: string | null;
}
const SESSION_TTL_MS = 10 * 60_000;
const RECENT_MCP_REQUEST_LIMIT = 20;

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1);
  return sorted[index];
}

function getHeaderValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join(', ');
  return value ?? null;
}

function getMcpClientInfo(body: unknown): McpClientInfo | null {
  if (!body || typeof body !== 'object') return null;

  const params =
    'params' in body && body.params && typeof body.params === 'object' ? body.params : null;
  const directClientInfo =
    params && 'clientInfo' in params && params.clientInfo && typeof params.clientInfo === 'object'
      ? params.clientInfo
      : null;
  const meta =
    params && '_meta' in params && params._meta && typeof params._meta === 'object'
      ? params._meta
      : null;
  const modernClientInfo =
    meta &&
    'io.modelcontextprotocol/clientInfo' in meta &&
    meta['io.modelcontextprotocol/clientInfo'] &&
    typeof meta['io.modelcontextprotocol/clientInfo'] === 'object'
      ? meta['io.modelcontextprotocol/clientInfo']
      : null;
  const clientInfo = directClientInfo ?? modernClientInfo;
  if (!clientInfo) return null;

  const name =
    'name' in clientInfo && typeof clientInfo.name === 'string' ? clientInfo.name.trim() : '';
  const version =
    'version' in clientInfo && typeof clientInfo.version === 'string'
      ? clientInfo.version.trim()
      : '';
  if (!name && !version) return null;

  return {
    name: name || 'Unknown client',
    version: version || 'Unknown version',
  };
}

function createHttpAbortController(request: FastifyRequest, reply: FastifyReply): AbortController {
  const controller = new AbortController();
  const abort = () => {
    if (!reply.raw.writableEnded) controller.abort();
  };
  request.raw.once('aborted', abort);
  reply.raw.once('close', abort);
  return controller;
}

// ============================================================
// Server Class
// ============================================================

export class Server {
  private fastify: FastifyInstance;
  public isRunning = false;
  /** Keep the control plane alive while the Chrome-facing service is paused. */
  public serviceEnabled = false;
  private nativeHost: NativeMessagingHost | null = null;
  private transportsMap = new Map<string, McpSession>();
  private readonly statelessMcpStats: StatelessMcpStats = {
    activeRequests: 0,
    requestCount: 0,
    lastRequestAt: null,
    lastRequestLatencyMs: null,
    clientInfo: null,
    remoteAddress: null,
    userAgent: null,
    errorCount: 0,
  };
  private readonly mcpRequests = new Map<string, ActiveMcpRequest>();
  private readonly recentMcpRequests: McpRequestRecord[] = [];
  // Keep the old private name as an alias for compatibility with diagnostics
  // and tests written for the original /mcp-new-only monitor.
  private readonly statelessMcpRequests = this.mcpRequests;
  private startedAt = Date.now();
  private reclaimedSessions = 0;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private takeoverRequested = false;
  private agentStreamManager: AgentStreamManager;
  private agentChatService: AgentChatService;
  private readonly runtimeRegistry = new RuntimeRegistry();
  /** Streamable HTTP (preview): MCP 2026-07-28, stateless and strict. */
  private readonly modernMcpHandler = createMcpHandler(() => getModernMcpServer(), {
    legacy: 'reject',
    keepAliveMs: 15_000,
  });
  private readonly modernMcpNodeHandler = toNodeHandler(this.modernMcpHandler);

  constructor() {
    this.fastify = Fastify({
      logger: SERVER_CONFIG.LOGGER_ENABLED,
      bodyLimit:
        Number.parseInt(process.env[MCP_MAX_HTTP_BODY_BYTES_ENV] || '8388608', 10) ||
        8 * 1024 * 1024,
      // Give clients that reuse an HTTP connection enough time between calls.
      keepAliveTimeout: 60_000,
      connectionTimeout: 0,
    });
    this.agentStreamManager = new AgentStreamManager();
    this.agentChatService = new AgentChatService({
      engines: [new CodexEngine(), new ClaudeEngine(), new DeepSeekEngine()],
      streamManager: this.agentStreamManager,
      runtimeRegistry: this.runtimeRegistry,
    });
    this.setupPlugins();
    this.setupMcpAuth();
    this.setupRoutes();
  }

  /**
   * Associate NativeMessagingHost instance.
   */
  public setNativeHost(nativeHost: NativeMessagingHost): void {
    this.nativeHost = nativeHost;
  }

  private async setupPlugins(): Promise<void> {
    await this.fastify.register(cors, {
      origin: (origin, cb) => {
        // Allow requests with no origin (e.g., curl, server-to-server)
        if (!origin) {
          return cb(null, true);
        }
        cb(null, isAllowedCorsOrigin(origin));
      },
      methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      credentials: true,
    });
  }

  private setupRoutes(): void {
    // Health check
    this.setupHealthRoutes();

    this.setupServiceGate();

    // Extension communication
    this.setupExtensionRoutes();

    // Agent routes (delegated to separate module)
    registerAgentRoutes(this.fastify, {
      streamManager: this.agentStreamManager,
      chatService: this.agentChatService,
    });

    // MCP routes
    this.setupMcpRoutes();
  }

  private setupServiceGate(): void {
    this.fastify.addHook('onRequest', async (request, reply) => {
      const pathname = (request.raw.url ?? '').split('?')[0];
      if (!['/mcp', '/mcp-new', '/sse', '/messages', '/ask-extension'].includes(pathname)) return;
      if (this.serviceEnabled) return;
      reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
        error: 'The Chrome MCP Bridge service is stopped. Start it from the client first.',
      });
    });
  }

  /**
   * Protect MCP transports when an API key is configured. Local installs with
   * no key remain backwards compatible.
   */
  private setupMcpAuth(): void {
    this.fastify.addHook('onRequest', async (request, reply) => {
      const pathname = (request.raw.url ?? '').split('?')[0];
      const isMcpRoute = ['/mcp', '/mcp-new', '/sse', '/messages'].includes(pathname);
      const isChannelMintRoute = pathname === '/__chrome_mcp_bridge/bootstrap';
      const isProtectedLocalRoute =
        pathname === '/status' ||
        pathname === '/__chrome_mcp_bridge/error-diagnostics' ||
        pathname === '/__chrome_mcp_bridge/error-diagnostics/clear' ||
        pathname === '/ask-extension' ||
        pathname === '/agent' ||
        pathname.startsWith('/agent/') ||
        pathname.startsWith('/artifacts/') ||
        pathname === '/__chrome_mcp_bridge/start' ||
        // Mints a WS token, so it must not be reachable from a page. A browser forces
        // a cross-origin Origin header; P6 tightens this to require the API key.
        pathname === '/__chrome_mcp_bridge/bootstrap' ||
        // Unauthenticated, this lets any web page POST here and call process.exit(0)
        // on the bridge. A browser forces a cross-origin Origin header, so the check
        // blocks a drive-by page; a local process could always kill us directly.
        pathname === '/__chrome_mcp_bridge/takeover' ||
        pathname === '/__chrome_mcp_bridge/stop' ||
        pathname.startsWith('/__chrome_mcp_bridge/requests/') ||
        pathname.startsWith('/__chrome_mcp_bridge/mcp-new/requests/');
      const isRuntimeRoute =
        pathname === '/__chrome_mcp_bridge/runtime' ||
        pathname.startsWith('/__chrome_mcp_bridge/runtime/');
      if (!isMcpRoute && !isProtectedLocalRoute && !isRuntimeRoute) return;

      // Generated and persisted on first use, so there is always a key to require on
      // the MCP surface. An explicitly configured key stays strict everywhere, which
      // is what it has always meant — only the generated baseline is narrower.
      const configuredKey = process.env[MCP_API_KEY_ENV]?.trim();
      const expectedKey = resolveApiKey();
      const origin = request.headers.origin;
      if (origin && !isAllowedCorsOrigin(origin)) {
        reply.status(HTTP_STATUS.FORBIDDEN).send({ error: ERROR_MESSAGES.ORIGIN_NOT_ALLOWED });
        return;
      }
      const artifactId =
        isProtectedLocalRoute && pathname.startsWith('/artifacts/')
          ? pathname.slice('/artifacts/'.length)
          : '';
      const artifactToken =
        new URL(request.raw.url ?? '/', 'http://127.0.0.1').searchParams.get('token') || '';
      const artifactTokenAccepted = Boolean(
        artifactId &&
        this.nativeHost?.getArtifactStore().consumeDownloadToken(artifactId, artifactToken),
      );
      if (artifactTokenAccepted) return;

      const authorization = request.headers.authorization;
      const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
      const providedKey = bearer ?? request.headers['x-api-key'];

      // Neither an Origin nor a credential: nothing identifies this caller. Keyed off
      // what was *presented*, not off whether a key exists — now that one is always
      // generated, testing `!expectedKey` here would let an anonymous caller through.
      // With a key explicitly configured, a missing credential has always been 401
      // "missing or invalid key"; only the keyless case answers 403.
      if (
        (isMcpRoute || isProtectedLocalRoute || isRuntimeRoute) &&
        !origin &&
        !providedKey &&
        !configuredKey
      ) {
        reply.status(HTTP_STATUS.FORBIDDEN).send({ error: ERROR_MESSAGES.ORIGIN_NOT_ALLOWED });
        return;
      }
      // Browsers do not send Authorization on CORS preflight requests; the
      // actual MCP request is authenticated below.
      if (request.method === 'OPTIONS') return;

      if (expectedKey && providedKey === expectedKey) return;

      // A loopback Origin used to be sufficient here, which meant a plain curl with
      // `Origin: http://127.0.0.1` could drive the browser. The key is now required on
      // the MCP surface and on the route that mints WS tokens. A generated key that
      // nothing enforces is theatre, and "enforce later" is the version that never
      // happens — so this breaks existing client configs deliberately.
      if (isMcpRoute || isChannelMintRoute) {
        reply.status(HTTP_STATUS.UNAUTHORIZED).send({ error: ERROR_MESSAGES.UNAUTHORIZED });
        return;
      }

      if (configuredKey || artifactId) {
        reply.status(HTTP_STATUS.UNAUTHORIZED).send({ error: ERROR_MESSAGES.UNAUTHORIZED });
        return;
      }
      // The server is loopback-only; the remaining local routes — /status among them,
      // which the popup reads with no headers of its own — stay Origin-checked only.
    });
  }

  // ============================================================
  // Health Routes
  // ============================================================

  private setupHealthRoutes(): void {
    this.fastify.get('/ping', async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.status(HTTP_STATUS.OK).send({
        status: 'ok',
        message: 'pong',
      });
    });
    this.fastify.get(
      '/status',
      async (request: FastifyRequest<{ Querystring: { probe?: string } }>, reply: FastifyReply) => {
        const sessions = [...this.transportsMap.values()];
        const activeMcpRequests = this.activeMcpRequestSnapshots();
        let probe: Record<string, unknown> | undefined;
        if (request.query.probe === '1' && this.serviceEnabled) {
          const startedAt = Date.now();
          try {
            const response = await this.nativeHost?.sendRequestToExtensionAndWait(
              { name: 'chrome_get_tab_url', args: {} },
              NativeMessageType.CALL_TOOL,
              3_000,
            );
            probe = { ok: response?.status === 'success', elapsedMs: Date.now() - startedAt };
          } catch (error) {
            probe = { ok: false, elapsedMs: Date.now() - startedAt, error: String(error) };
          }
        }
        const admission = getToolAdmissionStats();
        const nativeStatus = this.nativeHost?.getStatus() ?? null;
        const requestObservability = getToolObservabilityStats();
        const observability = {
          connectionState: nativeStatus?.state ?? 'stopped',
          pendingRequests: nativeStatus?.pendingRequests ?? 0,
          activeTools: admission.active,
          queuedTools: admission.queued,
          reconnectCount: nativeStatus?.reconnectCount ?? 0,
          timeoutCount: (nativeStatus?.timeoutCount ?? 0) + admission.timedOut,
          cancelCount: (nativeStatus?.cancelCount ?? 0) + admission.cancelled,
          queueRejectCount: admission.rejected,
          lastError: nativeStatus?.lastError ?? null,
          lastTimings: requestObservability.lastTimings ?? nativeStatus?.lastTimings ?? null,
        };
        return reply.status(HTTP_STATUS.OK).send({
          server: {
            version: packageJson.version,
            protocolVersion: NATIVE_PROTOCOL_VERSION,
            running: this.isRunning,
            serviceRunning: this.serviceEnabled,
            uptimeMs: Date.now() - this.startedAt,
          },
          packages: {
            'mcp-chrome-bridge-2026': packageJson.version,
          },
          mcp: {
            activeSessions: sessions.length,
            activeRequests: activeMcpRequests.length,
            requests: activeMcpRequests,
            recentRequests: this.recentMcpRequests.slice(),
            reclaimedSessions: this.reclaimedSessions,
            streamableHttp: true,
            clients: [...this.transportsMap.entries()].map(([sessionId, session]) => ({
              sessionId,
              clientInfo: session.clientInfo,
              transport: session.transportType,
              endpoint: session.endpoint,
              remoteAddress: session.remoteAddress,
              userAgent: session.userAgent,
              createdAt: session.createdAt.toISOString(),
              lastActivityAt: session.lastActivityAt.toISOString(),
              activeRequests: session.activeRequests,
              requestCount: session.requestCount,
              lastRequestLatencyMs: session.lastRequestLatencyMs,
              p95RequestLatencyMs: percentile(session.latencySamplesMs, 0.95),
              averageRequestLatencyMs: session.requestCount
                ? Math.round(session.totalRequestLatencyMs / session.requestCount)
                : null,
              maxRequestLatencyMs: session.maxRequestLatencyMs,
              errorCount: session.errorCount,
              lastError: session.lastError,
            })),
            stateless: {
              endpoint: '/mcp-new',
              transport: 'streamable-http',
              activeRequests: this.statelessMcpStats.activeRequests,
              requestCount: this.statelessMcpStats.requestCount,
              lastRequestAt: this.statelessMcpStats.lastRequestAt?.toISOString() ?? null,
              lastRequestLatencyMs: this.statelessMcpStats.lastRequestLatencyMs,
              clientInfo: this.statelessMcpStats.clientInfo,
              remoteAddress: this.statelessMcpStats.remoteAddress,
              userAgent: this.statelessMcpStats.userAgent,
              errorCount: this.statelessMcpStats.errorCount,
              requests: activeMcpRequests.filter(
                (activeRequest) =>
                  activeRequest.endpoint === '/mcp-new' || activeRequest.endpoint === undefined,
              ),
            },
          },
          extension: this.nativeHost?.getStatus() ?? null,
          nativeHost: this.nativeHost?.getStatus() ?? null,
          ...observability,
          observability,
          tools: { count: TOOL_SCHEMAS.length },
          toolAdmission: getToolAdmissionStats(),
          browserProfiles: await browserProfileManager.summary(),
          recentToolCalls: getRecentToolCalls(),
          ...(probe ? { probe } : {}),
        });
      },
    );
    this.fastify.get('/__chrome_mcp_bridge/error-diagnostics', async (_request, reply) => {
      const terminals: Array<{
        terminalId: string;
        name: string;
        status: string;
        logs: unknown[];
        error?: string;
      }> = [];
      const errors: string[] = [];

      const [currentChrome, profileTerminals] = await Promise.all([
        (async () => {
          if (!this.nativeHost?.isExtensionConnected()) {
            return { terminal: null, error: 'The current Chrome extension is not connected' };
          }
          try {
            const response = await this.nativeHost.sendRequestToExtensionAndWait(
              { name: 'chrome_error_logs', args: {} },
              NativeMessageType.CALL_TOOL,
              5_000,
            );
            const value = response?.data?.content?.find((item: any) => item?.type === 'text')?.text;
            const parsed = typeof value === 'string' ? JSON.parse(value) : {};
            return {
              terminal: {
                terminalId: 'default',
                name: 'Current Chrome',
                status: 'running',
                logs: Array.isArray(parsed?.logs) ? parsed.logs : [],
              },
              error: null,
            };
          } catch (error) {
            return {
              terminal: null,
              error: `Failed to read the current Chrome error log: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        })(),
        browserProfileManager.errorLogs(),
      ]);
      if (currentChrome.terminal) terminals.push(currentChrome.terminal);
      if (currentChrome.error) errors.push(currentChrome.error);
      terminals.push(...profileTerminals);
      reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
      return reply.status(HTTP_STATUS.OK).send({
        generatedAt: new Date().toISOString(),
        terminals,
        errors,
      });
    });

    this.fastify.get('/__chrome_mcp_bridge/runtime', async (_request, reply) => {
      await this.syncWorkflowTasks();
      const tasks = this.runtimeRegistry.list();
      return reply.status(HTTP_STATUS.OK).send({
        generatedAt: new Date().toISOString(),
        tasks,
        activeCount: tasks.filter((task) =>
          ['running', 'waiting', 'paused', 'cancelling'].includes(task.summary.status),
        ).length,
      });
    });

    const controlRuntimeTask = async (
      request: FastifyRequest,
      reply: FastifyReply,
      action: string,
    ) => {
      const { taskId } = request.params as { taskId?: string };
      const id = taskId?.trim();
      const task = id ? this.runtimeRegistry.get(id) : null;
      if (!id || !task) {
        return reply
          .status(HTTP_STATUS.NOT_FOUND)
          .send({ error: 'The task does not exist or has expired.' });
      }
      if (['success', 'error', 'cancelled', 'unknown'].includes(task.summary.status)) {
        return action === 'cancel'
          ? reply.status(HTTP_STATUS.OK).send({ taskId: id, status: task.summary.status })
          : reply.status(HTTP_STATUS.CONFLICT).send({
              error: 'The task has already finished, so this operation is not possible.',
              taskId: id,
            });
      }
      if (action === 'pause' && !task.summary.pausable) {
        return reply
          .status(HTTP_STATUS.CONFLICT)
          .send({ error: 'This task cannot be paused.', taskId: id });
      }
      if (action === 'resume' && task.summary.status !== 'paused') {
        return reply
          .status(HTTP_STATUS.CONFLICT)
          .send({ error: 'This task is not paused.', taskId: id });
      }
      try {
        if (action === 'cancel') {
          if (task.summary.kind === 'mcp') this.mcpRequests.get(id)?.cancel();
          else if (task.summary.kind === 'agent') this.agentChatService.cancelExecution(id);
          else if (this.nativeHost?.isExtensionConnected()) {
            await this.nativeHost.sendRequestToExtensionAndWait(
              { runId: id, reason: 'Cancelled from desktop runtime control' },
              'rr_v3.cancelRun',
              5_000,
            );
          } else {
            return reply
              .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
              .send({ error: 'The Chrome extension is not connected.' });
          }
          this.runtimeRegistry.update(id, 'cancelling', 'cancel_requested');
        } else if (action === 'pause' || action === 'resume') {
          if (task.summary.kind === 'agent') {
            const changed =
              action === 'pause'
                ? this.agentChatService.pauseExecution(id)
                : this.agentChatService.resumeExecution(id);
            if (!changed)
              return reply
                .status(HTTP_STATUS.CONFLICT)
                .send({ error: 'The agent run has finished.', taskId: id });
          } else {
            if (!this.nativeHost?.isExtensionConnected()) {
              return reply
                .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
                .send({ error: 'The Chrome extension is not connected.' });
            }
            await this.nativeHost.sendRequestToExtensionAndWait(
              { runId: id },
              action === 'pause' ? 'rr_v3.pauseRun' : 'rr_v3.resumeRun',
              5_000,
            );
            this.runtimeRegistry.update(
              id,
              action === 'pause' ? 'paused' : 'running',
              action === 'pause' ? 'paused' : 'resumed',
            );
          }
        } else if (action === 'focus') {
          if (typeof task.summary.tabId !== 'number') {
            return reply
              .status(HTTP_STATUS.CONFLICT)
              .send({ error: 'The task has no tab to focus.', taskId: id });
          }
          if (!this.nativeHost?.isExtensionConnected()) {
            return reply
              .status(HTTP_STATUS.SERVICE_UNAVAILABLE)
              .send({ error: 'The Chrome extension is not connected.' });
          }
          await this.nativeHost.sendRequestToExtensionAndWait(
            { name: 'chrome_switch_tab', args: { tabId: task.summary.tabId } },
            NativeMessageType.CALL_TOOL,
            5_000,
          );
        } else {
          return reply
            .status(HTTP_STATUS.BAD_REQUEST)
            .send({ error: 'Unsupported runtime operation.' });
        }
        return reply.status(HTTP_STATUS.OK).send({
          taskId: id,
          status: this.runtimeRegistry.get(id)?.summary.status ?? 'unknown',
        });
      } catch (error) {
        return reply.status(HTTP_STATUS.BAD_REQUEST).send({
          taskId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };
    for (const action of ['cancel', 'pause', 'resume', 'focus']) {
      this.fastify.post(`/__chrome_mcp_bridge/runtime/:taskId/${action}`, (request, reply) =>
        controlRuntimeTask(request, reply, action),
      );
    }

    this.fastify.post(
      '/__chrome_mcp_bridge/error-diagnostics/clear',
      async (
        request: FastifyRequest<{ Querystring: { terminalId?: string } }>,
        reply: FastifyReply,
      ) => {
        const terminalId = request.query.terminalId?.trim() || 'all';
        const errors: string[] = [];
        if (terminalId === 'all' || terminalId === 'default') {
          if (this.nativeHost?.isExtensionConnected()) {
            try {
              const response = await this.nativeHost.sendRequestToExtensionAndWait(
                { name: 'chrome_error_logs', args: { action: 'clear' } },
                NativeMessageType.CALL_TOOL,
                5_000,
              );
              if (response?.status !== 'success' || response.data?.isError) {
                throw new Error('The extension reported that clearing failed');
              }
            } catch (error) {
              errors.push(
                `Failed to clear the current Chrome error log: ${error instanceof Error ? error.message : String(error)}`,
              );
            }
          } else if (terminalId === 'default') {
            errors.push('The current Chrome extension is not connected');
          }
        }
        if (terminalId === 'all') {
          errors.push(...(await browserProfileManager.clearErrorLogs()));
        } else if (terminalId !== 'default') {
          errors.push(...(await browserProfileManager.clearErrorLogs(terminalId)));
        }
        return reply.status(errors.length ? HTTP_STATUS.BAD_REQUEST : HTTP_STATUS.OK).send({
          success: errors.length === 0,
          terminalId,
          errors,
        });
      },
    );

    this.fastify.post('/__chrome_mcp_bridge/start', async (_request, reply) => {
      if (process.env[MCP_ENABLE_DEBUG_ENDPOINTS_ENV] !== '1') {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({ status: 'not_found' });
      }
      if (!this.nativeHost) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
          status: 'not_available',
          message:
            'The Chrome native host is not connected yet. Check that the extension is loaded, then reload it.',
        });
      }
      try {
        await this.nativeHost.startService();
        return reply.status(HTTP_STATUS.OK).send({ status: 'started' });
      } catch (error) {
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.fastify.post('/__chrome_mcp_bridge/stop', async (_request, reply) => {
      if (process.env[MCP_ENABLE_DEBUG_ENDPOINTS_ENV] !== '1') {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({ status: 'not_found' });
      }
      if (!this.nativeHost) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
          status: 'not_available',
          message: 'The Chrome native host is not connected yet.',
        });
      }
      try {
        await this.nativeHost.stopService();
        return reply.status(HTTP_STATUS.OK).send({ status: 'stopped' });
      } catch (error) {
        return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    const cancelMcpRequest = async (request: FastifyRequest, reply: FastifyReply) => {
      const requestId = (request.params as { requestId?: string }).requestId?.trim();
      const activeRequest = requestId ? this.mcpRequests.get(requestId) : undefined;
      if (!activeRequest) {
        return reply.status(HTTP_STATUS.NOT_FOUND).send({
          status: 'not_found',
          message: 'The request has finished or does not exist.',
        });
      }

      if (activeRequest.cancelRequestedAt || !activeRequest.cancel()) {
        return reply.status(HTTP_STATUS.OK).send({
          status: 'cancelling',
          requestId: activeRequest.requestId,
        });
      }
      return reply.status(HTTP_STATUS.ACCEPTED).send({
        status: 'cancel_requested',
        requestId: activeRequest.requestId,
      });
    };
    this.fastify.post('/__chrome_mcp_bridge/requests/:requestId/cancel', cancelMcpRequest);
    // Keep the original path as a compatibility alias for older desktop clients.
    this.fastify.post('/__chrome_mcp_bridge/mcp-new/requests/:requestId/cancel', cancelMcpRequest);

    // A user may have opened the EXE before Chrome launches the Native
    // Messaging host. The latter must be able to take over the HTTP port so
    // the MCP server and the extension connection live in the same process.
    // A second browser's host cannot bind the port, so it asks the incumbent for a
    // channel and forwards it to its own extension. That browser then becomes another
    // socket on this server rather than a rival for the port.
    this.fastify.post('/__chrome_mcp_bridge/bootstrap', async (_request, reply) => {
      if (!this.isRunning || this.takeoverRequested) {
        return reply.status(404).send({ status: 'not_available' });
      }
      const channel = this.nativeHost?.getEventChannel();
      if (!channel) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({ status: 'no_channel' });
      }
      try {
        const info = await channel.start();
        return reply.status(HTTP_STATUS.OK).send({ status: 'ok', channel: info });
      } catch (error) {
        return reply.status(HTTP_STATUS.SERVICE_UNAVAILABLE).send({
          status: 'channel_unavailable',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.fastify.post('/__chrome_mcp_bridge/takeover', async (_request, reply) => {
      if (!this.isRunning || this.takeoverRequested) {
        return reply.status(404).send({ status: 'not_available' });
      }
      // Only a bridge that is not already driving a browser may hand the port over.
      // Yielding while an extension is attached would kill a working bridge, and the
      // evicted host's extension reconnects and takes the port straight back — two
      // browsers then trade it indefinitely. The original reason for takeover (a
      // manually launched standalone server with no browser attached) still applies,
      // because such a process reports no extension here.
      if (this.nativeHost?.isExtensionConnected()) {
        return reply.status(HTTP_STATUS.CONFLICT).send({ status: 'busy_with_extension' });
      }
      this.takeoverRequested = true;
      reply.status(HTTP_STATUS.OK).send({ status: 'stopping' });
      const stop = () => {
        void this.stop().finally(() => process.exit(0));
      };
      setTimeout(stop, 100).unref();
    });
  }

  /** Live MCP sessions. Zero does not mean idle on its own — see the idle watcher. */
  public get activeSessionCount(): number {
    return this.transportsMap.size;
  }

  public observeNativeResponse(method: string, result: unknown): void {
    if (method !== 'rr.runFlow' || !result || typeof result !== 'object') return;
    const envelope = result as { data?: { content?: Array<{ type?: string; text?: string }> } };
    const text = envelope.data?.content?.find((item) => item.type === 'text')?.text;
    if (!text) return;
    try {
      const run = JSON.parse(text) as { id?: unknown; flowId?: unknown; tabId?: unknown };
      if (typeof run.id !== 'string') return;
      this.runtimeRegistry.start({
        taskId: run.id,
        kind: 'workflow',
        label: typeof run.flowId === 'string' ? `Workflow · ${run.flowId}` : 'Workflow',
        tabId: typeof run.tabId === 'number' ? run.tabId : null,
        cancelable: true,
        pausable: true,
      });
    } catch {
      // A malformed extension result must not affect the original MCP call.
    }
  }

  private async syncWorkflowTasks(): Promise<void> {
    if (!this.nativeHost?.isExtensionConnected()) return;
    for (const record of this.runtimeRegistry.active('workflow')) {
      try {
        const response = await this.nativeHost.sendRequestToExtensionAndWait(
          { runId: record.summary.taskId },
          'rr_v3.getRun',
          2_000,
        );
        const run = response?.data as
          | {
              status?: string;
              currentNodeId?: string;
              tabId?: number;
              error?: { message?: string };
            }
          | undefined;
        if (!run) continue;
        const status =
          run.status === 'succeeded'
            ? 'success'
            : run.status === 'failed'
              ? 'error'
              : run.status === 'canceled'
                ? 'cancelled'
                : run.status === 'paused'
                  ? 'paused'
                  : run.status === 'queued'
                    ? 'waiting'
                    : 'running';
        this.runtimeRegistry.update(record.summary.taskId, status, undefined, {
          toolName: run.currentNodeId ?? null,
          tabId: typeof run.tabId === 'number' ? run.tabId : record.summary.tabId,
          errorMessage: run.error?.message ?? null,
        });
        if (status === 'success' || status === 'error' || status === 'cancelled') {
          this.runtimeRegistry.finish(record.summary.taskId, status, run.error?.message);
        }
      } catch {
        this.runtimeRegistry.update(record.summary.taskId, 'unknown', 'error', {
          message: 'The Chrome extension cannot report workflow status right now',
        });
      }
    }
  }

  private addSession(
    sessionId: string,
    transport: McpTransport,
    metadata: McpSessionMetadata,
  ): void {
    this.transportsMap.set(sessionId, {
      transport,
      transportType: metadata.transportType,
      endpoint: metadata.endpoint,
      clientInfo: metadata.clientInfo ?? null,
      remoteAddress: metadata.remoteAddress ?? null,
      userAgent: metadata.userAgent ?? null,
      createdAt: new Date(),
      lastActivityAt: new Date(),
      activeRequests: 0,
      requestCount: 0,
      totalRequestLatencyMs: 0,
      lastRequestLatencyMs: null,
      maxRequestLatencyMs: null,
      latencySamplesMs: [],
      errorCount: 0,
      lastError: null,
    });
  }

  private recordRequestLatency(session: McpSession, startedAt: number): void {
    const latencyMs = Math.max(0, Date.now() - startedAt);
    session.requestCount++;
    session.totalRequestLatencyMs += latencyMs;
    session.lastRequestLatencyMs = latencyMs;
    session.latencySamplesMs.push(latencyMs);
    if (session.latencySamplesMs.length > 100) session.latencySamplesMs.shift();
    session.maxRequestLatencyMs = Math.max(session.maxRequestLatencyMs ?? 0, latencyMs);
  }

  private trackMcpRequest(
    request: FastifyRequest,
    reply: FastifyReply,
    metadata: {
      endpoint: McpEndpoint;
      transport: McpTransportType;
      sessionId?: string | null;
    },
  ): ActiveMcpRequest {
    const body = request.body as Record<string, unknown> | undefined;
    const params =
      body?.params && typeof body.params === 'object'
        ? (body.params as Record<string, unknown>)
        : undefined;
    const activeRequest: ActiveMcpRequest = {
      requestId: randomUUID(),
      method: typeof body?.method === 'string' ? body.method : request.method,
      toolName: typeof params?.name === 'string' ? params.name : null,
      jsonRpcId: typeof body?.id === 'string' || typeof body?.id === 'number' ? body.id : null,
      endpoint: metadata.endpoint,
      transport: metadata.transport,
      sessionId: metadata.sessionId ?? null,
      clientInfo: getMcpClientInfo(body),
      remoteAddress: request.ip,
      userAgent: getHeaderValue(request.headers['user-agent']),
      startedAt: new Date().toISOString(),
      cancelRequestedAt: null,
      cancel: () => {
        if (reply.raw.writableEnded || activeRequest.cancelRequestedAt) return false;
        activeRequest.cancelRequestedAt = new Date().toISOString();
        // Closing the HTTP response propagates to the MCP transport's
        // AbortSignal, which then cancels the browser tool execution.
        if (!reply.raw.destroyed) reply.raw.destroy();
        return true;
      },
    };
    const cancelOnDisconnect = () => {
      if (request.raw.aborted || !reply.raw.writableEnded) activeRequest.cancel();
    };
    request.raw.once('aborted', cancelOnDisconnect);
    reply.raw.once('close', cancelOnDisconnect);
    this.mcpRequests.set(activeRequest.requestId, activeRequest);
    this.runtimeRegistry.start({
      taskId: activeRequest.requestId,
      kind: 'mcp',
      label: activeRequest.toolName || activeRequest.method,
      clientName: activeRequest.clientInfo?.name,
      sessionId: activeRequest.sessionId,
      toolName: activeRequest.toolName,
      origin: request.headers.origin,
      cancelable: true,
      pausable: false,
    });
    return activeRequest;
  }

  private activeMcpRequestSnapshots(): Array<Record<string, unknown>> {
    return [...this.mcpRequests.values()].map((activeRequest) => ({
      requestId: activeRequest.requestId,
      method: activeRequest.method,
      toolName: activeRequest.toolName,
      endpoint: activeRequest.endpoint,
      transport: activeRequest.transport,
      sessionId: activeRequest.sessionId ?? null,
      jsonRpcId: activeRequest.jsonRpcId,
      clientInfo: activeRequest.clientInfo,
      remoteAddress: activeRequest.remoteAddress,
      userAgent: activeRequest.userAgent,
      startedAt: activeRequest.startedAt,
      elapsedMs: Math.max(0, Date.now() - new Date(activeRequest.startedAt).getTime()),
      status: 'running' as const,
      cancelRequestedAt: activeRequest.cancelRequestedAt,
      error: null,
    }));
  }

  private mcpRequestSnapshot(
    activeRequest: ActiveMcpRequest,
    status: McpRequestStatus,
    error: string | null = null,
  ): McpRequestRecord {
    return {
      requestId: activeRequest.requestId,
      method: activeRequest.method,
      toolName: activeRequest.toolName,
      jsonRpcId: activeRequest.jsonRpcId,
      endpoint: activeRequest.endpoint ?? '/mcp',
      transport: activeRequest.transport ?? 'streamable-http',
      sessionId: activeRequest.sessionId ?? null,
      clientInfo: activeRequest.clientInfo,
      remoteAddress: activeRequest.remoteAddress,
      userAgent: activeRequest.userAgent,
      startedAt: activeRequest.startedAt,
      elapsedMs: Math.max(0, Date.now() - new Date(activeRequest.startedAt).getTime()),
      status,
      cancelRequestedAt: activeRequest.cancelRequestedAt,
      error,
    };
  }

  private finishMcpRequest(
    activeRequest: ActiveMcpRequest,
    status: Exclude<McpRequestStatus, 'running'>,
    error: string | null = null,
  ): void {
    this.mcpRequests.delete(activeRequest.requestId);
    const finalStatus = activeRequest.cancelRequestedAt ? 'cancelled' : status;
    this.runtimeRegistry.finish(
      activeRequest.requestId,
      finalStatus === 'success' ? 'success' : finalStatus === 'cancelled' ? 'cancelled' : 'error',
      error ?? undefined,
    );

    // Successful protocol housekeeping (initialize, tools/list and notifications)
    // is intentionally omitted; the history is for useful tool/error diagnostics.
    if (finalStatus !== 'success' || activeRequest.method === 'tools/call') {
      this.recentMcpRequests.unshift(this.mcpRequestSnapshot(activeRequest, finalStatus, error));
      if (this.recentMcpRequests.length > RECENT_MCP_REQUEST_LIMIT) {
        this.recentMcpRequests.length = RECENT_MCP_REQUEST_LIMIT;
      }
    }
  }

  private statusForMcpError(
    activeRequest: ActiveMcpRequest,
    error: unknown,
  ): Exclude<McpRequestStatus, 'running' | 'success'> {
    const message = error instanceof Error ? error.message : String(error);
    return activeRequest.cancelRequestedAt || /abort|cancel/i.test(message) ? 'cancelled' : 'error';
  }

  private async cleanupStaleSessions(): Promise<void> {
    const now = Date.now();
    for (const [sessionId, session] of this.transportsMap) {
      if (session.activeRequests || now - session.lastActivityAt.getTime() < SESSION_TTL_MS)
        continue;
      this.transportsMap.delete(sessionId);
      this.reclaimedSessions++;
      await session.transport.close().catch(() => undefined);
    }
  }

  // ============================================================
  // Extension Routes
  // ============================================================

  private setupExtensionRoutes(): void {
    this.fastify.get('/artifacts/:artifactId', async (request, reply) => {
      const artifactId = (request.params as { artifactId?: string }).artifactId;
      const stored = artifactId ? this.nativeHost?.getArtifactStore().get(artifactId) : undefined;
      if (!stored) return reply.status(HTTP_STATUS.NOT_FOUND).send({ error: 'Artifact not found' });
      reply.header('Cache-Control', 'private, max-age=3600');
      reply.header('Content-Length', String(stored.metadata.size));
      reply.type(stored.metadata.contentType);
      return reply.send(createReadStream(stored.filePath));
    });

    this.fastify.get(
      '/ask-extension',
      async (request: FastifyRequest<{ Body: ExtensionRequestPayload }>, reply: FastifyReply) => {
        if (!this.nativeHost) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.NATIVE_HOST_NOT_AVAILABLE });
        }
        if (!this.isRunning) {
          return reply
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.SERVER_NOT_RUNNING });
        }

        const requestController = createHttpAbortController(request, reply);
        try {
          const extensionResponse = await this.nativeHost.sendRequestToExtensionAndWait(
            request.query,
            'process_data',
            TIMEOUTS.EXTENSION_REQUEST_TIMEOUT,
            requestController.signal,
          );
          return reply.status(HTTP_STATUS.OK).send({ status: 'success', data: extensionResponse });
        } catch (error: unknown) {
          const err = error as Error;
          if (err.message.includes('timed out')) {
            return reply
              .status(HTTP_STATUS.GATEWAY_TIMEOUT)
              .send({ status: 'error', message: ERROR_MESSAGES.REQUEST_TIMEOUT });
          } else {
            return reply.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).send({
              status: 'error',
              message: `Failed to get response from extension: ${err.message}`,
            });
          }
        }
      },
    );
  }

  // ============================================================
  // MCP Routes
  // ============================================================

  private setupMcpRoutes(): void {
    // SSE endpoint
    this.fastify.get('/sse', async (request, reply) => {
      try {
        reply.raw.writeHead(HTTP_STATUS.OK, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const transport = new SSEServerTransport('/messages', reply.raw);
        this.addSession(transport.sessionId, transport, {
          transportType: 'sse',
          endpoint: '/sse',
          remoteAddress: request.ip,
          userAgent: getHeaderValue(request.headers['user-agent']),
        });

        reply.raw.on('close', () => {
          this.transportsMap.delete(transport.sessionId);
        });

        const server = getLegacyMcpServer();
        await server.connect(transport);

        reply.raw.write(':\n\n');
      } catch (error) {
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      }
    });

    // SSE messages endpoint
    this.fastify.post('/messages', async (req, reply) => {
      const { sessionId } = req.query as { sessionId?: string };
      const activeRequest = this.trackMcpRequest(req, reply, {
        endpoint: '/sse',
        transport: 'sse',
        sessionId: sessionId || null,
      });
      let requestStatus: Exclude<McpRequestStatus, 'running'> = 'success';
      let requestError: string | null = null;
      let session: McpSession | undefined;
      try {
        session = this.transportsMap.get(sessionId || '');
        const transport = session?.transport as SSEServerTransport | undefined;
        if (!sessionId || !session || !transport) {
          requestStatus = 'error';
          requestError = 'No transport found for sessionId';
          reply.code(HTTP_STATUS.BAD_REQUEST).send('No transport found for sessionId');
          return;
        }

        session.lastActivityAt = new Date();
        session.clientInfo = getMcpClientInfo(req.body) ?? session.clientInfo;
        session.activeRequests++;
        const startedAt = Date.now();
        try {
          await transport.handlePostMessage(req.raw, reply.raw, req.body);
        } catch (error) {
          requestStatus = this.statusForMcpError(activeRequest, error);
          requestError = error instanceof Error ? error.message : String(error);
          session.errorCount++;
          session.lastError = requestError;
          throw error;
        } finally {
          session.activeRequests--;
          this.recordRequestLatency(session, startedAt);
        }
      } catch (error) {
        requestStatus = this.statusForMcpError(activeRequest, error);
        requestError ??= error instanceof Error ? error.message : String(error);
        if (!reply.sent) {
          reply.code(HTTP_STATUS.INTERNAL_SERVER_ERROR).send(ERROR_MESSAGES.INTERNAL_SERVER_ERROR);
        }
      } finally {
        this.finishMcpRequest(activeRequest, requestStatus, requestError);
      }
    });

    // Existing stateful Streamable HTTP endpoint.
    this.fastify.post('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const activeRequest = this.trackMcpRequest(request, reply, {
        endpoint: '/mcp',
        transport: request.headers.origin === STDIO_MCP_ORIGIN ? 'stdio' : 'streamable-http',
        sessionId: sessionId || null,
      });
      let requestStatus: Exclude<McpRequestStatus, 'running'> = 'success';
      let requestError: string | null = null;
      let session = this.transportsMap.get(sessionId || '');
      let transport: StreamableHTTPServerTransport | undefined = session?.transport as
        StreamableHTTPServerTransport | undefined;
      const clientInfo = getMcpClientInfo(request.body);

      const startedAt = Date.now();
      let trackedSession = false;
      try {
        if (transport) {
          // Transport found, proceed
        } else if (!sessionId && isInitializeRequest(request.body)) {
          const newSessionId = randomUUID();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => newSessionId,
            onsessioninitialized: (initializedSessionId) => {
              if (transport && initializedSessionId === newSessionId) {
                this.addSession(initializedSessionId, transport, {
                  // The stdio proxy marks its internal HTTP hop with this origin.
                  transportType:
                    request.headers.origin === STDIO_MCP_ORIGIN ? 'stdio' : 'streamable-http',
                  endpoint: '/mcp',
                  clientInfo,
                  remoteAddress: request.ip,
                  userAgent: getHeaderValue(request.headers['user-agent']),
                });
              }
            },
          });

          transport.onclose = () => {
            if (transport?.sessionId && this.transportsMap.get(transport.sessionId)) {
              this.transportsMap.delete(transport.sessionId);
            }
          };
          await getMcpServer().connect(transport);
        } else if (sessionId) {
          // The bridge restarted (or the session timed out), so transportsMap no
          // longer has this ID. 404 is the spec's signal for "discard the session
          // and send a fresh InitializeRequest"; 400 would read as a permanent
          // protocol error and strand the client until it reconnects by hand.
          requestStatus = 'error';
          requestError = ERROR_MESSAGES.UNKNOWN_SESSION_ID;
          reply.code(HTTP_STATUS.NOT_FOUND).send({ error: requestError });
          return;
        } else {
          requestStatus = 'error';
          requestError = ERROR_MESSAGES.INVALID_MCP_REQUEST;
          reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: requestError });
          return;
        }

        session = this.transportsMap.get(transport.sessionId || sessionId || '');
        trackedSession = Boolean(session);
        if (session) {
          session.clientInfo = clientInfo ?? session.clientInfo;
          session.lastActivityAt = new Date();
          session.activeRequests++;
          activeRequest.transport = session.transportType;
          activeRequest.sessionId = sessionId || transport.sessionId || null;
        }
        await transport.handleRequest(request.raw, reply.raw, request.body);
      } catch (error) {
        requestStatus = this.statusForMcpError(activeRequest, error);
        requestError = error instanceof Error ? error.message : String(error);
        if (session) {
          session.errorCount++;
          session.lastError = requestError;
        }
        if (!reply.sent) {
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_REQUEST_PROCESSING_ERROR });
        }
      } finally {
        if (trackedSession && session) session.activeRequests--;
        const currentSession =
          session ?? this.transportsMap.get(transport?.sessionId || sessionId || '');
        if (currentSession) this.recordRequestLatency(currentSession, startedAt);
        this.finishMcpRequest(activeRequest, requestStatus, requestError);
      }
    });

    // Existing Streamable HTTP SSE stream.
    this.fastify.get('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? this.transportsMap.get(sessionId) : undefined;
      const transport = session?.transport as StreamableHTTPServerTransport | undefined;

      if (!transport) {
        // Same split as POST /mcp: a stale ID earns a 404 so the client re-initializes,
        // a missing ID is a malformed request.
        if (sessionId) {
          reply.code(HTTP_STATUS.NOT_FOUND).send({ error: ERROR_MESSAGES.UNKNOWN_SESSION_ID });
        } else {
          reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SSE_SESSION });
        }
        return;
      }

      try {
        if (session) session.lastActivityAt = new Date();
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.hijack();
        }
      } catch (error) {
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }

      request.socket.on('close', () => {
        request.log.info(`SSE client disconnected for session: ${sessionId}`);
      });
    });

    // Existing Streamable HTTP session deletion.
    this.fastify.delete('/mcp', async (request, reply) => {
      const sessionId = request.headers['mcp-session-id'] as string | undefined;
      const session = sessionId ? this.transportsMap.get(sessionId) : undefined;
      const transport = session?.transport as StreamableHTTPServerTransport | undefined;

      if (!transport) {
        // DELETE of an already-gone session is not an error worth distinguishing for
        // the client, but 404 keeps the semantics consistent with POST and GET.
        if (sessionId) {
          reply.code(HTTP_STATUS.NOT_FOUND).send({ error: ERROR_MESSAGES.UNKNOWN_SESSION_ID });
        } else {
          reply.code(HTTP_STATUS.BAD_REQUEST).send({ error: ERROR_MESSAGES.INVALID_SESSION_ID });
        }
        return;
      }

      try {
        await transport.handleRequest(request.raw, reply.raw);
        if (!reply.sent) {
          reply.code(HTTP_STATUS.NO_CONTENT).send();
        }
      } catch (error) {
        if (!reply.sent) {
          reply
            .code(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .send({ error: ERROR_MESSAGES.MCP_SESSION_DELETION_ERROR });
        }
      }
    });

    // Streamable HTTP (preview) handles POST, GET and DELETE on one endpoint.
    this.fastify.all('/mcp-new', async (request, reply) => {
      const startedAt = Date.now();
      const activeRequest = this.trackMcpRequest(request, reply, {
        endpoint: '/mcp-new',
        transport: 'streamable-http',
      });
      let requestStatus: Exclude<McpRequestStatus, 'running'> = 'success';
      let requestError: string | null = null;
      const stats = this.statelessMcpStats;
      stats.activeRequests++;
      stats.requestCount++;
      stats.lastRequestAt = new Date();
      stats.clientInfo = getMcpClientInfo(request.body) ?? stats.clientInfo;
      stats.remoteAddress = request.ip;
      stats.userAgent = getHeaderValue(request.headers['user-agent']);
      try {
        await this.modernMcpNodeHandler(request.raw, reply.raw, request.body);
      } catch (error) {
        requestStatus = this.statusForMcpError(activeRequest, error);
        requestError = error instanceof Error ? error.message : String(error);
        stats.errorCount++;
        throw error;
      } finally {
        this.finishMcpRequest(activeRequest, requestStatus, requestError);
        stats.activeRequests--;
        stats.lastRequestLatencyMs = Math.max(0, Date.now() - startedAt);
      }
    });
  }

  // ============================================================
  // Server Lifecycle
  // ============================================================

  public async start(port = NATIVE_SERVER_PORT, nativeHost: NativeMessagingHost): Promise<void> {
    if (!this.nativeHost) {
      this.nativeHost = nativeHost;
    } else if (this.nativeHost !== nativeHost) {
      this.nativeHost = nativeHost;
    }

    if (this.isRunning) {
      await this.startService();
      return;
    }

    try {
      await this.fastify.listen({ port, host: SERVER_CONFIG.HOST });

      // Set port environment variables after successful listen for Chrome MCP URL resolution
      process.env.CHROME_MCP_PORT = String(port);
      process.env.MCP_HTTP_PORT = String(port);

      // Serve the event-channel upgrade here rather than on a private ephemeral port,
      // so a browser with no stub to tell it where to dial can use the port it knows.
      this.nativeHost?.getEventChannel().attachTo(this.fastify.server, port);

      this.isRunning = true;
      this.serviceEnabled = true;
      this.startedAt = Date.now();
      this.cleanupTimer = setInterval(() => void this.cleanupStaleSessions(), 60_000);
      this.cleanupTimer.unref();
    } catch (err) {
      this.isRunning = false;
      throw err;
    }
  }

  public async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    try {
      await this.stopService();
      if (this.cleanupTimer) clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      await this.fastify.close();
      this.isRunning = false;
      this.serviceEnabled = false;
    } catch (err) {
      this.isRunning = false;
      this.serviceEnabled = false;
      closeDb();
      throw err;
    }
  }

  public async startService(): Promise<void> {
    if (!this.isRunning) {
      throw new Error('The Chrome MCP Bridge control service has not started yet.');
    }
    this.serviceEnabled = true;
  }

  public async stopService(): Promise<void> {
    if (!this.isRunning) return;
    await browserProfileManager.stopAll();
    this.serviceEnabled = false;
    closeDb();
  }

  public getInstance(): FastifyInstance {
    return this.fastify;
  }
}

const serverInstance = new Server();
export default serverInstance;
