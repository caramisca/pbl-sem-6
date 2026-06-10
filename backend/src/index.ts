import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';

import { Store } from './store.js';
import { TelemetrySimulator } from './simulator.js';
import { DEFAULT_PROFILES } from './profiles.js';
import { buildRouter } from './routes.js';
import { sanitiseThresholdPatch } from './thresholds.js';
import { validateAndMergeIngest } from './ingest.js';
import type {
  AlertEvent,
  ClientMessage,
  Device,
  LiveStatus,
  Telemetry,
  Thresholds,
  WelcomePayload,
  WsEnvelope,
} from './types.js';

const PORT = Number(process.env.PORT ?? 4000);
const SEED = process.env.SEED ? Number(process.env.SEED) : undefined;
// LIVE_ONLY=1 → register only the live Arduino device and skip the random-walk
// simulator so dashboards never show synthetic data.
const LIVE_ONLY = process.env.LIVE_ONLY === '1';
const LIVE_DEVICE_ID = process.env.LIVE_DEVICE_ID ?? 'rm-living';

function ts(): string {
  return new Date().toISOString();
}

function log(level: 'info' | 'warn' | 'error', msg: string, extra?: unknown): void {
  const line = `[${ts()}] ${level.toUpperCase()} ${msg}`;
  const payload = extra === undefined ? '' : ` ${JSON.stringify(extra)}`;
  if (level === 'error') console.error(line + payload);
  else if (level === 'warn') console.warn(line + payload);
  else console.log(line + payload);
}

const store = new Store([]);
const simulatorProfiles = LIVE_ONLY
  ? DEFAULT_PROFILES.filter((p) => p.device.id === LIVE_DEVICE_ID)
  : DEFAULT_PROFILES;
const simulator = new TelemetrySimulator(store, simulatorProfiles, SEED);

/**
 * Validate + apply an ingest payload from any transport (WS or REST).
 * Returns the merged Telemetry on success, or an error string on failure.
 */
function ingest(payload: unknown): { ok: true; reading: Telemetry } | { ok: false; error: string } {
  const result = validateAndMergeIngest(store, payload as Parameters<typeof validateAndMergeIngest>[1]);
  if (!result.ok) return result;
  store.applyLiveTelemetry(result.reading);
  log(
    'info',
    `[ingest] ${result.reading.deviceId} RH=${result.reading.humidity} T=${result.reading.temperature} GAS=${result.reading.gas}`,
  );
  return result;
}

function ingestFromHttp(payload: unknown): { ok: true } | { ok: false; error: string } {
  const r = ingest(payload);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

const app = express();
app.use(cors());
app.use(express.json({ limit: '64kb' }));

const startedAt = Date.now();
app.use('/api', buildRouter(store, startedAt, ingestFromHttp));

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

function envelope<T>(topic: string, payload: T): WsEnvelope<T> {
  return { topic, payload, ts: ts() };
}

function sendJson(socket: WebSocket, data: unknown): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(data));
}

function broadcast(data: unknown): void {
  const text = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(text);
    }
  }
}

// Subscribe to store events and fan them out to all WebSocket clients.
store.on('telemetry', (t: Telemetry) => {
  broadcast(envelope(`roommanager/${t.deviceId}/telemetry`, t));
});
store.on('state', (d: Device) => {
  broadcast(envelope(`roommanager/${d.id}/state`, d));
});
store.on('alert', (a: AlertEvent) => {
  log('warn', `alert raised`, {
    deviceId: a.deviceId,
    type: a.type,
    severity: a.severity,
  });
  broadcast(envelope(`roommanager/${a.deviceId}/alert`, a));
});
store.on('thresholds', (t: Thresholds) => {
  broadcast(envelope('roommanager/thresholds', t));
});
store.on('live-status', (s: LiveStatus) => {
  broadcast(envelope(`roommanager/${s.deviceId}/live`, s));
  log('info', `live-status ${s.live ? 'on' : 'off'}`, { deviceId: s.deviceId });
});

wss.on('connection', (socket, req) => {
  const remote = req.socket.remoteAddress ?? 'unknown';
  log('info', `ws connect`, { remote, clients: wss.clients.size });

  const welcome: WelcomePayload = {
    devices: store.listDevices(),
    telemetry: store.getLatestAll(),
    thresholds: store.getThresholds(),
  };
  sendJson(socket, envelope('welcome', welcome));

  socket.on('message', (raw) => {
    let parsed: ClientMessage;
    try {
      parsed = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      sendJson(socket, envelope('error', { error: 'invalid_json' }));
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    if (parsed.type === 'set-thresholds') {
      const safe = sanitiseThresholdPatch(parsed.payload);
      const next = store.updateThresholds(safe);
      sendJson(socket, envelope('thresholds-ack', next));
      log('info', 'thresholds updated via ws', safe);
    } else if (parsed.type === 'test-led' || parsed.type === 'test-buzzer') {
      const deviceId = typeof parsed.deviceId === 'string' && parsed.deviceId.length > 0
        ? parsed.deviceId
        : 'rm-living';
      const cmdPayload = { cmd: parsed.type, deviceId };
      broadcast(envelope('roommanager/command', cmdPayload));
      sendJson(socket, envelope('command-ack', { ...cmdPayload, status: 'sent' }));
      log('info', `command ${parsed.type} relayed`, { deviceId });
    } else if (parsed.type === 'ping') {
      sendJson(socket, envelope('pong', { ts: ts() }));
    } else if (parsed.type === 'ingest') {
      const result = ingest(parsed.payload);
      if (!result.ok) {
        sendJson(socket, envelope('ingest-error', { error: result.error }));
      }
    }
  });

  socket.on('close', () => {
    log('info', 'ws disconnect', { remote, clients: wss.clients.size - 1 });
  });

  socket.on('error', (err) => {
    log('error', 'ws error', { remote, message: err.message });
  });
});

server.listen(PORT, () => {
  log('info', `Room Manager mock broker listening`, {
    http: `http://localhost:${PORT}/api`,
    ws: `ws://localhost:${PORT}/ws`,
    seed: SEED ?? 'random',
    liveOnly: LIVE_ONLY,
  });
  if (LIVE_ONLY) {
    log('info', 'simulator disabled (LIVE_ONLY=1) — waiting for bridge ingest', {
      device: LIVE_DEVICE_ID,
    });
  } else {
    simulator.start();
  }
});

function shutdown(signal: NodeJS.Signals): void {
  log('info', `received ${signal}, shutting down`);
  simulator.stop();
  for (const client of wss.clients) {
    try {
      client.close(1001, 'server shutting down');
    } catch {
      /* ignore */
    }
  }
  server.close(() => process.exit(0));
  // hard-exit if listeners refuse to settle
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
