/**
 * LandingView.jsx — Pantalla de bienvenida y carga de archivos (Con Diálogo Nativo Tauri v2 y Normalización)
 *
 * Pipeline de carga:
 *  1. Invoke cargar_y_analizar_archivo → análisis completo de glitches en Rust
 *  2. Invoke obtener_espectrograma_visible → Vec<u8> binario [u32 frames][u32 bins][u8 payload]
 *  3. Parsear binario → Uint8Array y escribir en SPECTROGRAM_STORAGE (zero-copy, sin React state)
 *  4. Llamar onFileLoaded con solo metadatos (status:'ready') → VostokRestoration monta sin re-fetch
 */
import { useState, useCallback } from 'react';
import { Upload, FileAudio, Zap, Activity, Cpu } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { SPECTROGRAM_STORAGE } from './VostokRestoration.jsx';

export default function LandingView({ onFileLoaded }) {
  const [dragging, setDragging]   = useState(false);
  const [loading, setLoading]     = useState(false);
  const [progress, setProgress]   = useState(0);
  const [phase, setPhase]         = useState('');
  const [error, setError]         = useState(null);

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
      // ── FASE 1: Decodificación y análisis de glitches en Rust ──
      setPhase('DECODIFICANDO Y ANALIZANDO AUDIO (RUST SIMD)...');
      setProgress(0.3);
      const analysis = await invoke('cargar_y_analizar_archivo', { path });
      setProgress(0.7);

      // ── FASE 2: Obtener espectrograma como bytes binarios ──
      setPhase('GENERANDO TEXTURA SPECTRAL VIEWPORT...');
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

      const threshold = analysis.recommended_threshold || 0.25;
      onFileLoaded({
        file,
        fileName:        file.name || path.split('/').pop(),
        filePath:        path,
        duration:        analysis.duration_seconds,
        sampleRate:      analysis.sample_rate,
        channels:        analysis.channels,
        bitDepth:        analysis.bit_depth,
        samples:         null,
        glitches:        analysis.glitches,
        stftFrames:      parsedFrames || analysis.stft_frames,
        stftBins:        parsedBins   || analysis.stft_bins,
        totalStftFrames: analysis.stft_frames,
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

  // Selección nativa mediante Diálogo Tauri v2
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
    <div style={{
      width: '100%', height: '100%',
      display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: '32px', gap: '28px',
      fontFamily: 'var(--font-ui)',
      backgroundColor: '#010101',
      color: '#fff',
    }}>
      {/* HEADER DE MARCA */}
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
          Rust DSP Core · SIMD FFT · Hermite Reconstructor
        </p>
      </div>

      {!loading ? (
        <>
          {/* DROP ZONE */}
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

          {/* TECLA HUD INFO */}
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
            {[
              { icon: Activity, label: 'Symphonia I/O', sub: 'Native WAV/MP3/FLAC decoder' },
              { icon: Zap,      label: 'RustFFT SIMD',  sub: 'SIMD-accelerated forward FFT' },
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
        /* LOADING STATE */
        <div className="glass-panel" style={{ width: '100%', maxWidth: '600px', padding: '48px 40px', borderRadius: '8px', border: '1px solid rgba(255,255,255,0.08)', display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'center', background: 'rgba(255,255,255,0.02)' }}>
          <Cpu style={{ width: 40, height: 40, color: '#39FF14' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', fontWeight: 900, color: '#39FF14', letterSpacing: '0.3em', marginBottom: '8px' }}>
              {phase}
            </div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '2.5rem', fontWeight: 900, color: '#fff' }}>
              {Math.round(progress * 100)}<span style={{ fontSize: '1.2rem', color: '#39FF14' }}>%</span>
            </div>
          </div>
          <div style={{ width: '100%', height: '4px', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ width: `${progress * 100}%`, height: '100%', backgroundColor: '#39FF14', transition: 'width 0.2s' }} />
          </div>
        </div>
      )}
    </div>
  );
}
