import { SerialPort } from 'serialport';

/**
 * Callback signatures used by the serial reader. Lines are emitted one at
 * a time, already trimmed; errors are logged via `onError`. The reader
 * automatically reopens the port when it errors, with a flat 2 s backoff
 * (the firmware sends data every 2 s, so a longer gap loses too much).
 */
export interface SerialReaderOptions {
  port: string;
  baud: number;
  onLine: (line: string) => void;
  onLog: (msg: string) => void;
  onAck?: (line: string) => void;
}

const REOPEN_BACKOFF_MS = 2_000;

/**
 * Newline-delimited JSON reader. The Mega firmware emits one JSON object
 * per `Serial.println(...)`, which always lands as `\n` (or `\r\n` on
 * some hosts) — both are handled. Partial frames at the end of a chunk
 * are buffered until the next read.
 */
export class SerialReader {
  private port: SerialPort | null = null;
  private buffer = '';
  private reopenTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly opts: SerialReaderOptions) {}

  start(): void {
    this.closed = false;
    this.open();
  }

  stop(): void {
    this.closed = true;
    if (this.reopenTimer) {
      clearTimeout(this.reopenTimer);
      this.reopenTimer = null;
    }
    if (this.port && this.port.isOpen) {
      try {
        this.port.close();
      } catch {
        /* ignore */
      }
    }
    this.port = null;
  }

  private open(): void {
    if (this.closed) return;
    this.opts.onLog(
      `[bridge] serial opening ${this.opts.port} @ ${this.opts.baud} baud`,
    );
    const port = new SerialPort({
      path: this.opts.port,
      baudRate: this.opts.baud,
      autoOpen: false,
    });
    this.port = port;

    port.open((err: Error | null) => {
      if (err) {
        this.opts.onLog(`[bridge] serial open failed: ${err.message}`);
        this.scheduleReopen();
        return;
      }
      this.opts.onLog(`[bridge] serial open`);
    });

    port.on('data', (chunk: Buffer) => this.feed(chunk));
    port.on('error', (err: Error) => {
      this.opts.onLog(`[bridge] serial error: ${err.message}`);
      // The 'close' event will fire next; trigger reopen there.
    });
    port.on('close', () => {
      this.opts.onLog(`[bridge] serial closed`);
      this.port = null;
      this.scheduleReopen();
    });
  }

  /** Write raw data to the serial port. Returns false if port is not open. */
  write(data: string): boolean {
    if (!this.port || !this.port.isOpen) return false;
    try {
      this.port.write(data);
      return true;
    } catch {
      return false;
    }
  }

  private feed(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl = this.buffer.indexOf('\n');
    while (nl !== -1) {
      const raw = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const line = raw.replace(/\r$/, '').trim();
      if (line.length > 0) {
        // If the line is an ACK from firmware, route to onAck callback
        if (line.startsWith('{"ack"') && this.opts.onAck) {
          this.opts.onAck(line);
        } else {
          this.opts.onLine(line);
        }
      }
      nl = this.buffer.indexOf('\n');
    }
    if (this.buffer.length > 16_384) this.buffer = '';
  }

  private scheduleReopen(): void {
    if (this.closed || this.reopenTimer) return;
    this.reopenTimer = setTimeout(() => {
      this.reopenTimer = null;
      this.open();
    }, REOPEN_BACKOFF_MS);
  }
}
