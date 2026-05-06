import WebSocket from 'ws';

/**
 * Shape of a parsed Mega telemetry line. The Mega firmware emits a flat
 * JSON object once every 2 s; the only required key for the backend is
 * `deviceId`, the rest are merged with the device's last known state.
 */
export interface BridgePayload {
  deviceId: string;
  humidity?: number;
  temperature?: number;
  gas?: number;
  fanOn?: boolean;
  humidifierOn?: boolean;
  alarmOn?: boolean;
  uptime?: number;
}

/**
 * Auto-reconnecting WebSocket client. Wraps the bare `ws` socket so the
 * caller can fire-and-forget `send()` even before the connection is up
 * (the message is dropped — bridge readings tick every 2 s, so missing
 * one during reconnect is fine and far simpler than queueing).
 *
 * Reconnect backoff is a flat 5 s as per spec.
 */
export class WsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private readonly backoffMs = 5_000;

  constructor(
    private readonly url: string,
    private readonly onLog: (msg: string) => void,
  ) {}

  start(): void {
    this.closed = false;
    this.connect();
  }

  /** Permanently stop trying to reconnect and tear down the current socket. */
  stop(): void {
    this.closed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      this.socket = null;
    }
  }

  /** Send an `ingest` envelope. Drops the message if the socket isn't open. */
  sendIngest(payload: BridgePayload): boolean {
    const sock = this.socket;
    if (!sock || sock.readyState !== WebSocket.OPEN) return false;
    try {
      sock.send(JSON.stringify({ type: 'ingest', payload }));
      return true;
    } catch (err) {
      this.onLog(`[bridge] send failed: ${(err as Error).message}`);
      return false;
    }
  }

  private connect(): void {
    if (this.closed) return;
    this.onLog(`[bridge] ws connecting → ${this.url}`);
    const sock = new WebSocket(this.url);
    this.socket = sock;

    sock.on('open', () => {
      this.onLog(`[bridge] ws open`);
    });
    sock.on('close', (code: number) => {
      this.onLog(`[bridge] ws closed (${code}) — retry in ${this.backoffMs / 1000}s`);
      this.socket = null;
      this.scheduleReconnect();
    });
    sock.on('error', (err: Error) => {
      this.onLog(`[bridge] ws error: ${err.message}`);
      // Let the 'close' event drive the reconnect — `ws` always fires
      // close after error, so doing it twice would double the backoff.
    });
    // We don't currently react to inbound messages; the backend may send
    // welcome / pong / ingest-error envelopes. Surface ingest-errors so
    // misconfigured deviceIds are obvious during dev.
    sock.on('message', (raw: WebSocket.RawData) => {
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (
          parsed &&
          typeof parsed === 'object' &&
          'topic' in parsed &&
          (parsed as { topic: unknown }).topic === 'ingest-error'
        ) {
          this.onLog(`[bridge] backend rejected ingest: ${JSON.stringify((parsed as unknown as { payload: unknown }).payload)}`);
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.backoffMs);
  }
}
