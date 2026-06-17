/**
 * GlitchPanel.jsx — Lista de eventos de glitch detectados
 * Telemetría compacta por evento: índice de muestra, tiempo, magnitud, estado.
 */
import { useState, useEffect } from 'react';
import { Zap, CheckCircle, AlertTriangle, ChevronDown, ChevronUp } from 'lucide-react';

const ROW_H = 36;

export default function GlitchPanel({ glitches, sampleRate, threshold = 0.25, onThresholdChange, onHealOne }) {
  const [sortBy, setSortBy] = useState('magnitude'); // 'time' | 'magnitude'
  const [sortAsc, setSortAsc] = useState(false);
  const [localThreshold, setLocalThreshold] = useState(threshold);

  // Sincronizar el slider si el threshold cambia externamente
  useEffect(() => {
    setLocalThreshold(threshold);
  }, [threshold]);

  // Debounce de 120ms para el recálculo pesado del DSP en el hilo de UI
  useEffect(() => {
    if (localThreshold === threshold) return;
    const timer = setTimeout(() => {
      onThresholdChange?.(localThreshold);
    }, 120);
    return () => clearTimeout(timer);
  }, [localThreshold, threshold, onThresholdChange]);

  const sorted = [...(glitches || [])].sort((a, b) => {
    const aV = sortBy === 'magnitude' ? a.magnitude : a.index;
    const bV = sortBy === 'magnitude' ? b.magnitude : b.index;
    return sortAsc ? aV - bV : bV - aV;
  });

  const total    = glitches?.length || 0;
  const repaired = glitches?.filter(g => g.repaired).length || 0;

  const toggleSort = (field) => {
    if (sortBy === field) setSortAsc(p => !p);
    else { setSortBy(field); setSortAsc(false); }
  };

  const fmtTime = (idx) => {
    if (!sampleRate) return '---';
    const s = idx / sampleRate;
    const m = Math.floor(s / 60);
    const sec = (s % 60).toFixed(3);
    return `${m}:${sec.padStart(6, '0')}`;
  };

  return (
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      fontFamily: 'var(--font-ui)',
    }}>

      {/* Header */}
      <div style={{
        padding: '14px 16px 10px',
        borderBottom: '1px solid var(--vostok-border)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
          <AlertTriangle style={{ width: 14, height: 14, color: '#FF4444' }} />
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: '9px', fontWeight: 900,
            letterSpacing: '0.25em', color: '#fff', textTransform: 'uppercase',
          }}>Glitch Report</span>
        </div>

        {/* Stats */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px', marginBottom: onThresholdChange ? '12px' : '0' }}>
          {[
            { label: 'Detectados', value: total,          color: '#FF4444' },
            { label: 'Reparados',  value: repaired,        color: 'var(--vostok-cyan)' },
          ].map(({ label, value, color }) => (
            <div key={label} className="glass-panel" style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)' }}>
              <div className="label-xs">{label}</div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: '1.3rem', fontWeight: 900, color, lineHeight: 1.2 }}>
                {value}
              </div>
            </div>
          ))}
        </div>

        {/* Slider de Threshold (Ajuste Fino) */}
        {onThresholdChange && (
          <div style={{
            padding: '10px 12px',
            background: 'rgba(255, 255, 255, 0.02)',
            border: '1px solid rgba(255, 255, 255, 0.05)',
            borderRadius: 'var(--radius-sm)',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px'
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="label-xs" style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 700 }}>AJUSTE UMBRAL</span>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '11px', fontWeight: 900, color: 'var(--vostok-green)' }}>
                {threshold.toFixed(2)}
              </span>
            </div>
            <input
              type="range" min="0.05" max="0.60" step="0.01"
              value={localThreshold}
              onChange={(e) => setLocalThreshold(parseFloat(e.target.value))}
              style={{
                width: '100%',
                accentColor: 'var(--vostok-green)',
                cursor: 'pointer',
                height: '4px'
              }}
              id="threshold-slider-fine"
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', color: 'rgba(255,255,255,0.3)', fontFamily: 'var(--font-mono)' }}>
              <span>0.05 Sensible</span>
              <span>0.60 Agresivo</span>
            </div>
          </div>
        )}
      </div>

      {/* Column Headers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '40px 1fr 60px 45px 28px',
        gap: '4px',
        padding: '6px 16px',
        borderBottom: '1px solid var(--vostok-border)',
        flexShrink: 0,
      }}>
        {[
          { label: '#',    field: null },
          { label: 'Tiempo', field: 'time' },
          { label: 'ΔV',   field: 'magnitude' },
          { label: '',     field: null },
        ].map(({ label, field }) => (
          <span
            key={label}
            className="label-xs"
            style={{
              cursor: field ? 'pointer' : 'default',
              display: 'flex', alignItems: 'center', gap: '3px',
              color: field && sortBy === field ? 'var(--vostok-green)' : undefined,
            }}
            onClick={() => field && toggleSort(field)}
          >
            {label}
            {field && sortBy === field && (
              sortAsc
                ? <ChevronUp style={{ width: 8, height: 8 }} />
                : <ChevronDown style={{ width: 8, height: 8 }} />
            )}
          </span>
        ))}
      </div>

      {/* List */}
      <div className="scrollable" style={{ flex: 1, padding: '4px 8px' }}>
        {sorted.length === 0 ? (
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            justifyContent: 'center', height: '100%', gap: '8px',
          }}>
            <CheckCircle style={{ width: 28, height: 28, color: 'var(--vostok-green)', opacity: 0.5 }} />
            <span className="label-xs">Sin glitches detectados</span>
          </div>
        ) : (
          sorted.map((g, i) => (
            <div
              key={g.index}
              style={{
                display: 'grid',
                gridTemplateColumns: '40px 1fr 60px 45px 28px',
                gap: '4px',
                alignItems: 'center',
                height: ROW_H,
                padding: '0 8px',
                borderRadius: 'var(--radius-sm)',
                borderBottom: '1px solid rgba(255,255,255,0.04)',
                background: g.repaired ? 'rgba(0,255,255,0.03)' : 'transparent',
                transition: 'background 0.1s',
              }}
            >
              {/* Index */}
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: '9px', fontWeight: 700,
                color: 'rgba(255,255,255,0.25)',
              }}>
                {(i + 1).toString().padStart(3, '0')}
              </span>

              {/* Time */}
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: '10px', fontWeight: 700,
                color: g.repaired ? 'var(--vostok-cyan)' : 'rgba(255,255,255,0.7)',
              }}>
                {fmtTime(g.index)}
              </span>

              {/* Magnitude */}
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <div style={{
                  height: '3px',
                  width: `${Math.min(100, g.magnitude * 100)}%`,
                  minWidth: '4px',
                  background: g.repaired
                    ? 'var(--vostok-cyan)'
                    : `hsl(${Math.round((1 - g.magnitude) * 30)}, 100%, 55%)`,
                  borderRadius: '99px',
                  transition: 'background 0.3s',
                }} />
              </div>

              {/* Heal button */}
              {!g.repaired ? (
                <button
                  onClick={() => onHealOne(glitches.indexOf(g))}
                  style={{
                    width: 22, height: 22,
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    background: 'rgba(57,255,20,0.1)',
                    border: '1px solid rgba(57,255,20,0.25)',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    color: 'var(--vostok-green)',
                    transition: 'all 0.15s',
                  }}
                  title="Reparar este glitch"
                >
                  <Zap style={{ width: 10, height: 10 }} />
                </button>
              ) : (
                <CheckCircle style={{ width: 14, height: 14, color: 'var(--vostok-cyan)', opacity: 0.7 }} />
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
