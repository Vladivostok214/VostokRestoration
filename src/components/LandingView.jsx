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
        const audioVersion = Number(dv.getBigUint64(8, true));
        parsedMatrix = new Uint8Array(buffer, byteOffset + 16, parsedFrames * parsedBins);
        console.log(`[LandingView] Espectrograma: ${parsedFrames} frames × ${parsedBins} bins | Version: ${audioVersion}`);
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
        audioVersion:    analysis.audio_version,
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
      backgroundColor: 'var(--vostok-black)',
      fontFamily: 'var(--font-ui)',
      color: '#fff',
    }}>
      <div className="app-noise-overlay" />

      {/* ── CIRCUIT CONNECTORS (Inspirado en Imagen de Referencia 2 - Holographic/SOTA Lines) ── */}
      <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}>
        {/* Líneas finas conectando áreas */}
        <path d="M 120 250 L 320 250 L 380 300 L 380 450" fill="none" stroke="rgba(82, 255, 60, 0.09)" strokeWidth="1" />
        <path d="M 100 250 H 50" fill="none" stroke="rgba(82, 255, 60, 0.05)" strokeWidth="1" />
        <path d="M 320 250 L 300 270" fill="none" stroke="rgba(82, 255, 60, 0.09)" strokeWidth="1" />
        
        <path d="M 820 180 L 1020 180 L 1070 230 L 1070 550" fill="none" stroke="rgba(82, 255, 60, 0.09)" strokeWidth="1" />
        <path d="M 1020 180 L 1000 200" fill="none" stroke="rgba(82, 255, 60, 0.09)" strokeWidth="1" />
        
        <path d="M 250 620 L 450 620 L 500 570" fill="none" stroke="rgba(82, 255, 60, 0.07)" strokeWidth="1" />

        {/* Nodos de intersección brillantes con sutil halo */}
        <circle cx="320" cy="250" r="3.5" fill="var(--vostok-green)" style={{ filter: 'drop-shadow(0 0 4px var(--vostok-green))', opacity: 0.7 }} />
        <circle cx="380" cy="300" r="2" fill="var(--vostok-green)" style={{ opacity: 0.5 }} />
        <circle cx="1020" cy="180" r="3.5" fill="var(--vostok-green)" style={{ filter: 'drop-shadow(0 0 4px var(--vostok-green))', opacity: 0.7 }} />
        <circle cx="1070" cy="230" r="2" fill="var(--vostok-green)" style={{ opacity: 0.5 }} />
        <circle cx="450" cy="620" r="3" fill="var(--vostok-green)" style={{ filter: 'drop-shadow(0 0 4px var(--vostok-green))', opacity: 0.6 }} />
      </svg>

      {/* ── Contenido principal: z-index 1 para quedar sobre el horizonte espectral ── */}
      <div style={{
        position: 'relative', zIndex: 1,
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        padding: '32px', gap: '32px',
      }}>
        {/* Encabezado */}
          <div style={{ textAlign: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginBottom: '8px' }}>
              <div className="dot-pulse-green" style={{ width: 6, height: 6 }} />
              <span style={{ fontFamily: 'var(--font-ui)', fontSize: '10px', fontWeight: 900, letterSpacing: '0.4em', color: 'var(--vostok-green)' }}>
                VOSTOK LABS
              </span>
              <div className="dot-pulse-green" style={{ width: 6, height: 6 }} />
            </div>
            <h1 style={{ fontFamily: 'var(--font-ui)', fontSize: '3.2rem', fontWeight: 900, color: '#fff', letterSpacing: '-0.03em', margin: 0, textShadow: '0 0 40px rgba(255,255,255,0.05)' }}>
              RESTORATION<span style={{ color: 'var(--vostok-green)', marginLeft: '16px' }}>v1</span>
            </h1>
          <p style={{ marginTop: '8px', fontSize: '10px', fontWeight: 700, letterSpacing: '0.22em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.35)' }}>
            CARGA · ANALIZA · REPARA
          </p>
        </div>

        {!loading ? (
          <>
            {/* Contenedor relativo para posicionar el corner-badge de la Imagen 2 */}
            <div style={{ position: 'relative', width: '100%', maxWidth: '600px' }} className="fade-in">
              
              {/* Corner Badge overlapping the border */}

              <div
                className={`glass-panel drop-zone${dragging ? ' active' : ''}`}
                style={{
                  padding: '48px 40px',
                  display: 'flex', flexDirection: 'column', alignItems: 'center',
                  gap: '20px', cursor: 'pointer', borderRadius: '8px',
                  border: dragging ? '1px solid var(--vostok-green)' : '1px solid var(--vostok-border)',
                  background: dragging ? 'rgba(82, 255, 60, 0.03)' : 'rgba(14, 20, 26, 0.45)',
                  transition: 'all 0.25s cubic-bezier(0.4, 0, 0.2, 1)'
                }}
                onDrop={handleDrop} onDragOver={handleDragOver} onDragLeave={handleDragLeave}
                onClick={handleSelectFile}
              >
                <FileAudio style={{ width: 56, height: 56, color: dragging ? 'var(--vostok-green)' : 'rgba(0, 245, 255, 0.20)', transition: 'color 0.2s' }} />
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: '13px', fontWeight: 900, color: '#fff', marginBottom: '6px', letterSpacing: '0.08em' }}>
                      {dragging ? 'SUELTA EL AUDIO AQUÍ' : 'ARRASTRA UN ARCHIVO DE AUDIO'}
                    </div>
                  <div className="label-xs" style={{ color: 'rgba(255,255,255,0.4)', fontSize: '8px' }}>
                    Formatos soportados: WAV (16/24/32-bit) · MP3 · FLAC
                  </div>
                </div>
                <div
                  className="btn-primary"
                  style={{
                    borderRadius: 'var(--radius-md)',
                    padding: '10px 20px',
                    display: 'flex', alignItems: 'center', gap: '8px'
                  }}
                >
                  <Upload style={{ width: 13, height: 13 }} /> Cargar Archivo
                </div>
                {error && (
                  <div style={{
                    color: 'var(--vostok-pink)', fontFamily: 'var(--font-mono)',
                    fontSize: '11px', background: 'rgba(255,81,141,0.06)',
                    border: '1px solid rgba(255,81,141,0.25)', borderRadius: 'var(--radius-sm)',
                    padding: '12px 16px', width: '100%', boxSizing: 'border-box',
                    textAlign: 'center', marginTop: '8px'
                  }}>{error}</div>
                )}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', justifyContent: 'center' }} className="fade-in">
              {[
                { icon: Activity, label: 'Symphonia I/O', sub: 'Native decoder engine', color: 'var(--vostok-cyan)' },
                { icon: Zap,      label: 'RealFFT SIMD',  sub: 'SIMD-accelerated FFT', color: 'var(--vostok-green)' },
                { icon: Cpu,      label: 'MODERN UI', sub: 'WebGL log-RTA paged view', color: 'var(--vostok-amber)' },
              ].map(({ icon: Icon, label, sub, color }) => (
                <div key={label} className="glass-panel glass-panel--interactive" style={{ padding: '12px 20px', borderRadius: 'var(--radius-md)', border: '1px solid var(--vostok-border)', display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(14, 20, 26, 0.4)' }}>
                  <Icon style={{ width: 16, height: 16, color: color }} />
                  <div>
                    <div style={{ fontFamily: 'var(--font-ui)', fontSize: '9px', fontWeight: 900, color: '#fff', letterSpacing: '0.12em' }}>{label}</div>
                    <div className="label-xs" style={{ marginTop: 2, color: 'rgba(255,255,255,0.4)', fontSize: '8px' }}>{sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </>
        ) : (
          /* ── Opción B: Estado de carga con shimmer indeterminado + mensajes rotativos ── */
          <div style={{ position: 'relative', width: '100%', maxWidth: '600px' }} className="fade-in">
            
            {/* Corner Badge matching Reference Image 2 */}
            <div style={{
              position: 'absolute',
              top: '-10px',
              left: '24px',
              background: 'var(--vostok-cyan)',
              color: 'var(--vostok-black)',
              fontFamily: 'var(--font-mono)',
              fontSize: '8.5px',
              fontWeight: '900',
              padding: '3px 10px',
              borderRadius: '100px',
              boxShadow: '0 0 15px rgba(0, 245, 255, 0.4)',
              zIndex: 10,
              letterSpacing: '0.08em',
              display: 'flex',
              alignItems: 'center',
              gap: '4px'
            }}>
              <Cpu className="spinning" size={10} style={{ animationDuration: '4s' }} /> ANALYZING
            </div>

            <div className="glass-panel" style={{
              padding: '48px 40px',
              borderRadius: 'var(--radius-lg)',
              display: 'flex', flexDirection: 'column', gap: '28px',
              alignItems: 'center', background: 'rgba(14, 20, 26, 0.5)'
            }}>
              {/* Ícono de CPU con rotación continua para señalar actividad */}
              <Cpu style={{ width: 44, height: 44, color: 'var(--vostok-cyan)', animation: 'spin-slow 3s linear infinite', filter: 'drop-shadow(0 0 10px rgba(0, 245, 255, 0.3))' }} />

              {/* Mensaje de fase rotativo — cambia cada 1.8s sin saltos bruscos */}
              <div style={{
                fontFamily: 'var(--font-mono)', fontSize: '9px',
                fontWeight: 900, color: 'var(--vostok-cyan)', letterSpacing: '0.3em',
                textAlign: 'center', minHeight: '1.4em',
                transition: 'opacity 0.3s ease',
              }}>
                {LOADING_PHASES[phaseIdx]}
              </div>

              {/* Barra indeterminada animada — nunca se detiene visualmente */}
              <div className="progress-scan" style={{ width: '100%' }} />
            </div>
          </div>
        )}
      </div>

      {/* ── Opción C: Horizonte Espectral Decorativo — generativo con gradiente multicolor (Imagen 1 & 3) ── */}
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        height: '100px', display: 'flex', alignItems: 'flex-end',
        gap: '2px', padding: '0 4px',
        pointerEvents: 'none', zIndex: 0,
        maskImage: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)',
        WebkitMaskImage: 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, transparent 100%)',
      }}>
        {HORIZON_BARS.map((bar, i) => {
          // Barrido multicolor progresivo (Azul -> Cian -> Verde -> Amber -> Hot Pink)
          const pct = i / HORIZON_BARS.length;
          let color1 = 'rgba(40, 96, 235, 0.3)';   // --vostok-blue
          let color2 = 'rgba(40, 96, 235, 0.02)';
          if (pct > 0.2 && pct <= 0.45) {
            color1 = 'rgba(0, 245, 255, 0.3)';    // --vostok-cyan
            color2 = 'rgba(0, 245, 255, 0.02)';
          } else if (pct > 0.45 && pct <= 0.7) {
            color1 = 'rgba(82, 255, 60, 0.3)';    // --vostok-green
            color2 = 'rgba(82, 255, 60, 0.02)';
          } else if (pct > 0.7 && pct <= 0.88) {
            color1 = 'rgba(255, 159, 10, 0.3)';   // --vostok-amber
            color2 = 'rgba(255, 159, 10, 0.02)';
          } else if (pct > 0.88) {
            color1 = 'rgba(255, 81, 141, 0.3)';   // --vostok-pink
            color2 = 'rgba(255, 81, 141, 0.02)';
          }

          return (
            <div key={i} style={{
              flex: 1,
              height: `${bar.height}px`,
              background: `linear-gradient(to top, ${color1}, ${color2})`,
              borderRadius: '2px 2px 0 0',
              transformOrigin: 'bottom',
              animation: `spec-bar-pulse ${bar.dur}s ease-in-out ${bar.delay}s infinite`,
            }} />
          );
        })}
      </div>
    </div>
  );
}