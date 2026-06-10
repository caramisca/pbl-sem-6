import { useMemo, useState } from 'react';
import TechLabel from '../components/TechLabel';
import RangeBar from '../components/RangeBar';
import type { BarHandle, BarBand, BarReading } from '../components/RangeBar';
import { telemetryStore, useDevices, useThresholds } from '../lib/mockTelemetry';
import { sendThresholds, sendCommand } from '../lib/liveBridge';
import { DEFAULT_THRESHOLDS } from '../lib/thresholds';
import type { Thresholds } from '../types';
import styles from './ThresholdsPage.module.css';

const HUMIDITY_MIN = 20;
const HUMIDITY_MAX = 80;
const GAS_MIN = 0;
const GAS_MAX = 700;
const TEMP_MIN = 18;
const TEMP_MAX = 35;

/* ─── Component ───────────────────────────────────────────────── */

export default function ThresholdsPage(): JSX.Element {
  const [stored, setStored] = useThresholds();
  const [draft, setDraft] = useState<Thresholds>(stored);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testingLed, setTestingLed] = useState(false);
  const [testingBuzzer, setTestingBuzzer] = useState(false);
  const devices = useDevices();
  const primary = devices[0];
  const latest = primary ? telemetryStore.getLatest(primary.id) : null;
  const currentHum = latest?.humidity ?? 50;
  const currentGas = latest?.gas ?? 120;
  const currentTemp = latest?.temperature ?? 22;

  const dirty = useMemo(
    () => (Object.keys(draft) as (keyof Thresholds)[]).some((k) => draft[k] !== stored[k]),
    [draft, stored],
  );

  function handleChange(id: string, value: number): void {
    setDraft((d) => ({
      ...d,
      [id]: Math.round(value),
    }));
  }

  function save(): void {
    const safe: Thresholds = {
      humidityHigh: Math.max(draft.humidityHighOff + 2, draft.humidityHigh),
      humidityHighOff: Math.max(HUMIDITY_MIN, draft.humidityHighOff),
      humidityLow: Math.min(draft.humidityLowOff - 2, draft.humidityLow),
      humidityLowOff: Math.min(HUMIDITY_MAX, draft.humidityLowOff),
      gasDanger: Math.max(draft.gasDangerOff + 5, draft.gasDanger),
      gasDangerOff: Math.max(GAS_MIN, draft.gasDangerOff),
      tempHigh: draft.tempHigh,
    };
    setStored(safe);
    setDraft(safe);
    sendThresholds(safe); // push to backend → bridge → firmware
    setSavedAt(Date.now());
    setTimeout(() => setSavedAt(null), 2600);
  }

  function reset(): void {
    setDraft({ ...DEFAULT_THRESHOLDS });
  }

  function runTest(cmd: 'test-led' | 'test-buzzer'): void {
    const setter = cmd === 'test-led' ? setTestingLed : setTestingBuzzer;
    const deviceId = primary?.id;
    setter(true);
    sendCommand(cmd, deviceId);
    // Auto-reset after the firmware test duration + a small buffer.
    setTimeout(() => setter(false), 2200);
  }

  /* ─── Range-bar definitions ─────────────────────────────────── */

  // --- Humidity ---
  const humidityHandles: BarHandle[] = [
    { id: 'humidityLow',       value: draft.humidityLow,       label: 'Humidifier ON ↓',  color: 'sky' },
    { id: 'humidityLowOff',    value: draft.humidityLowOff,    label: 'Humidifier OFF ↑', color: 'sky' },
    { id: 'humidityHighOff',   value: draft.humidityHighOff,   label: 'Fan OFF ↓',        color: 'amber' },
    { id: 'humidityHigh',      value: draft.humidityHigh,      label: 'Fan ON ↑',         color: 'amber' },
  ];

  const humidityBands: BarBand[] = [
    { lo: HUMIDITY_MIN,         hi: draft.humidityLow,        color: 'rgba(91,139,247,0.18)'  },  // dry → humidifier
    { lo: draft.humidityLowOff,  hi: draft.humidityHighOff,    color: 'rgba(62,207,142,0.18)' },  // comfort
    { lo: draft.humidityHigh,    hi: HUMIDITY_MAX,             color: 'rgba(245,165,36,0.18)' }, // too humid → fan
  ];

  const humidityReading: BarReading[] = [
    { value: currentHum, label: `${currentHum.toFixed(1)}%` },
  ];

  // --- Gas ---
  const gasHandles: BarHandle[] = [
    { id: 'gasDangerOff',  value: draft.gasDangerOff, label: 'Alarm OFF ↓', color: 'amber' },
    { id: 'gasDanger',     value: draft.gasDanger,    label: 'Alarm ON ↑',  color: 'red' },
  ];

  const gasBands: BarBand[] = [
    { lo: GAS_MIN,            hi: draft.gasDangerOff, color: 'rgba(62,207,142,0.18)'  },  // safe
    { lo: draft.gasDangerOff, hi: draft.gasDanger,    color: 'rgba(245,165,36,0.18)' },  // hysteresis
    { lo: draft.gasDanger,    hi: GAS_MAX,            color: 'rgba(239,68,68,0.14)'  },  // danger
  ];

  const gasReading: BarReading[] = [
    { value: currentGas, label: `${Math.round(currentGas)} ppm` },
  ];

  // --- Temperature ---
  const tempHandles: BarHandle[] = [
    { id: 'tempHigh', value: draft.tempHigh, label: 'Alarm above ↑', color: 'red' },
  ];

  const tempBands: BarBand[] = [
    { lo: TEMP_MIN,        hi: draft.tempHigh, color: 'rgba(62,207,142,0.18)' },  // safe
    { lo: draft.tempHigh,  hi: TEMP_MAX,       color: 'rgba(239,68,68,0.14)'  },  // danger
  ];

  const tempReading: BarReading[] = [
    { value: currentTemp, label: `${currentTemp.toFixed(1)}°C` },
  ];

  const humStatus = currentHum > draft.humidityHigh
    ? { cls: styles.statusDanger, text: 'TOO HIGH' }
    : currentHum < draft.humidityLow
      ? { cls: styles.statusWarn, text: 'TOO LOW' }
      : { cls: styles.statusOk, text: 'IN BAND' };

  const gasStatus = currentGas > draft.gasDanger
    ? { cls: styles.statusDanger, text: 'DANGER' }
    : currentGas > draft.gasDangerOff
      ? { cls: styles.statusWarn, text: 'HYSTERESIS' }
      : { cls: styles.statusOk, text: 'SAFE' };

  const tempStatus = currentTemp > draft.tempHigh
    ? { cls: styles.statusDanger, text: 'ALARM' }
    : { cls: styles.statusOk, text: 'NORMAL' };

  return (
    <div className={styles.page}>
      <header className={styles.head}>
        <div>
          <TechLabel>Configuration</TechLabel>
          <h1 className={styles.title}>Thresholds</h1>
          <p className={styles.lead}>
            Drag the handles to set hysteresis bands. The actuator engages when the reading
            crosses ON and releases once it moves past OFF — this prevents chatter.
          </p>
        </div>
        {primary && (
          <div className={styles.connectionCard}>
            <div className={styles.connDot}>●</div>
            <div>
              <div className={styles.connDevice}>{primary.name}</div>
              <div className={styles.connLoc}>{primary.location}</div>
            </div>
          </div>
        )}
      </header>

      <div className={styles.cards}>
        {/* ─── Humidity ─── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.cardIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M12 3c-4 6-8 10-8 14a8 8 0 0 0 16 0c0-4-4-8-8-14z" />
                <line x1="12" y1="11" x2="12" y2="18" strokeWidth="2" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Humidity</h2>
              <p className={styles.cardDesc}>Fan &amp; humidifier bands</p>
            </div>
            <div className={`${styles.liveReading} ${humStatus.cls}`}>
              <span className={styles.liveValue}>{currentHum.toFixed(1)}%</span>
              <span className={styles.liveLabel}>{humStatus.text}</span>
            </div>
          </div>
          <div className={styles.barArea}>
            <RangeBar
              min={HUMIDITY_MIN}
              max={HUMIDITY_MAX}
              unit="%"
              step={1}
              handles={humidityHandles}
              bands={humidityBands}
              readings={humidityReading}
              onChange={handleChange}
            />
          </div>
          <div className={styles.legend}>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(91,139,247,0.55)' }} /> Humidifier zone</span>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(62,207,142,0.55)' }} /> Comfort band</span>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(245,165,36,0.55)' }} /> Fan zone</span>
          </div>
        </section>

        {/* ─── Gas ─── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.cardIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M5 12h14" />
                <path d="M12 5v14" />
                <circle cx="12" cy="12" r="10" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Gas — Danger</h2>
              <p className={styles.cardDesc}>Alarm &amp; fan override</p>
            </div>
            <div className={`${styles.liveReading} ${gasStatus.cls}`}>
              <span className={styles.liveValue}>{Math.round(currentGas)} ppm</span>
              <span className={styles.liveLabel}>{gasStatus.text}</span>
            </div>
          </div>
          <div className={styles.barArea}>
            <RangeBar
              min={GAS_MIN}
              max={GAS_MAX}
              unit=" ppm"
              step={1}
              handles={gasHandles}
              bands={gasBands}
              readings={gasReading}
              onChange={handleChange}
            />
          </div>
          <div className={styles.legend}>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(62,207,142,0.55)' }} /> Safe</span>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(245,165,36,0.55)' }} /> Hysteresis</span>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(239,68,68,0.55)' }} /> Danger</span>
          </div>
        </section>

        {/* ─── Temperature ─── */}
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <div className={styles.cardIcon}>
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <line x1="12" y1="3" x2="12" y2="18" />
                <path d="M7 14a5 5 0 1 0 10 0c0-3-5-8.7-5-8.7S7 11 7 14z" />
              </svg>
            </div>
            <div>
              <h2 className={styles.cardTitle}>Temperature</h2>
              <p className={styles.cardDesc}>Alert-only threshold</p>
            </div>
            <div className={`${styles.liveReading} ${tempStatus.cls}`}>
              <span className={styles.liveValue}>{currentTemp.toFixed(1)}°C</span>
              <span className={styles.liveLabel}>{tempStatus.text}</span>
            </div>
          </div>
          <div className={styles.barArea}>
            <RangeBar
              min={TEMP_MIN}
              max={TEMP_MAX}
              unit="°C"
              step={1}
              handles={tempHandles}
              bands={tempBands}
              readings={tempReading}
              onChange={handleChange}
            />
          </div>
          <div className={styles.legend}>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(62,207,142,0.55)' }} /> Normal</span>
            <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: 'rgba(239,68,68,0.55)' }} /> Alert</span>
          </div>
        </section>
      </div>

      {/* ─── Actions ─── */}
      <footer className={styles.footer}>
        <div className={styles.actions}>
          <button className={`${styles.btn} ${styles.btnPrimary}`} onClick={save} disabled={!dirty}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="4 17 10 13 16 21 22 5 12 13" />
            </svg>
            Save thresholds
          </button>
          <button className={`${styles.btn} ${styles.btnSecondary}`} onClick={reset}>
            Reset defaults
          </button>
          {savedAt && (
            <span className={styles.savedBadge}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
              Applied to all devices
            </span>
          )}
          <div className={styles.testGroup}>
            <span className={styles.testLabel}>HW test</span>
            <button
              className={`${styles.btn} ${testingLed ? styles.btnTestActive : styles.btnTest}`}
              onClick={() => runTest('test-led')}
              disabled={testingLed || testingBuzzer}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" />
                <line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" />
                <line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
              {testingLed ? 'Testing…' : 'Test LED'}
            </button>
            <button
              className={`${styles.btn} ${testingBuzzer ? styles.btnTestActive : styles.btnTest}`}
              onClick={() => runTest('test-buzzer')}
              disabled={testingLed || testingBuzzer}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                <path d="M13.73 21a2 2 0 0 1-3.46 0" />
              </svg>
              {testingBuzzer ? 'Testing…' : 'Test Buzzer'}
            </button>
          </div>
        </div>
        {dirty && <span className={styles.dirtyHint}>{changedCount(draft, stored)} change{changedCount(draft, stored) !== 1 ? 's' : ''} pending</span>}
      </footer>
    </div>
  );
}

function changedCount(a: Thresholds, b: Thresholds): number {
  return (Object.keys(a) as (keyof Thresholds)[]).filter((k) => a[k] !== b[k]).length;
}
