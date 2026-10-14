import { stdin, stdout } from 'process';
import { MAX_NATIVE_MESSAGE_SIZE_BYTES, NativeMessageFrameDecoder } from './native-frame.js';

export interface NativeTransportHandlers {
  onMessage(message: unknown): void;
  /** The peer is gone. The host rejects in-flight work; it does not retry. */
  onClose(): void;
  /** A framing or parse failure the host should report back over the channel. */
  onError(message: string): void;
}

export interface NativeTransport {
  readonly kind: 'stdio' | 'websocket' | 'null';
  /** Hard limit this transport can carry, checked by the host before serializing out. */
  readonly maxMessageBytes?: number;
  listen(handlers: NativeTransportHandlers): void;
  send(payload: string): Promise<void>;
}

/** Chrome-launched hosts: 4-byte little-endian length framing over stdin/stdout. */
export class StdioNativeTransport implements NativeTransport {
  readonly kind = 'stdio' as const;
  readonly maxMessageBytes = MAX_NATIVE_MESSAGE_SIZE_BYTES;

  listen(handlers: NativeTransportHandlers): void {
    const decoder = new NativeMessageFrameDecoder();

    const processAvailable = () => {
      try {
        for (const messageBuffer of decoder.readMessages()) {
          try {
            handlers.onMessage(JSON.parse(messageBuffer.toString()));
          } catch (error: any) {
            handlers.onError(`Failed to parse message: ${error.message}`);
          }
        }
      } catch (error: any) {
        handlers.onError(error.message);
      }

      // Continue on the next turn if a coalesced input contained more than the
      // per-read safety limit.
      if (decoder.hasCompleteMessage()) setImmediate(processAvailable);
    };

    stdin.on('readable', () => {
      let chunk;
      while ((chunk = stdin.read()) !== null) {
        decoder.append(chunk);
        processAvailable();
      }
    });
    stdin.on('end', () => handlers.onClose());
    stdin.on('error', () => handlers.onClose());
  }

  send(payload: string): Promise<void> {
    const messageBuffer = Buffer.from(payload);
    const headerBuffer = Buffer.alloc(4);
    headerBuffer.writeUInt32LE(messageBuffer.length, 0);
    const frame = Buffer.concat([headerBuffer, messageBuffer]);
    return new Promise((resolve, reject) => {
      stdout.write(frame, (error) => (error ? reject(error) : resolve()));
    });
  }
}

/**
 * One extension socket on the shared WS server. Inbound frames are pushed in by the
 * registry, which owns the listener; outbound ones go through the supplied writer.
 */
export class WebSocketNativeTransport implements NativeTransport {
  readonly kind = 'websocket' as const;
  private handlers: NativeTransportHandlers | null = null;

  constructor(private readonly write: (payload: string) => boolean) {}

  listen(handlers: NativeTransportHandlers): void {
    this.handlers = handlers;
  }

  send(payload: string): Promise<void> {
    return this.write(payload)
      ? Promise.resolve()
      : Promise.reject(new Error('Extension socket is not writable'));
  }

  accept(message: unknown): void {
    this.handlers?.onMessage(message);
  }

  disconnected(): void {
    this.handlers?.onClose();
  }
}

/**
 * A server started by hand or by an MCP client's stdio proxy has no native peer: stdin
 * belongs to someone else and writing to stdout would corrupt their stream.
 */
export class NullNativeTransport implements NativeTransport {
  readonly kind = 'null' as const;

  listen(): void {
    // Nothing will ever arrive.
  }

  send(): Promise<void> {
    return Promise.resolve();
  }
}
