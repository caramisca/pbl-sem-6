# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Room Manager is an IoT indoor air-quality monitoring and automation system. An Arduino Mega 2560 reads a DHT11 (temperature/humidity) and MQ-2 (combustible gas), applies hysteresis-based control logic, and drives a ventilation fan (LED), humidifier (LED), piezo buzzer alarm, and servo-actuated window vent. A 16×2 I²C LCD shows live readings. Telemetry is piped through a Node.js serial-to-WebSocket bridge into a backend that fans it out to a React web dashboard and a React Native (Expo) mobile app.

## Commands

### Root (development orchestration)

```bash
npm run dev              # Runs backend + web concurrently
npm run dev:backend      # Backend only (port 4000)
npm run dev:web          # Web dashboard only (port 5173)
npm run dev:mobile       # Expo mobile app
npm run bridge:demo      # Bridge with demo data source (no hardware needed)
npm run bridge:serial    # Bridge with real Mega over serial (COM3)
npm run install:all      # Install dependencies across all sub-projects
```

### Per-sub-project

**backend** (Express + WebSocket, `backend/`)
```bash
npm --prefix backend run dev        # tsx watch → port 4000
npm --prefix backend run build      # tsc
```

**web** (React + Vite, `web/`)
```bash
npm --prefix web run dev            # Vite dev server → port 5173
npm --prefix web run build          # tsc -b && vite build
```

**mobile** (React Native + Expo, `mobile/`)
```bash
npm --prefix mobile start           # Expo dev server
npm --prefix mobile run android     # Expo for Android
```

**bridge** (serial→WS relay, `bridge/`)
```bash
npm --prefix bridge run demo        # --source demo --device rm-living
npm --prefix bridge run serial      # --source serial --port COM3 (override with --port)
```

**firmware** (PlatformIO, `firmware/`)
```bash
pio run                            # Build (inside firmware/)
pio run -t upload                  # Flash the Mega
pio device monitor                 # Serial monitor @ 9600 baud
```

### Environment variables

| Variable | Default | Effect |
|---|---|---|
| `PORT` | `4000` | Backend HTTP/WS listen port |
| `SEED` | random | PRNG seed for the telemetry simulator |
| `LIVE_ONLY` | `0` | `1` = disable simulator; only relay bridge data |
| `LIVE_DEVICE_ID` | `rm-living` | Device ID to keep when `LIVE_ONLY=1` |
| `VITE_BRIDGE_URL` | `ws://localhost:4000/ws` | Backend WS URL for the web dashboard |
| `EXPO_PUBLIC_BRIDGE_URL` | auto | Backend WS URL for mobile (Android defaults to `ws://10.0.2.2:4000/ws`) |

## Architecture

### Data flow

```
Mega 2560 (firmware)  ──Serial (JSON/line)──>  Bridge (Node)  ──WS──>  Backend (Express+WS)
                                                                          │
                                                              WS fan-out  │  REST API
                                                                   ┌──────┴──────┐
                                                                   ▼              ▼
                                                              Web (React)   Mobile (Expo)
```

- The firmware emits one JSON object per `Serial.println()` every 2 s on its own control loop. It also accepts inbound JSON threshold updates (`{"cmd":"set-thresholds",...}`) over serial from the bridge.
- The **bridge** reads newline-delimited JSON from serial (or a built-in demo source), reshapes it into an ingest payload, and sends it to the backend over WebSocket. When the backend broadcasts new thresholds (`roommanager/thresholds`), the bridge forwards them back to the firmware over serial.
- The **backend** holds an in-memory Store. It runs a telemetry simulator (random walk + configurable spikes) for each device profile. When `LIVE_ONLY=1`, the simulator is disabled entirely. Store state changes are emitted as typed events and fanned out to all WebSocket clients as MQTT-style topic envelopes (`roommanager/<deviceId>/telemetry`, `roommanager/<deviceId>/state`, `roommanager/<deviceId>/alert`, `roommanager/<deviceId>/live`, `roommanager/thresholds`).
- **Web** and **mobile** each have a client-side telemetry simulator (`mockTelemetry.ts`) that mirrors the backend's hysteresis logic. A `LiveBridge` WebSocket client connects to the backend; when live telemetry arrives, the simulator pauses for that device (10 s TTL). If the backend is unreachable, the local simulator runs standalone — the dashboard never appears empty.

### Firmware control loop (`firmware/src/main.cpp`)

Sense → Decide → Act → Display, on a 2 s tick. Hysteresis prevents flapping:
- Fan: ON at >60% RH or >24°C, OFF at <55% RH or <23°C (temperature-based fan uses its own on/off thresholds)
- Humidifier: ON at <40% RH, OFF at >45% RH
- Gas alarm: ON at >30% (≈300 ppm), OFF at <27% (≈270 ppm)
- Window servo: opens whenever fan is on, alarm is active, or temperature ≥24°C
- Mutual exclusion: fan wins over humidifier when both conditions are true; alarm forces fan on

Gas thresholds are stored in percent (0–100%) in firmware because the MQ-2 is read via 10-bit ADC. The bridge rescales: firmware's `gasPct` × 10 → backend ppm. Thresholds sent from backend to firmware are converted back (÷10).

### WebSocket protocol

All messages are JSON envelopes: `{ topic: string, payload: T, ts: string }`.

| Direction | Topic | Purpose |
|---|---|---|
| Server → Client | `welcome` | Full state snapshot on connect |
| Server → Client | `roommanager/<id>/telemetry` | New reading |
| Server → Client | `roommanager/<id>/state` | Device object update |
| Server → Client | `roommanager/<id>/alert` | Alert raised |
| Server → Client | `roommanager/<id>/live` | `{live: true/false}` toggle |
| Server → Client | `roommanager/thresholds` | Global thresholds changed |
| Client → Server | `{type:"ingest", payload}` | Bridge uploads a reading |
| Client → Server | `{type:"set-thresholds", payload}` | Update thresholds |
| Client → Server | `{type:"ping"}` | Keepalive; server responds with `pong` |

### REST API (`/api`)

- `GET /api/health` — uptime, device count
- `GET /api/devices` — all devices
- `GET /api/telemetry/:deviceId` — device + latest + history
- `GET /api/alerts` — alert list
- `GET /api/thresholds` / `PUT /api/thresholds` — read/update thresholds
- `POST /api/ingest` — same ingest pipeline as the WebSocket path

### Key backend files

| File | Role |
|---|---|
| `backend/src/index.ts` | Server bootstrap, WS lifecycle |
| `backend/src/store.ts` | In-memory store, typed EventEmitter, live-TTL tracking |
| `backend/src/simulator.ts` | Random-walk telemetry simulator with spike injection |
| `backend/src/alerts.ts` | Alert raise/resolve from actuator transitions |
| `backend/src/thresholds.ts` | `applyHysteresis()` pure function, sanitisation |
| `backend/src/ingest.ts` | Validate + merge bridge payloads |
| `backend/src/routes.ts` | Thin REST handlers |
| `backend/src/profiles.ts` | Default device definitions + spike config |

### Design system

Supabase-inspired dark theme. Key tokens (defined in `DESIGN.md`):
- Background: `#171717` (page), `#0f0f0f` (buttons)
- Brand green: `#3ecf8e` (accents), `#00c573` (links)
- Text: `#fafafa` (primary), `#b4b4b4` (secondary), `#898989` (muted)
- Typography: Inter (body), JetBrains Mono (code labels). Weight 400 for nearly everything; 500 only for buttons/nav.
- Depth created through border contrast (`#242424` → `#2e2e2e` → `#363636`), not shadows.
- Pill buttons (9999px radius) for primary CTAs.

### Web and mobile parity

Web (`web/`) and mobile (`mobile/`) share the same conceptual architecture: pages/screens with the same names (Dashboard, Devices, DeviceDetail, Alerts, Thresholds/Settings), a `liveBridge.ts` that connects to the backend WS, and a `mockTelemetry.ts` that runs a local simulator. They do **not** share code — each has its own copy of types, hooks, and components, adapted to its platform.

### Package dependency trick

The root `package.json` (`room-manager`) is listed as a dependency in backend, bridge, web, and mobile via `"room-manager": "file:.."`. This is a no-op convenience — there is no shared library code at the root level. Each sub-project duplicates its own types and logic. The `room-manager` dependency exists only so `concurrently` can be hoisted to the root.
