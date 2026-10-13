import { describe, expect, test, afterAll, beforeAll, jest } from '@jest/globals';
import supertest from 'supertest';
import Server from './index';
import { ERROR_MESSAGES, isAllowedCorsOrigin, MCP_API_KEY_ENV } from '../constant';
import nativeMessagingHostInstance from '../native-messaging-host';

function parseMcpResponse(response: { body?: any; text?: string }): any {
  if (response.body?.jsonrpc) return response.body;
  const dataLine = response.text?.split(/\r?\n/).find((line) => line.startsWith('data:'));
  if (!dataLine) throw new Error('MCP response did not contain a JSON body');
  return JSON.parse(dataLine.slice('data:'.length).trim());
}

describe('server', () => {
  // Bring up a test instance of the server
  beforeAll(async () => {
    await Server.getInstance().ready();
  });

  // Shut the server down
  afterAll(async () => {
    await Server.stop();
  });

  test('GET /ping returns the expected response', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/ping')
      .expect(200)
      .expect('Content-Type', /json/);

    expect(response.body).toEqual({
      status: 'ok',
      message: 'pong',
    });
  });

  test('GET /status returns a diagnosable status', async () => {
    const response = await supertest(Server.getInstance().server)
      .get('/status')
      .set('Origin', 'http://127.0.0.1:1420')
      .expect(200);

    expect(response.body.server.version).toEqual(expect.any(String));
    expect(response.body.server.protocolVersion).toBe(2);
    expect(response.body.packages).toEqual({
      'mcp-chrome-bridge-2026': response.body.server.version,
    });
    expect(response.body.mcp).toMatchObject({
      activeSessions: 0,
      streamableHttp: true,
      recentRequests: expect.any(Array),
    });
    expect(response.body.tools.count).toBeGreaterThan(0);
    expect(response.body.toolAdmission).toMatchObject({
      active: 0,
      queued: 0,
      maxActive: expect.any(Number),
      maxQueued: expect.any(Number),
    });
    expect(response.body).toEqual(
      expect.objectContaining({
        connectionState: expect.any(String),
        pendingRequests: expect.any(Number),
        activeTools: expect.any(Number),
        queuedTools: expect.any(Number),
        reconnectCount: expect.any(Number),
        timeoutCount: expect.any(Number),
        cancelCount: expect.any(Number),
        queueRejectCount: expect.any(Number),
      }),
    );
  });

  test('the compatibility Streamable HTTP endpoint preserves the session lifecycle', async () => {
    Server.serviceEnabled = true;
    let sessionId: string | undefined;
    try {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'http://127.0.0.1:1420')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'legacy-test-client', version: '1.0.0' },
          },
        })
        .expect(200);

      sessionId = response.headers['mcp-session-id'];
      expect(sessionId).toEqual(expect.any(String));
      const status = await supertest(Server.getInstance().server)
        .get('/status')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);
      expect(status.body.mcp.clients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, transport: 'streamable-http', endpoint: '/mcp' }),
        ]),
      );
    } finally {
      if (sessionId) {
        await supertest(Server.getInstance().server)
          .delete('/mcp')
          .set('Origin', 'http://127.0.0.1:1420')
          .set('Mcp-Session-Id', sessionId);
      }
      Server.serviceEnabled = false;
    }
  });

  test('MCP initialize → tools/list → tools/call forwards a browser result', async () => {
    Server.serviceEnabled = true;
    const connected = jest
      .spyOn(nativeMessagingHostInstance, 'isExtensionConnected')
      .mockReturnValue(true);
    const sendToExtension = jest
      .spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait')
      .mockResolvedValue({
        status: 'success',
        data: {
          content: [
            { type: 'text', text: JSON.stringify({ tabId: 17, url: 'https://example.com' }) },
          ],
          isError: false,
        },
      } as any);
    let sessionId: string | undefined;

    try {
      const initialized = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'http://127.0.0.1:1420')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'integration-test-client', version: '1.0.0' },
          },
        })
        .expect(200);
      sessionId = initialized.headers['mcp-session-id'];
      expect(sessionId).toEqual(expect.any(String));

      await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'http://127.0.0.1:1420')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId!)
        .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        .expect(202);

      const listed = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'http://127.0.0.1:1420')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId!)
        .send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
        .expect(200);
      expect(parseMcpResponse(listed).result.tools).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'chrome_get_tab_url' })]),
      );

      const called = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'http://127.0.0.1:1420')
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId!)
        .send({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'chrome_get_tab_url', arguments: { tabId: 17 } },
        })
        .expect(200);

      expect(parseMcpResponse(called).result).toMatchObject({
        content: [
          { type: 'text', text: JSON.stringify({ tabId: 17, url: 'https://example.com' }) },
        ],
        isError: false,
      });
      expect(sendToExtension).toHaveBeenLastCalledWith(
        { name: 'chrome_get_tab_url', args: { tabId: 17 } },
        'call_tool',
        expect.any(Number),
        expect.any(AbortSignal),
        undefined,
        expect.any(String),
      );
    } finally {
      if (sessionId) {
        await supertest(Server.getInstance().server)
          .delete('/mcp')
          .set('Origin', 'http://127.0.0.1:1420')
          .set('Mcp-Session-Id', sessionId);
      }
      connected.mockRestore();
      sendToExtension.mockRestore();
      Server.serviceEnabled = false;
    }
  });

  test('marks the STDIO proxy as a STDIO connection', async () => {
    Server.serviceEnabled = true;
    let sessionId: string | undefined;
    try {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'chrome-extension://mcp-stdio')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'stdio-test-client', version: '1.0.0' },
          },
        })
        .expect(200);

      sessionId = response.headers['mcp-session-id'];
      const status = await supertest(Server.getInstance().server)
        .get('/status')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);
      expect(status.body.mcp.clients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sessionId, transport: 'stdio', endpoint: '/mcp' }),
        ]),
      );
    } finally {
      if (sessionId) {
        await supertest(Server.getInstance().server)
          .delete('/mcp')
          .set('Origin', 'chrome-extension://mcp-stdio')
          .set('Mcp-Session-Id', sessionId);
      }
      Server.serviceEnabled = false;
    }
  });

  test('the preview Streamable HTTP endpoint returns the tool list for a sessionless request', async () => {
    Server.serviceEnabled = true;
    try {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp-new')
        .set('Origin', 'http://127.0.0.1:1420')
        .set('MCP-Protocol-Version', '2026-07-28')
        .set('Mcp-Method', 'tools/list')
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {
            _meta: {
              'io.modelcontextprotocol/protocolVersion': '2026-07-28',
              'io.modelcontextprotocol/clientCapabilities': {},
              'io.modelcontextprotocol/clientInfo': {
                name: 'desktop-test-client',
                version: '1.2.3',
              },
            },
          },
        })
        .expect(200);

      expect(response.headers['mcp-session-id']).toBeUndefined();
      expect(response.body.jsonrpc).toBe('2.0');
      expect(response.body.result.tools.length).toBeGreaterThan(0);

      const status = await supertest(Server.getInstance().server)
        .get('/status')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);
      expect(status.body.mcp.activeSessions).toBe(0);
      expect(status.body.mcp.stateless).toMatchObject({
        endpoint: '/mcp-new',
        transport: 'streamable-http',
        requestCount: expect.any(Number),
        lastRequestAt: expect.any(String),
        lastRequestLatencyMs: expect.any(Number),
        clientInfo: { name: 'desktop-test-client', version: '1.2.3' },
      });
      expect(status.body.mcp.recentRequests).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ method: 'tools/list' })]),
      );
    } finally {
      Server.serviceEnabled = false;
    }
  });

  test('a sessionless in-flight request can be cancelled by ID', async () => {
    const server = Server as any;
    let cancelCalls = 0;
    server.statelessMcpRequests.set('request-under-test', {
      requestId: 'request-under-test',
      method: 'tools/call',
      toolName: 'chrome_wait',
      jsonRpcId: 42,
      clientInfo: null,
      remoteAddress: '127.0.0.1',
      userAgent: 'test',
      startedAt: new Date().toISOString(),
      cancelRequestedAt: null,
      cancel: () => {
        cancelCalls++;
        return true;
      },
    });
    try {
      const status = await supertest(Server.getInstance().server)
        .get('/status')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);
      expect(status.body.mcp.stateless.requests).toEqual([
        expect.objectContaining({
          requestId: 'request-under-test',
          method: 'tools/call',
          toolName: 'chrome_wait',
          jsonRpcId: 42,
        }),
      ]);
      expect(status.body.mcp.requests).toEqual([
        expect.objectContaining({ requestId: 'request-under-test', status: 'running' }),
      ]);

      await supertest(Server.getInstance().server)
        .post('/__chrome_mcp_bridge/mcp-new/requests/request-under-test/cancel')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(202)
        .expect({ status: 'cancel_requested', requestId: 'request-under-test' });
      expect(cancelCalls).toBe(1);
    } finally {
      server.statelessMcpRequests.delete('request-under-test');
    }
  });

  test('a finished MCP request enters the recent history, which keeps 20 entries', () => {
    const server = Server as any;
    const previousHistory = [...server.recentMcpRequests];
    const previousActive = new Map(server.mcpRequests);
    const makeRequest = (requestId: string, method = 'tools/call') => ({
      requestId,
      method,
      toolName: method === 'tools/call' ? 'chrome_wait' : null,
      jsonRpcId: 1,
      endpoint: requestId.startsWith('new-') ? '/mcp-new' : '/mcp',
      transport: requestId.startsWith('stdio-') ? 'stdio' : 'streamable-http',
      sessionId: null,
      clientInfo: null,
      remoteAddress: '127.0.0.1',
      userAgent: 'test',
      startedAt: new Date().toISOString(),
      cancelRequestedAt: null,
      cancel: () => true,
    });

    try {
      server.recentMcpRequests.length = 0;
      server.mcpRequests.clear();

      const housekeeping = makeRequest('housekeeping', 'tools/list');
      server.mcpRequests.set(housekeeping.requestId, housekeeping);
      server.finishMcpRequest(housekeeping, 'success');
      expect(server.recentMcpRequests).toHaveLength(0);

      const failedProtocolRequest = makeRequest('failed-protocol', 'tools/list');
      server.mcpRequests.set(failedProtocolRequest.requestId, failedProtocolRequest);
      server.finishMcpRequest(failedProtocolRequest, 'error', 'invalid request');

      const cancelledRequest = makeRequest('stdio-cancelled');
      server.mcpRequests.set(cancelledRequest.requestId, cancelledRequest);
      server.finishMcpRequest(cancelledRequest, 'cancelled');

      expect(server.recentMcpRequests).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: 'failed-protocol',
            endpoint: '/mcp',
            transport: 'streamable-http',
            status: 'error',
            error: 'invalid request',
          }),
          expect.objectContaining({ requestId: 'stdio-cancelled', status: 'cancelled' }),
        ]),
      );

      for (let index = 0; index < 22; index++) {
        const request = makeRequest(`new-${index}`);
        server.mcpRequests.set(request.requestId, request);
        server.finishMcpRequest(request, 'success');
      }

      expect(server.recentMcpRequests).toHaveLength(20);
      expect(server.recentMcpRequests[0]).toMatchObject({
        requestId: 'new-21',
        endpoint: '/mcp-new',
        status: 'success',
      });
      expect(server.recentMcpRequests.at(-1)).toMatchObject({
        requestId: 'new-2',
        endpoint: '/mcp-new',
        status: 'success',
      });
      expect(server.recentMcpRequests).toEqual(
        expect.not.arrayContaining([expect.objectContaining({ requestId: 'housekeeping' })]),
      );
    } finally {
      server.recentMcpRequests.length = 0;
      server.recentMcpRequests.push(...previousHistory);
      server.mcpRequests.clear();
      for (const [requestId, request] of previousActive) server.mcpRequests.set(requestId, request);
    }
  });

  test('the compatibility endpoint records an invalid-protocol request as a failure', async () => {
    Server.serviceEnabled = true;
    try {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', 'http://127.0.0.1:1420')
        .send({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'chrome_wait' } })
        .expect(400);

      expect(response.body.error).toBe(ERROR_MESSAGES.INVALID_MCP_REQUEST);
      const status = await supertest(Server.getInstance().server)
        .get('/status')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);
      expect(status.body.mcp.recentRequests[0]).toMatchObject({
        method: 'tools/call',
        endpoint: '/mcp',
        transport: 'streamable-http',
        status: 'error',
        error: ERROR_MESSAGES.INVALID_MCP_REQUEST,
      });
    } finally {
      Server.serviceEnabled = false;
    }
  });

  test('stale session IDs return 404 so clients re-initialize', async () => {
    Server.serviceEnabled = true;
    const staleSessionId = '11111111-2222-3333-4444-555555555555';
    const origin = 'http://127.0.0.1:1420';
    try {
      const posted = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', origin)
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', staleSessionId)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
        .expect(404);
      expect(posted.body.error).toBe(ERROR_MESSAGES.UNKNOWN_SESSION_ID);

      const streamed = await supertest(Server.getInstance().server)
        .get('/mcp')
        .set('Origin', origin)
        .set('Mcp-Session-Id', staleSessionId)
        .expect(404);
      expect(streamed.body.error).toBe(ERROR_MESSAGES.UNKNOWN_SESSION_ID);

      const deleted = await supertest(Server.getInstance().server)
        .delete('/mcp')
        .set('Origin', origin)
        .set('Mcp-Session-Id', staleSessionId)
        .expect(404);
      expect(deleted.body.error).toBe(ERROR_MESSAGES.UNKNOWN_SESSION_ID);

      // A wholly missing session ID stays a 400: it is a malformed request, not a
      // session the client could recover by re-initializing.
      const missing = await supertest(Server.getInstance().server)
        .delete('/mcp')
        .set('Origin', origin)
        .expect(400);
      expect(missing.body.error).toBe(ERROR_MESSAGES.INVALID_SESSION_ID);
    } finally {
      Server.serviceEnabled = false;
    }
  });

  test('concurrent sessions do not cross tool-call results', async () => {
    Server.serviceEnabled = true;
    const origin = 'http://127.0.0.1:1420';
    const connected = jest
      .spyOn(nativeMessagingHostInstance, 'isExtensionConnected')
      .mockReturnValue(true);
    // Echo the requested tabId back so each response is traceable to its caller.
    const sendToExtension = jest
      .spyOn(nativeMessagingHostInstance, 'sendRequestToExtensionAndWait')
      .mockImplementation(
        async (payload: any) =>
          ({
            status: 'success',
            data: {
              content: [{ type: 'text', text: JSON.stringify({ tabId: payload?.args?.tabId }) }],
              isError: false,
            },
          }) as any,
      );
    const sessionIds: string[] = [];

    const initialize = async (clientName: string): Promise<string> => {
      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', origin)
        .set('Accept', 'application/json, text/event-stream')
        .send({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: clientName, version: '1.0.0' },
          },
        })
        .expect(200);
      const sessionId = response.headers['mcp-session-id'];
      await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', origin)
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({ jsonrpc: '2.0', method: 'notifications/initialized' })
        .expect(202);
      return sessionId;
    };

    const callTool = (sessionId: string, tabId: number) =>
      supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Origin', origin)
        .set('Accept', 'application/json, text/event-stream')
        .set('Mcp-Session-Id', sessionId)
        .send({
          jsonrpc: '2.0',
          id: tabId,
          method: 'tools/call',
          params: { name: 'chrome_get_tab_url', arguments: { tabId } },
        })
        .expect(200);

    try {
      sessionIds.push(await initialize('concurrent-client-a'));
      sessionIds.push(await initialize('concurrent-client-b'));
      const [sessionA, sessionB] = sessionIds;
      expect(sessionA).toEqual(expect.any(String));
      expect(sessionB).toEqual(expect.any(String));
      expect(sessionA).not.toBe(sessionB);

      // Genuinely in flight at the same time: a shared transport would cross the
      // replies here, which is the regression this guards.
      const [firstA, firstB] = await Promise.all([callTool(sessionA, 11), callTool(sessionB, 22)]);
      expect(parseMcpResponse(firstA).result.content[0].text).toBe(JSON.stringify({ tabId: 11 }));
      expect(parseMcpResponse(firstB).result.content[0].text).toBe(JSON.stringify({ tabId: 22 }));

      // Session A still works after B has been active.
      const secondA = await callTool(sessionA, 33);
      expect(parseMcpResponse(secondA).result.content[0].text).toBe(JSON.stringify({ tabId: 33 }));

      const status = await supertest(Server.getInstance().server)
        .get('/status')
        .set('Origin', origin)
        .expect(200);
      expect(status.body.mcp.clients).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sessionId: sessionA,
            clientInfo: { name: 'concurrent-client-a', version: '1.0.0' },
          }),
          expect.objectContaining({
            sessionId: sessionB,
            clientInfo: { name: 'concurrent-client-b', version: '1.0.0' },
          }),
        ]),
      );
    } finally {
      for (const sessionId of sessionIds) {
        await supertest(Server.getInstance().server)
          .delete('/mcp')
          .set('Origin', origin)
          .set('Mcp-Session-Id', sessionId);
      }
      connected.mockRestore();
      sendToExtension.mockRestore();
      Server.serviceEnabled = false;
    }
  });

  test('a bridge driving a browser refuses to hand over its port', async () => {
    // The accept path calls process.exit(0), which would take the test runner with
    // it, so only the refusal branch is exercised here.
    const server = Server as any;
    const connected = jest
      .spyOn(nativeMessagingHostInstance, 'isExtensionConnected')
      .mockReturnValue(true);
    const wasRunning = server.isRunning;
    const previousNativeHost = server.nativeHost;
    // Tests never run the real entry point, so the server has no native host wired;
    // production sets it in index.ts before the HTTP server ever listens.
    server.nativeHost = nativeMessagingHostInstance;
    server.isRunning = true;
    server.takeoverRequested = false;
    try {
      const response = await supertest(Server.getInstance().server)
        .post('/__chrome_mcp_bridge/takeover')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(409);
      expect(response.body).toEqual({ status: 'busy_with_extension' });
      // Refusing must not begin a shutdown: that is what let two browsers trade
      // the port back and forth indefinitely.
      expect(server.takeoverRequested).toBe(false);
    } finally {
      server.isRunning = wasRunning;
      server.nativeHost = previousNativeHost;
      server.takeoverRequested = false;
      connected.mockRestore();
    }
  });

  test('takeover rejects a cross-origin caller so a web page cannot stop the bridge', async () => {
    // Unprotected, any page could POST here and trigger process.exit(0). A browser
    // forces the Origin header on a cross-origin request, so the check is what
    // actually stops a drive-by page.
    const response = await supertest(Server.getInstance().server)
      .post('/__chrome_mcp_bridge/takeover')
      .set('Origin', 'https://evil.example')
      .expect(403);
    expect(response.body.error).toBe(ERROR_MESSAGES.ORIGIN_NOT_ALLOWED);
  });

  test('takeover rejects a caller with neither Origin nor API key', async () => {
    await supertest(Server.getInstance().server).post('/__chrome_mcp_bridge/takeover').expect(403);
  });

  test('the agent settings accept a cross-origin PUT to save', async () => {
    const response = await supertest(Server.getInstance().server)
      .options('/agent/settings/deepseek')
      .set('Origin', 'chrome-extension://test')
      .set('Access-Control-Request-Method', 'PUT')
      .expect(204);

    expect(response.headers['access-control-allow-methods']).toContain('PUT');
  });

  test('CORS rejects a spoofed local Origin', () => {
    expect(isAllowedCorsOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedCorsOrigin('chrome-extension://test-extension')).toBe(true);
    expect(isAllowedCorsOrigin('http://127.0.0.1.evil.example')).toBe(false);
    expect(isAllowedCorsOrigin('https://127.0.0.1')).toBe(false);
  });

  test('MCP rejects a request with neither an Origin nor an API key', async () => {
    const previousKey = process.env[MCP_API_KEY_ENV];
    delete process.env[MCP_API_KEY_ENV];
    try {
      const response = await supertest(Server.getInstance().server).post('/mcp').send({});
      expect(response.status).toBe(403);
      expect(response.body.error).toBe(ERROR_MESSAGES.ORIGIN_NOT_ALLOWED);
    } finally {
      if (previousKey === undefined) delete process.env[MCP_API_KEY_ENV];
      else process.env[MCP_API_KEY_ENV] = previousKey;
    }
  });

  test('an MCP API key allows an Origin-less protected request and rejects a wrong key', async () => {
    const previousKey = process.env[MCP_API_KEY_ENV];
    process.env[MCP_API_KEY_ENV] = 'server-test-key';
    try {
      await supertest(Server.getInstance().server)
        .options('/mcp')
        .set('Origin', 'chrome-extension://test')
        .set('Access-Control-Request-Method', 'POST')
        .expect(204);

      await supertest(Server.getInstance().server)
        .post('/mcp')
        .send({})
        .expect(401)
        .expect((response) => {
          expect(response.body.error).toBe('Missing or invalid MCP API key.');
        });

      const response = await supertest(Server.getInstance().server)
        .post('/mcp')
        .set('Authorization', 'Bearer server-test-key')
        .send({});
      expect(response.status).not.toBe(401);
      expect(response.status).not.toBe(403);
    } finally {
      if (previousKey === undefined) delete process.env[MCP_API_KEY_ENV];
      else process.env[MCP_API_KEY_ENV] = previousKey;
    }
  });

  test('the private agent endpoints all honour Origin and API key auth', async () => {
    const previousKey = process.env[MCP_API_KEY_ENV];
    delete process.env[MCP_API_KEY_ENV];
    try {
      await supertest(Server.getInstance().server)
        .get('/agent/engines')
        .expect(403)
        .expect((response) => {
          expect(response.body.error).toBe(ERROR_MESSAGES.ORIGIN_NOT_ALLOWED);
        });

      await supertest(Server.getInstance().server)
        .get('/agent/engines')
        .set('Origin', 'https://evil.example')
        .expect(403)
        .expect((response) => {
          expect(response.body.error).toBe(ERROR_MESSAGES.ORIGIN_NOT_ALLOWED);
        });

      await supertest(Server.getInstance().server)
        .get('/agent/engines')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);

      process.env[MCP_API_KEY_ENV] = 'agent-test-key';
      await supertest(Server.getInstance().server).get('/agent/engines').expect(401);
      await supertest(Server.getInstance().server)
        .get('/agent/engines')
        .set('x-api-key', 'agent-test-key')
        .expect(200);
      await supertest(Server.getInstance().server)
        .get('/agent/engines')
        .set('Authorization', 'Bearer agent-test-key')
        .expect(200);
    } finally {
      if (previousKey === undefined) delete process.env[MCP_API_KEY_ENV];
      else process.env[MCP_API_KEY_ENV] = previousKey;
    }
  });

  test('the runtime control endpoint is protected and returns a redacted task list', async () => {
    const previousKey = process.env[MCP_API_KEY_ENV];
    delete process.env[MCP_API_KEY_ENV];
    try {
      await supertest(Server.getInstance().server).get('/__chrome_mcp_bridge/runtime').expect(403);
      const response = await supertest(Server.getInstance().server)
        .get('/__chrome_mcp_bridge/runtime')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(200);
      expect(response.body).toEqual(
        expect.objectContaining({ tasks: expect.any(Array), activeCount: expect.any(Number) }),
      );
      await supertest(Server.getInstance().server)
        .post('/__chrome_mcp_bridge/runtime/missing-task/cancel')
        .set('Origin', 'http://127.0.0.1:1420')
        .expect(404);
    } finally {
      if (previousKey === undefined) delete process.env[MCP_API_KEY_ENV];
      else process.env[MCP_API_KEY_ENV] = previousKey;
    }
  });
});
