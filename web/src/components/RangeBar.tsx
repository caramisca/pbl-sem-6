import { useRef, useState } from 'react';
import styles from './RangeBar.module.css';

export interface BarHandle {
  id: string;
  value: number;
  label: string;
  color: 'green' | 'amber' | 'red' | 'sky';
}

export interface BarBand {
  lo: number;
  hi: number;
  color: string;
}

export interface BarReading {
  value: number;
  label: string;
}

interface Props {
  min: number;
  max: number;
  unit: string;
  step?: number;
  handles: BarHandle[];
  bands?: BarBand[];
  readings?: BarReading[];
  onChange: (id: string, value: number) => void;
}

export default function RangeBar({ min, max, unit, step = 1, handles, bands = [], readings = [], onChange }: Props): JSX.Element {
  const trackRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);

  function xToValue(clientX: number): number {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect) return min;
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const raw = min + ratio * (max - min);
    const snapped = Math.round(raw / step) * step;
    return Math.max(min, Math.min(max, snapped));
  }

  function pct(v: number): string {
    return `${Math.max(0, Math.min(100, ((v - min) / (max - min)) * 100))}%`;
  }

  function startDrag(id: string) {
    return (e: React.PointerEvent): void => {
      e.preventDefault();
      setDragId(id);
      const move = (ev: PointerEvent): void => onChange(id, xToValue(ev.clientX));
      const up = (): void => {
        setDragId(null);
        document.removeEventListener('pointermove', move);
        document.removeEventListener('pointerup', up);
      };
      document.addEventListener('pointermove', move);
      document.addEventListener('pointerup', up);
    };
  }

  return (
    <div className={styles.root}>
      {/* Track area — extra vertical space for handle overflow */}
      <div className={styles.trackWrap} ref={trackRef}>
        {/* Coloured bands */}
        {bands.map((b, i) => (
          <span
            key={i}
            className={styles.band}
            style={{ left: pct(b.lo), width: `calc(${pct(b.hi)} - ${pct(b.lo)})`, background: b.color }}
          />
        ))}

        {/* Live reading markers */}
        {readings.map((r, i) => (
          <span key={i} className={styles.reading} style={{ left: pct(r.value) }} title={`${r.label}: ${r.value}${unit}`}>
            <span className={styles.readingBadge}>{Math.round(r.value * 10) / 10}{unit}</span>
          </span>
        ))}

        {/* Draggable handles */}
        {handles.map((h) => (
          <div
            key={h.id}
            className={`${styles.handle} ${dragId === h.id ? styles.dragging : ''}`}
            style={{ left: pct(h.value) }}
            onPointerDown={startDrag(h.id)}
          >
            <span className={`${styles.badge} ${styles[`badge-${h.color}`]}`}>
              {Math.round(h.value * 10) / 10}{unit}
            </span>
            <span className={`${styles.stem} ${styles[`stem-${h.color}`]}`} />
            <span className={`${styles.thumb} ${styles[`thumb-${h.color}`]}`} />
            <span className={styles.lbl}>{h.label}</span>
          </div>
        ))}

        {/* Track bar itself */}
        <div className={styles.track} />
      </div>

      {/* Min / max labels */}
      <div className={styles.axisLabels}>
        <span>{min}{unit}</span>
        <span>{max}{unit}</span>
      </div>
    </div>
  );
}
