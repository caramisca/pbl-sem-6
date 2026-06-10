/**
 * Shared data contract for the Room Manager backend.
 * These types mirror the on-device JSON payloads published by the ESP32
 * firmware to the MQTT topics `roommanager/<deviceId>/{telemetry,state,alert}`.
 */

export type DeviceStatus = 'online' | 'offline' | 'warning' | 'danger';

export type AlertType =
  | 'humidity_high'
  | 'humidity_low'
  | 'gas_danger'
  | 'temp_high'
  | 'offline';

export type Severity = 'info' | 'warning' | 'danger';

export interface Device {
  id: string;
  name: string;
  location: string;
  status: DeviceStatus;
  firmware: string;
  lastSeen: string;
}

export interface Telemetry {
  deviceId: string;
  timestamp: string;
  humidity: number;
  temperature: number;
  gas: number;
  fanOn: boolean;
  humidifierOn: boolean;
  alarmOn: boolean;
  wifiRssi: number;
}

export interface Thresholds {
  humidityHigh: number;
  humidityHighOff: number;
  humidityLow: number;
  humidityLowOff: number;
  gasDanger: number;
  gasDangerOff: number;
  tempHigh: number;
}

export interface AlertEvent {
  id: string;
  deviceId: string;
  timestamp: string;
  type: AlertType;
  severity: Severity;
  message: string;
  resolved: boolean;
}

/**
 * Envelope every WebSocket subscriber receives. Mirrors the MQTT topic +
 * payload pair so a future swap to a real broker requires only transport
 * changes, not message-shape changes.
 */
export interface WsEnvelope<TPayload = unknown> {
  topic: string;
  payload: TPayload;
  ts: string;
}

/**
 * Welcome envelope sent immediately to a new WebSocket client.
 */
export interface WelcomePayload {
  devices: Device[];
  telemetry: Record<string, Telemetry | null>;
  thresholds: Thresholds;
}

/**
 * Partial telemetry shape used by `ingest` messages and the REST /api/ingest
 * endpoint. The bridge may send a malformed line; missing fields will be
 * filled in from the current latest state on the server.
 */
export interface PartialTelemetry {
  deviceId?: unknown;
  timestamp?: unknown;
  humidity?: unknown;
  temperature?: unknown;
  gas?: unknown;
  fanOn?: unknown;
  humidifierOn?: unknown;
  alarmOn?: unknown;
  wifiRssi?: unknown;
  // Permit unknown extra keys (e.g. the firmware's `uptime`) without losing strictness.
  [key: string]: unknown;
}

/**
 * Live status payload, broadcast on `roommanager/<id>/live` whenever the
 * "we just heard from the real device" flag flips.
 */
export interface LiveStatus {
  deviceId: string;
  live: boolean;
}

/**
 * Inbound WebSocket message from a client.
 */
export type ClientMessage =
  | { type: 'set-thresholds'; payload: Partial<Thresholds> }
  | { type: 'ping' }
  | { type: 'ingest'; payload: PartialTelemetry }
  | { type: 'test-led'; deviceId?: string }
  | { type: 'test-buzzer'; deviceId?: string };
