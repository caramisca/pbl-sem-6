import type { Device } from './types.js';

/**
 * Per-device baseline + spike probabilities for the random walk.
 * Spike probabilities are evaluated each tick; when one fires, the device
 * is pushed into an abnormal regime for several seconds (humidity > 65 to
 * trigger the fan, or gas > 400 to trip the alarm).
 */
export interface DeviceProfile {
  device: Device;
  baseHumidity: number;
  baseTemperature: number;
  baseGas: number;
  spike: { humidity?: number; gas?: number };
}

const now = (): string => new Date().toISOString();

export const DEFAULT_PROFILES: DeviceProfile[] = [
  {
    device: {
      id: 'rm-living',
      name: 'Living Room',
      location: 'Ground floor · north wall',
      status: 'online',
      firmware: '1.4.2',
      lastSeen: now(),
    },
    baseHumidity: 48,
    baseTemperature: 22,
    baseGas: 110,
    spike: {},
  },
];
