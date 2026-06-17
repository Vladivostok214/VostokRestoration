/**
 * LandingView.jsx — Pantalla de bienvenida y carga de archivos (Flujo SOTA Optimizado)
 *
 * Pipeline de carga diferido:
 * 1. Invoke cargar_y_analizar_archivo → Decodificación y STFT en Rust (Sin buscar glitches automáticamente)
 * 2. Invoke obtener_espectrograma_visible → Vec<u8> binario [u32 frames][u32 bins][u8 payload]
 * 3. Parsear binario → Uint8Array y escribir en SPECTROGRAM_STORAGE (zero-copy)
 * 4. Llamar onFileLoaded con glitches vacíos [] → El análisis se delegará a demanda en la UI principal
 */
import { useState, useCallback, useEffect } from 'react';
import { Upload, FileAudio, Zap, Activity, Cpu } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { SPECTROGRAM_STORAGE } from './spectrogramStore.js';

// ── Mensajes rotativos para el estado de carga (Opción B) ──
const LOADING_PHASES = [
  'INICIALIZANDO MOTOR DSP...',
  'DECODIFICANDO CONTENEDOR DE AUDIO...',
  'ANALIZANDO MUESTRAS PCM...',
  'COMPUTANDO TRANSFORMADA ESPECTRAL STFT...',
  'CONSTRUYENDO MATRIZ DE FRECUENCIAS...',
  'GENERANDO TEXTURA ESPECTRAL...',
  'OPTIMIZANDO RESOLUCIÓN TEMPORAL...',
  'FINALIZANDO ANÁLISIS INICIAL...',
];

// ── Barras del horizonte espectral generativo (Opción C) ──
// Heights generadas con función sin/cos para patrón orgánico sin datos de audio reales.
const HORIZON_BARS = Array.from({ length: 72 }, (_, i) => ({
  height: Math.round(12 + 52 * Math.abs(Math.sin(i * 0.31 + 1.2) * Math.cos(i * 0.19 + 0.5))),
  delay:  parseFloat(((i * 0.07) % 2.8).toFixed(2)),
  dur:    parseFloat((1.4 + (i % 5) * 0.22).toFixed(2)),
}));

export default function LandingView({ onFileLoaded }) {
  const [dragging, setDragging]   = useState(false);
  const [loading, setLoading]     = useState(false);
  const [progress, setProgress]   = useState(0);
  const [phase, setPhase]         = useState('');
  const [error, setError]         = useState(null);
  const [phaseIdx, setPhaseIdx]   = useState(0);

  // ── Cicla mensajes de fase mientras carga (VHRP: limpia el interval al desmontar) ──
  useEffect(() => {
    if (!loading) { setPhaseIdx(0); return; }
    const id = setInterval(() => setPhaseIdx(p => (p + 1) % LOADING_PHASES.length), 1800);
    return () => clearInterval(id);
  }, [loading]);

  const SUPPORTED = ['wav', 'mp3', 'flac'];

  const processFile = useCallback(async (file) => {
    let path = file.path || file.name;
    path = path.replace(/\\/g, '/');
    const ext = path.split('.').pop().toLowerCase();

    if (!SUPPORTED.includes(ext)) {
      setError(`Formato no soportado. Usa: ${SUPPORTED.join(', ').toUpperCase()}`);
      return;
    }
    setError(null);
    setLoading(true);
    setProgress(0.1);

    try {
      // ── FASE 1: Decodificación nativa y cómputo STFT en Rust ──
      setPhase('DECODIFICANDO AUDIO Y CALCULANDO ESPECTROGRAMA (RUST SIMD)...');
      setProgress(0.3);
      const analysis = await invoke('cargar_y_analizar_archivo', { path });
      setProgress(0.7);

      // ── FASE 2: Obtener espectrograma como bytes binarios ──
      setPhase('GENERANDO TEXTURA ESPECTRAL VIEWPORT...');
      const stftRes = await invoke('obtener_espectrograma_visible', {
        config: { start_frame: 0, end_frame: analysis.stft_frames, max_texture_width: 2048 }
      });
      setProgress(1.0);

      // ── FASE 3: Parsear binario [u32 frames][u32 bins][u8 payload] ──
      let parsedMatrix = null;
      let parsedFrames = 0;
      let parsedBins   = 0;
      try {
        let buffer, byteOffset;
        if (stftRes instanceof ArrayBuffer) {
          buffer = stftRes; byteOffset = 0;
        } else {
          const view = ArrayBuffer.isView(stftRes) ? stftRes : new Uint8Array(stftRes);
          buffer = view.buffer; byteOffset = view.byteOffset;
        }
        const dv = new DataView(buffer, byteOffset);
        parsedFrames = dv.getUint32(0, true);
        parsedBins   = dv.getUint32(4, true);
        parsedMatrix = new Uint8Array(buffer, byteOffset + 8, parsedFrames * parsedBins);
        console.log(`[LandingView] Espectrograma: ${parsedFrames} frames × ${parsedBins} bins`);
      } catch (parseErr) {
        console.warn('[LandingView] Error parseando binario:', parseErr);
      }

      // ── FASE 4: Depositar en SPECTROGRAM_STORAGE (zero-copy, sin React state) ──
      SPECTROGRAM_STORAGE.transient = null;
      SPECTROGRAM_STORAGE.hum = parsedMatrix;
      SPECTROGRAM_STORAGE.full = parsedMatrix; // Copia estática del archivo completo para restauración rápida

      // Por defecto el umbral inicial de tolerancia es 0.25 (Análisis diferido)
      const threshold = 0.25;

      onFileLoaded({
        file,
        fileName:        file.name || path.split('/').pop(),
        filePath:        path,
        duration:        analysis.duration_seconds,
        sampleRate:      analysis.sample_rate,
        channels:        analysis.channels,
        bitDepth:        analysis.bit_depth,
        samples:         null,
        glitches:        [], // 💡 SOTA: Inicializa vacío. El escaneo ocurrirá bajo demanda.
        stftFrames:      parsedFrames || analysis.stft_frames,
        stftBins:        parsedBins   || analysis.stft_bins,
        totalStftFrames: parsedFrames || analysis.stft_frames,
        totalStftBins:   parsedBins   || analysis.stft_bins,
        waveformEnvelope: analysis.waveform_envelope,
        status:          'ready',
        progress:        1.0,
        threshold,
        spectrogramCache: {
          transient: null,
          hum: parsedMatrix
            ? { frames: parsedFrames, bins: parsedBins, totalFrames: analysis.stft_frames, threshold }
            : null,
        },
        matrixVersion: 1,
      });

    } catch (err) {
      console.error('[Tauri Loader] Error:', err);
      setError(`Error de carga nativa: ${err}`);
      setLoading(false);
      setProgress(0);
    }
  }, [onFileLoaded]);

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: 'Audio', extensions: SUPPORTED }]
      });
      if (selected) {
        const normalizedPath = selected.replace(/\\/g, '/');
        processFile({ name: normalizedPath.split('/').pop(), path: normalizedPath });
      }
    } catch (err) {
      console.error('[Tauri Dialog Error]:', err);
      setError(`Error abriendo selector nativo: ${err}`);
    }
  };

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      if (f.path) f.path = f.path.replace(/\\/g, '/');
      processFile(f);
    }
  }, [processFile]);

  const handleDragOver  = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);

  return (
    /* ── Opción A: grid-bg activa la cuadrícula milimétrica del design system ── */
    <div className="grid-bg" style={{
      width: '100%', height: '100%',
      position: 'relative',
      backgroundColor: '#010101',
      fontFamily: 'var(--font-ui)',
      color: '#fff',
    }}>

      {/* ── Contenido principal: z-index 1 para quedar sobre el horizonte espectral ── */}
      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '32px', gap: '28px',
      }}>
        {/* Encabezado */}
        <div style={{ textAlign: 'center' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '8px' }}>
            <div className="dot-pulse-green" style={{ width: 6, height: 6 }} />
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', fontWeight: 900, letterSpacing: '0.5em', color: '#39FF14' }}>
              VOSTOK RESTORATION
            </span>
            <div className="dot-pulse-green" style={{ width: 6, height: 6 }} />
          </div>
          <h1 style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '3rem', fontWeight: 900, color: '#fff', letterSpacing: '-0.02em', margin: 0 }}>
            STANDALONE<span style={{ color: '#39FF14', marginLeft: '16px' }}>v1</span>
          </h1>
          <p style={{ marginTop: '8px', fontSize: '11px', fontWeight: 600, letterSpacing: '0.2em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.3)' }}>
            Rust DSP Core · SIMD RealFFT · Hermite Reconstructor
          </p>
        </div>

        {!loading ? (
          <>
            <div
              className={`glass-panel drop-zone${dragging ? ' active' : ''}`}
              style={{
                width: '100%', maxWidth: '600px', padding: '48px 40px',
                display: 'flex', flexDirection: 'column', alignItems: 'center',
                gap: '16px', cursor: 'pointer', borderRadius: '8px',
                border: dragging ? '1px solid #39FF14' : '1px solid rgba(255,255,255,0.08)',
                background: 'rgba(255,255,255,0.01)', transition: 'all 0.2s ease'
              }}
              onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
              onClick={handleSelectFile}
            >
              <FileAudio style={{ width: 52, height: 52, color: dragging ? '#39FF14' : 'rgba(255,255,255,0.3)' }} />
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '13px', fontWeight: 700, color: '#fff', marginBottom: '4px' }}>
                  {dragging ? 'SUELTA EL AUDIO AQUÍ' : 'ARRASTRA UN ARCHIVO DE AUDIO'}
                </div>
                <div className="label-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
                  Formatos: WAV (16/24/32-bit) · MP3 · FLAC
                </div>
              </div>
              <div
                className="btn-primary"
                style={{
                  background: 'rgba(57,255,20,0.1)', color: '#39FF14',
                  border: '1px solid #39FF14', borderRadius: '4px',
                  padding: '8px 16px', display: 'flex', alignItems: 'center', gap: '8px',
                  fontSize: '11px', fontWeight: 900, fontFamily: 'JetBrains Mono, monospace'
                }}
              >
                <Upload style={{ width: 13, height: 13 }} /> Abrir Selector Nativo
              </div>
              {error && (
                <div style={{
                  color: '#FF6666', fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '11px', background: 'rgba(255,68,68,0.08)',
                  border: '1px solid rgba(255,68,68,0.3)', borderRadius: '4px',
                  padding: '12px 16px', width: '100%', boxSizing: 'border-box'
                }}>{error}</div>
              )}
            </div>

            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
              {[
                { icon: Activity, label: 'Symphonia I/O', sub: 'Native WAV/MP3/FLAC decoder' },
                { icon: Zap,      label: 'RealFFT SIMD',  sub: 'SIMD-accelerated real-to-complex FFT' },
                { icon: Cpu,      label: 'Bento Grid UI', sub: 'WebGL log-RTA paged view' },
              ].map(({ icon: Icon, label, sub }) => (
                <div key={label} className="glass-panel" style={{ padding: '10px 16px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', gap: '10px', background: 'rgba(255,255,255,0.02)' }}>
                  <Icon style={{ width: 15, height: 15, color: '#00FFFF' }} />
                  <div>
                    <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', fontWeight: 900, color: '#fff', letterSpacing: '0.15em' }}>{label}</div>
                    <div className="label-xs" style={{ marginTop: 2, color: 'rgba(255,255,255,0.4)' }}>{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          /* ── Opción B: Estado de carga con shimmer indeterminado + mensajes rotativos ── */
          <div className="glass-panel" style={{
            width: '100%', maxWidth: '600px', padding: '48px 40px',
            borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)',
            display: 'flex', flexDirection: 'column', gap: '28px',
            alignItems: 'center', background: 'rgba(255,255,255,0.02)'
          }}>
            {/* Ícono de CPU con rotación continua para señalar actividad */}
            <Cpu style={{ width: 40, height: 40, color: '#39FF14', animation: 'spin-slow 3s linear infinite' }} />

            {/* Mensaje de fase rotativo — cambia cada 1.8s sin saltos bruscos */}
            <div style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: '9px',
              fontWeight: 900, color: '#39FF14', letterSpacing: '0.3em',
              textAlign: 'center', minHeight: '1.4em',
              transition: 'opacity 0.3s ease',
            }}>
              {LOADING_PHASES[phaseIdx]}
            </div>

            {/* Barra indeterminada animada — nunca se detiene visualmente */}
            <div className="progress-scan" style={{ width: '100%' }} />
          </div>
        )}
      </div>

      {/* ── Opción C: Horizonte Espectral Decorativo — generativo, zero audio data ──
          position: absolute para no perturbar el flex layout del contenido principal.
          pointer-events: none garantiza que no capture interacciones del usuario.    ── */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        height: '90px', display: 'flex', alignItems: 'flex-end',
        gap: '2px', padding: '0 4px',
        pointerEvents: 'none', zIndex: 0,
        maskImage: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0.65) 0%, transparent 100%)',
      }}>
        {HORIZON_BARS.map((bar, i) => (
          <div key={i} style={{
            flex: 1,
            height: `${bar.height}px`,
            background: 'linear-gradient(to top, rgba(57,255,20,0.2), rgba(57,255,20,0.03))',
            borderRadius: '1px 1px 0 0',
            transformOrigin: 'bottom',
            animation: `spec-bar-pulse ${bar.dur}s ease-in-out ${bar.delay}s infinite`,
          }} />
        ))}
      </div>
    </div>
  );
}