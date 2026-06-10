import { DemoSource } from './demoSource.js';
import { SerialReader } from './serialReader.js';
import { WsClient, type BridgePayload } from './wsClient.js';

interface ParsedArgs {
  source: 'serial' | 'demo';
  port: string | undefined;
  baud: number;
  backend: string;
  device: string;
  help: boolean;
}

const HELP = `room-manager-bridge — pumps Mega 2560 telemetry into the backend WS

USAGE
  tsx src/index.ts [flags]

FLAGS
  --source <serial|demo>   data source (default: serial)
  --port <COM3|/dev/...>   serial device path (required for --source serial)
  --baud <number>          serial baud rate (default: 9600)
  --backend <ws-url>       backend WebSocket URL (default: ws://localhost:4000/ws)
  --device <id>            fallback deviceId for malformed lines (default: rm-living)
  --help, -h               show this message

EXAMPLES
  tsx src/index.ts --source demo --device rm-living
  tsx src/index.ts --source serial --port COM3 --baud 9600
  tsx src/index.ts --source serial --port /dev/ttyUSB0 --backend ws://10.0.0.5:4000/ws
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

/** Tiny argv parser — handles `--key value` and `--key=value` forms only. */
function parseArgs(argv: readonly string[]): ParsedArgs | { error: string } {
  const out: ParsedArgs = {
    source: 'serial',
    port: undefined,
    baud: 9600,
    backend: 'ws://localhost:4000/ws',
    device: 'rm-living',
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === undefined) continue;
    if (token === '--help' || token === '-h') {
      out.help = true;
      continue;
    }
    let key: string;
    let value: string | undefined;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      if (eq !== -1) {
        key = token.slice(2, eq);
        value = token.slice(eq + 1);
      } else {
        key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          value = next;
          i++;
        }
      }
    } else {
      return { error: `unexpected positional argument: ${token}` };
    }

    if (value === undefined) {
      return { error: `flag --${key} requires a value` };
    }

    switch (key) {
      case 'source':
        if (value !== 'serial' && value !== 'demo') {
          return { error: `--source must be 'serial' or 'demo' (got '${value}')` };
        }
        out.source = value;
        break;
      case 'port':
        out.port = value;
        break;
      case 'baud': {
        const n = Number(value);
        if (!Number.isFinite(n) || n <= 0) {
          return { error: `--baud must be a positive number (got '${value}')` };
        }
        out.baud = n;
        break;
      }
      case 'backend':
        out.backend = value;
        break;
      case 'device':
        out.device = value;
        break;
      default:
        return { error: `unknown flag --${key}` };
    }
  }

  if (out.source === 'serial' && !out.port) {
    return { error: '--port is required when --source serial' };
  }
  return out;
}

function nowStamp(): string {
  return new Date().toISOString();
}

function logLine(msg: string): void {
  process.stdout.write(`[${nowStamp()}] ${msg}\n`);
}

/**
 * Validate + reshape a JSON line into the backend's ingest payload. Pulls
 * the deviceId from the line if present, falls back to the CLI default.
 */
function parseLine(
  line: string,
  fallbackDeviceId: string,
): BridgePayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;
  const id = typeof obj.deviceId === 'string' && obj.deviceId.length > 0
    ? obj.deviceId
    : fallbackDeviceId;

  const num = (k: string): number | undefined => {
    const v = obj[k];
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  };
  const bool = (k: string): boolean | undefined => {
    const v = obj[k];
    return typeof v === 'boolean' ? v : undefined;
  };

  const out: BridgePayload = { deviceId: id };
  const humidity = num('humidity');
  if (humidity !== undefined) out.humidity = humidity;
  const temperature = num('temperature');
  if (temperature !== undefined) out.temperature = temperature;
  const gas = num('gas');
  if (gas !== undefined) out.gas = gas;
  else {
    // Mega firmware emits gasPct (0–100 %); backend expects gas in ppm-equivalent.
    // 30 % ≈ 300 ppm per firmware threshold comment, so scale ×10.
    const gasPct = num('gasPct');
    if (gasPct !== undefined) out.gas = gasPct * 10;
  }
  const fanOn = bool('fanOn');
  if (fanOn !== undefined) out.fanOn = fanOn;
  const humidifierOn = bool('humidifierOn');
  if (humidifierOn !== undefined) out.humidifierOn = humidifierOn;
  const alarmOn = bool('alarmOn');
  if (alarmOn !== undefined) out.alarmOn = alarmOn;
  const uptime = num('uptime');
  if (uptime !== undefined) out.uptime = uptime;

  return out;
}

function main(): void {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`error: ${parsed.error}\n\n`);
    printHelp();
    process.exit(2);
  }
  if (parsed.help) {
    printHelp();
    return;
  }

  logLine(
    `[bridge] starting — source=${parsed.source} backend=${parsed.backend} device=${parsed.device}`,
  );

  let demo: DemoSource | null = null;
  let serial: SerialReader | null = null;

  // When the backend broadcasts new thresholds, forward them to the
  // firmware over serial so it can apply them at runtime.
  const onThresholds = (payload: Record<string, unknown>): void => {
    logLine(`[bridge] received thresholds from backend`);
    if (serial) {
      const cmd = JSON.stringify({ cmd: 'set-thresholds', ...payload }) + '\n';
      const ok = serial.write(cmd);
      logLine(`[bridge] → serial: ${ok ? 'sent' : 'FAILED (port not open)'}`);
    } else if (demo) {
      logLine(`[bridge] thresholds ignored — demo source has no firmware`);
    }
  };

  const onCommand = (payload: Record<string, unknown>): void => {
    const cmd = typeof payload.cmd === 'string' ? payload.cmd : JSON.stringify(payload);
    logLine(`[bridge] received command from backend: ${cmd}`);
    if (serial) {
      const line = JSON.stringify(payload) + '\n';
      const ok = serial.write(line);
      logLine(`[bridge] → serial cmd: ${ok ? 'sent' : 'FAILED (port not open)'}`);
    } else if (demo) {
      logLine(`[bridge] command ignored — demo source has no firmware`);
    }
  };

  const ws = new WsClient(parsed.backend, logLine, onThresholds, onCommand);
  ws.start();

  const handleLine = (line: string): void => {
    const payload = parseLine(line, parsed.device);
    if (!payload) {
      logLine(`[bridge] skipping malformed line: ${line.slice(0, 120)}`);
      return;
    }
    const sent = ws.sendIngest(payload);
    if (sent) {
      const rh = payload.humidity !== undefined ? `${payload.humidity}` : '?';
      const gas = payload.gas !== undefined ? `${payload.gas}` : '?';
      logLine(`[bridge] → ${payload.deviceId} RH=${rh}% GAS=${gas}ppm`);
    } else {
      logLine(`[bridge] dropped ${payload.deviceId} (ws not open)`);
    }
  };

  if (parsed.source === 'demo') {
    demo = new DemoSource({ deviceId: parsed.device, onLine: handleLine });
    demo.start();
  } else {
    // parseArgs guaranteed parsed.port is defined for --source serial
    const port = parsed.port;
    if (!port) {
      // Defensive — should be unreachable.
      process.stderr.write('error: --port required for serial source\n');
      process.exit(2);
    }
    serial = new SerialReader({
      port,
      baud: parsed.baud,
      onLine: handleLine,
      onLog: logLine,
      onAck: (line: string) => {
        logLine(`[bridge] firmware ACK: ${line}`);
      },
    });
    serial.start();
  }

  const shutdown = (signal: NodeJS.Signals): void => {
    logLine(`[bridge] received ${signal}, shutting down`);
    if (demo) demo.stop();
    if (serial) serial.stop();
    ws.stop();
    // Hard-exit if listeners refuse to settle within 2 s.
    setTimeout(() => process.exit(0), 250).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
