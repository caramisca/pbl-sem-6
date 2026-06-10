import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import type { Telemetry } from '../types';
import { telemetryStore } from './mockTelemetry';

/**
 * WebSocket bridge between the in-app store and the backend's live feed.
 *
 * The backend re-broadcasts MQTT-style envelopes:
 *   { topic: string, payload: any, ts: string }
 *
 * Topics handled here:
 *   - `roommanager/<deviceId>/telemetry` — Telemetry payload, fed into the
 *     store via `applyLiveTelemetry`. The store suppresses simulator updates
 *     for any device with a recent live reading (10 s TTL).
 *   - `roommanager/<deviceId>/live` — `{live, deviceId}` toggle.
 *
 * If the bridge cannot connect we fall back silently to the in-app simulator.
 */

const RECONNECT_MS = 5_000;
const LOG_EVERY_NTH_RETRY = 5;

type LiveEnvelope = {
  topic: string;
  payload: unknown;
  ts: string;
};

type LivePayload = {
  live: boolean;
  deviceId: string;
};

interface WelcomePayload {
  devices?: unknown;
  thresholds?: unknown;
  latest?: Record<string, Telemetry>;
}

type ConnectionListener = (connected: boolean) => void;

class LiveBridge {
  private url: string;
  private socket: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private hasLoggedFailure = false;
  private connected = false;
  private listeners = new Set<ConnectionListener>();
  private stopped = false;

  constructor(url: string) {
    this.url = url;
  }

  connect(): void {
    if (this.socket) return;
    this.stopped = false;
    this.openSocket();
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // ignore
      }
      this.socket = null;
    }
    this.setConnected(false);
  }

  isConnected(): boolean {
    return this.connected;
  }

  subscribe(listener: ConnectionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setConnected(value: boolean): void {
    if (this.connected === value) return;
    this.connected = value;
    this.listeners.forEach((l) => l(value));
  }

  private openSocket(): void {
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.handleFailure(err);
      return;
    }
    this.socket = ws;

    ws.onopen = (): void => {
      this.retries = 0;
      this.hasLoggedFailure = false;
      this.setConnected(true);
    };

    ws.onmessage = (ev: WebSocketMessageEvent): void => {
      this.handleMessage(ev.data);
    };

    ws.onerror = (): void => {
      // The actual close handler will trigger reconnect logic.
    };

    ws.onclose = (): void => {
      this.socket = null;
      this.setConnected(false);
      if (!this.stopped) this.scheduleReconnect();
    };
  }

  private handleMessage(raw: unknown): void {
    if (typeof raw !== 'string') return;
    let envelope: LiveEnvelope;
    try {
      envelope = JSON.parse(raw) as LiveEnvelope;
    } catch {
      return;
    }
    if (!envelope || typeof envelope.topic !== 'string') return;

    if (envelope.topic === 'welcome') {
      const payload = envelope.payload as WelcomePayload | undefined;
      if (payload && payload.latest && typeof payload.latest === 'object') {
        Object.values(payload.latest).forEach((reading) => {
          if (isTelemetry(reading)) {
            telemetryStore.applyLiveTelemetry(reading);
          }
        });
      }
      return;
    }

    const match = envelope.topic.match(/^roommanager\/([^/]+)\/(telemetry|live|state|alert)$/);
    if (!match) return;
    const [, deviceId, kind] = match;
    if (!deviceId) return;

    if (kind === 'telemetry') {
      if (isTelemetry(envelope.payload)) {
        telemetryStore.applyLiveTelemetry(envelope.payload);
      }
      return;
    }

    if (kind === 'live') {
      const payload = envelope.payload as Partial<LivePayload> | null;
      if (payload && typeof payload.live === 'boolean') {
        telemetryStore.setLive(deviceId, payload.live);
      }
    }
    // `state` and `alert` ignored — simulator already drives these.
  }

  private handleFailure(err: unknown): void {
    if (!this.hasLoggedFailure) {
      this.hasLoggedFailure = true;
      // eslint-disable-next-line no-console
      console.warn('[liveBridge] connection failed, falling back to local simulator', err);
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.retries += 1;
    if (this.retries % LOG_EVERY_NTH_RETRY === 0) {
      // eslint-disable-next-line no-console
      console.warn(`[liveBridge] still offline after ${this.retries} attempts`);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openSocket();
    }, RECONNECT_MS);
  }
}

function isTelemetry(value: unknown): value is Telemetry {
  if (!value || typeof value !== 'object') return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.deviceId === 'string' &&
    typeof t.timestamp === 'string' &&
    typeof t.humidity === 'number' &&
    typeof t.temperature === 'number' &&
    typeof t.gas === 'number' &&
    typeof t.fanOn === 'boolean' &&
    typeof t.humidifierOn === 'boolean' &&
    typeof t.alarmOn === 'boolean' &&
    typeof t.wifiRssi === 'number'
  );
}

// Expo injects `process.env.EXPO_PUBLIC_*` at build time. Node types aren't
// in this tsconfig, so we declare just the slice we need.
declare const process: { env: Record<string, string | undefined> };

function resolveUrl(): string {
  const envUrl = process.env.EXPO_PUBLIC_BRIDGE_URL;
  if (envUrl && envUrl.length > 0) return envUrl;
  // Android emulator routes to the host machine via 10.0.2.2; iOS / web /
  // physical devices on Wi-Fi can hit localhost from the dev machine. The
  // user can override either with EXPO_PUBLIC_BRIDGE_URL.
  if (Platform.OS === 'android') return 'ws://10.0.2.2:4000/ws';
  return 'ws://localhost:4000/ws';
}

const bridge = new LiveBridge(resolveUrl());

export function connect(): void {
  bridge.connect();
}

export function disconnect(): void {
  bridge.disconnect();
}

export interface LiveStatus {
  connected: boolean;
  deviceLive: boolean;
}

export function useLiveStatus(deviceId?: string): LiveStatus {
  const [connected, setConnected] = useState<boolean>(bridge.isConnected());
  const [deviceLive, setDeviceLive] = useState<boolean>(
    deviceId ? telemetryStore.isLive(deviceId) : false,
  );

  useEffect(() => {
    const unsub = bridge.subscribe((value) => setConnected(value));
    return unsub;
  }, []);

  useEffect(() => {
    if (!deviceId) {
      setDeviceLive(false);
      return undefined;
    }
    const update = (): void => setDeviceLive(telemetryStore.isLive(deviceId));
    update();
    const unsub = telemetryStore.subscribeLive(update);
    return unsub;
  }, [deviceId]);

  return { connected, deviceLive };
}
