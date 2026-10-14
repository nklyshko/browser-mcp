import { afterEach, describe, expect, test } from '@jest/globals';
import { LocalEventWebSocketServer } from './event-websocket-server.js';
import { NativeMessagingHost } from './native-messaging-host.js';
import {
  NullNativeTransport,
  WebSocketNativeTransport,
  type NativeTransportHandlers,
} from './native-transport.js';

/**
 * The channel is injected, exactly as the registry does it: a socket-backed host is
 * already on the shared channel, so it must not bind one of its own.
 */
const sharedChannel = new LocalEventWebSocketServer();
const created: NativeMessagingHost[] = [];

afterEach(async () => {
  for (const host of created.splice(0)) host.getArtifactStore().dispose();
  await sharedChannel.stop();
});

function wsHost(sent: string[], writable = { value: true }) {
  const transport = new WebSocketNativeTransport((payload) => {
    if (!writable.value) return false;
    sent.push(payload);
    return true;
  });
  const host = new NativeMessagingHost({
    transport,
    eventChannel: sharedChannel,
    exitProcessOnClose: false,
  });
  created.push(host);
  host.listen();
  return { host, transport };
}

/** Puts the host in the connected state the same way a real hello would. */
function connect(host: NativeMessagingHost, transport: WebSocketNativeTransport) {
  transport.accept({
    version: 2,
    type: 'hello',
    traceId: 'trace-hello',
    role: 'extension-background',
    agent: { name: 'test', version: '2' },
    supportedVersions: [2],
  });
}

describe('transport seam', () => {
  test('a websocket host answers over its own socket', async () => {
    const sent: string[] = [];
    const { host, transport } = wsHost(sent);

    connect(host, transport);
    await new Promise((resolve) => setImmediate(resolve));

    expect(transport.kind).toBe('websocket');
    expect(sent.length).toBeGreaterThan(0);
    expect(JSON.parse(sent[0])).toMatchObject({ type: 'hello', selectedVersion: 2 });
  });

  test('two hosts keep their own pending requests and status', async () => {
    const sentA: string[] = [];
    const sentB: string[] = [];
    const a = wsHost(sentA);
    const b = wsHost(sentB);
    connect(a.host, a.transport);
    connect(b.host, b.transport);

    const pendingA = a.host.sendRequestToExtensionAndWait({}, 'call_tool', 5_000);
    expect(a.host.getStatus().pendingRequests).toBe(1);
    expect(b.host.getStatus().pendingRequests).toBe(0);

    // Answering on B must not settle A's request.
    const requestId = JSON.parse(sentA[sentA.length - 1]).requestId;
    b.transport.accept({
      version: 2,
      type: 'response',
      requestId,
      traceId: 'wrong',
      ok: true,
      result: {},
    });
    expect(a.host.getStatus().pendingRequests).toBe(1);

    a.host.dispose('closed');
    await expect(pendingA).rejects.toMatchObject({ code: 'NATIVE_DISCONNECTED' });
  });

  test('a closing socket rejects in-flight work without exiting the process', async () => {
    const sent: string[] = [];
    const { host, transport } = wsHost(sent);
    connect(host, transport);

    const inflight = host.sendRequestToExtensionAndWait(
      { name: 'chrome_click_element' },
      'call_tool',
      5_000,
    );
    transport.disconnected();

    // EXECUTION_UNKNOWN, not CANCELED: the click may well have happened.
    await expect(inflight).rejects.toMatchObject({ code: 'EXECUTION_UNKNOWN' });
    // Reaching this line at all is the assertion: a process.exit here would have
    // killed the run. Mocking process.exit instead wedges jest's own teardown.
    expect(host.getStatus().pendingRequests).toBe(0);
    expect(host.isExtensionConnected()).toBe(false);
  });

  test('a null transport swallows sends so a standalone server cannot corrupt stdout', async () => {
    const transport = new NullNativeTransport();
    const host = new NativeMessagingHost({
      transport,
      eventChannel: sharedChannel,
      exitProcessOnClose: false,
    });
    created.push(host);

    host.sendMessage({ version: 2, type: 'event', event: 'native.error' });
    await new Promise((resolve) => setImmediate(resolve));

    // No limit to breach and nowhere to write: the send simply resolves.
    expect(transport.maxMessageBytes).toBeUndefined();
    expect(host.getStatus().lastError).toBeNull();
  });

  test('an unwritable socket fails the send and records why', async () => {
    const sent: string[] = [];
    const writable = { value: true };
    const { host, transport } = wsHost(sent, writable);
    connect(host, transport);
    writable.value = false;

    await expect(host.sendRequestToExtensionAndWait({}, 'call_tool', 5_000)).rejects.toMatchObject({
      message: expect.stringContaining('not writable'),
    });
  });
});
