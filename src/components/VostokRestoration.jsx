/**
 * VostokRestoration.jsx — Componente Workspace Principal para la App Standalone (Tauri + Rust)
 *
 * Utiliza Bento Grid (Noir-Tech), fondo #010101, acentos en #39FF14.
 * Conecta los controles de zoom/scroll con la API IPC de Tauri.
 *
 * REFACTOR v2 (Paso 2.0 del Mapa de Optimización):
 *   Toda la lógica de detección y reparación de glitches se desacoplé al hook
 *   useGlitchManager (src/hooks/useGlitchManager.js).
 *   Este componente gestiona exclusivamente: viewport, playback y transporte de audio.
 */
import { useState, useEffect, useRef, useCallback, useMemo, memo } from 'react';
import { ArrowLeft, Download, FileText, Zap, Cpu, Play, Pause, Square, ChevronDown, Undo, Redo, Maximize2, Minimize2, Settings, Eye, EyeOff, Activity, Sparkles, Compass, Move, Crop } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import SpectrogramGL from './SpectrogramGL.jsx';
import TimelineScrubber from './TimelineScrubber.jsx';
import VerticalScrubber from './VerticalScrubber.jsx';

// ── IMPORTACIÓN DE LA MEMORIA AISLADA ──
import { SPECTROGRAM_STORAGE } from './spectrogramStore.js';

// ── HOOK DE GESTIÓN DE GLITCHES ──
import useGlitchManager from '../hooks/useGlitchManager.js';

export default function VostokRestoration({ session, updateSession, onReset }) {
  const {
    fileName,
    duration,
    sampleRate,
    bitDepth,
    glitches,
    stftFrames,
    stftBins,
    threshold,
    status,
    matrixVersion,
    waveformEnvelope,
    channels,
    loopStart,
    loopEnd
  } = session;

  // ── VIEWPORT: Navegación reactiva ultra-fluida (0.0 a 1.0) ──
  const [viewStart, setViewStart]   = useState(0.0);
  const [viewEnd, setViewEnd]       = useState(1.0);
  const [viewYStart, setViewYStart] = useState(0.0);
  const [viewYEnd, setViewYEnd]     = useState(1.0);

  // ── PLAYBACK: Control de audio local ──
  const [isPlaying, setIsPlaying]         = useState(false);
  const [playheadTime, setPlayheadTime]   = useState(0);
  const [isCanvasReady, setIsCanvasReady] = useState(false);
  const [followPlayhead, setFollowPlayhead] = useState(true);
  const [spectrogramMode, setSpectrogramMode] = useState('full'); // 'full' | 'local_hd'

  // ── SPECTROGRAM CONTROLS (iZotope RX Inspiration) ──
  const [dbFloor, setDbFloor]             = useState(-60.0);
  const [dbCeiling, setDbCeiling]         = useState(0.0);
  const [scaleMode, setScaleMode]         = useState(1); // 1 = Mel, 3 = Bark, 2 = Log, 0 = Linear
  const [waveformOpacity, setWaveformOpacity] = useState(0.0);
  const [isDetectorExpanded, setIsDetectorExpanded] = useState(true);
  const [isInspectorExpanded, setIsInspectorExpanded] = useState(true);
  const [isDetectorHovered, setIsDetectorHovered] = useState(false);
  const [isInspectorHovered, setIsInspectorHovered] = useState(false);
  const [toolMode, setToolMode]                       = useState('navigate'); // 'navigate' | 'select'
  const [isMaximized, setIsMaximized]                 = useState(false);

  // ── UI: Notificaciones toast ──
  const [toasts, setToasts] = useState([]);
  const [hiddenGlitches, setHiddenGlitches] = useState(new Set());
  const [showAdvanced, setShowAdvanced] = useState(false);

  const animationRef  = useRef(null);
  const playStartRef  = useRef(0);
  const audioStartRef = useRef(0);
  const playheadStartOffsetRef = useRef(0);

  const showToast = useCallback((msg) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, msg }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 3000);
  }, []);

  // ── HOOK DE GLITCHES: Estado y acciones desacoplados ──
  const {
    selectedGlitch,
    healingProgress,
    globalHealingProgress,
    config,
    setConfig,
    scanParams,
    setScanParams,
    pendingGlitchesCount,
    selectedGlitchIdx,
    scanAudio,
    healGlitch,
    healAll,
    healSelection,
    selectGlitch,
    discardGlitch,
    undo,
    redo,
  } = useGlitchManager(session, updateSession, showToast, () => setIsPlaying(false));

  // Monitorear y registrar renderización de la vista de onda
  useEffect(() => {
    if (matrixVersion > 1) {
      console.log(
        `%c[VOSTOK RENDERING] VISTA DE ONDA ACTUALIZADA\n` +
        `• Envolvente     : Recalculada (1000 picos de amplitud)\n` +
        `• Timeline Scrubber: Renderizado de vector SVG finalizado`,
        'color: #FFFF00; font-weight: bold;'
      );
    }
  }, [matrixVersion]);

  const lastSelectedGlitchRef = useRef(null);
  useEffect(() => {
    if (selectedGlitch && duration > 0 && selectedGlitch !== lastSelectedGlitchRef.current) {
      lastSelectedGlitchRef.current = selectedGlitch;
      const glitchDurationSecs = selectedGlitch.duration_samples ? selectedGlitch.duration_samples / sampleRate : 0.05;
      const zoomWidthSecs = Math.max(0.5, glitchDurationSecs * 2.5);
      const centerSecs = selectedGlitch.time_secs + glitchDurationSecs / 2;
      
      let startSecs = centerSecs - zoomWidthSecs / 2;
      let endSecs = centerSecs + zoomWidthSecs / 2;
      
      const newStart = Math.max(0, startSecs / duration);
      const newEnd = Math.min(1, endSecs / duration);
      
      setViewStart(newStart);
      setViewEnd(newEnd);
      setFollowPlayhead(false);
      
      // Zoom vertical para Hum/Hiss
      if ((selectedGlitch.event_type === 'hum' || selectedGlitch.event_type === 'hiss') && selectedGlitch.frequency) {
        const Nyquist = sampleRate / 2;
        const lowFreq = Math.max(0, selectedGlitch.frequency - 150);
        const highFreq = Math.min(Nyquist, selectedGlitch.frequency + 150);
        setViewYStart(lowFreq / Nyquist);
        setViewYEnd(highFreq / Nyquist);
      } else {
        setViewYStart(0.0);
        setViewYEnd(1.0);
      }
    } else if (!selectedGlitch && lastSelectedGlitchRef.current) {
      lastSelectedGlitchRef.current = null;
      setViewStart(0.0);
      setViewEnd(1.0);
      setViewYStart(0.0);
      setViewYEnd(1.0);
    }
  }, [selectedGlitch, duration, sampleRate]);

  // ── PUENTES CONTROLADORES DE LOS SCRUBBERS ──
  const restaurarEspectrogramaCompleto = useCallback(() => {
    if (!SPECTROGRAM_STORAGE.full) return;
    const t0 = performance.now();
    SPECTROGRAM_STORAGE.hum = SPECTROGRAM_STORAGE.full;
    setSpectrogramMode('full');

    const targetFrames = session.totalStftFrames || 2048;
    const targetBins = session.totalStftBins || 2048;

    updateSession({
      stftFrames: targetFrames,
      stftBins: targetBins,
      matrixVersion: matrixVersion + 1
    });
    console.log(`[PROF][FULL] restaurar_completo | frames=${targetFrames} bins=${targetBins} | elapsed=${(performance.now()-t0).toFixed(2)}ms (sin IPC, desde storage)`);
  }, [session.totalStftFrames, session.totalStftBins, matrixVersion, updateSession]);

  const handleReRenderLocal = useCallback(async () => {
    if (status !== 'ready' || !fileName) return;

    const currentWidth = viewEnd - viewStart;
    if (currentWidth >= 0.99) {
      showToast('Zoom no activo. Selecciona un fragmento para aplicar enfoque HD.');
      return;
    }

    try {
      showToast('Calculando Enfoque HD local...');
      updateSession({ status: 'analyzing' });

      const t_ipc_start = performance.now();
      const stftRes = await invoke('obtener_espectrograma_dinamico', {
        viewStart,
        viewEnd,
        maxWidth: 2048
      });
      const t_ipc_end = performance.now();
      console.log(`[PROF][HD] IPC_roundtrip | elapsed=${(t_ipc_end - t_ipc_start).toFixed(2)}ms | payload_bytes=${stftRes?.byteLength ?? stftRes?.length ?? '?'}`);

      const t_parse = performance.now();
      let buffer, byteOffset, byteLength;
      if (stftRes instanceof ArrayBuffer) {
        buffer     = stftRes;
        byteOffset = 0;
        byteLength = stftRes.byteLength;
      } else {
        const view = ArrayBuffer.isView(stftRes) ? stftRes : new Uint8Array(stftRes);
        buffer     = view.buffer;
        byteOffset = view.byteOffset;
        byteLength = view.byteLength;
      }

      const dv     = new DataView(buffer, byteOffset, byteLength);
      const frames = dv.getUint32(0, true);
      const bins   = dv.getUint32(4, true);
      const audio_version = Number(dv.getBigUint64(8, true));
      const matrix = new Uint8Array(buffer, byteOffset + 16, frames * bins);
      console.log(`[PROF][HD] parse_binary | elapsed=${(performance.now() - t_parse).toFixed(2)}ms | frames=${frames} bins=${bins}`);

      if (audio_version !== session.audioVersion) {
        console.warn(`[VOSTOK] Descartando espectrograma HD obsoleto (Respuesta: v${audio_version}, Actual: v${session.audioVersion})`);
        updateSession({ status: 'ready' });
        return;
      }

      const t_store = performance.now();
      SPECTROGRAM_STORAGE.hum = matrix;
      setSpectrogramMode('local_hd');
      console.log(`[PROF][HD] storage_write | elapsed=${(performance.now() - t_store).toFixed(2)}ms`);

      const t_session = performance.now();
      updateSession({
        stftFrames: frames,
        stftBins: bins,
        matrixVersion: matrixVersion + 1,
        status: 'ready'
      });
      console.log(`[PROF][HD] updateSession_trigger | elapsed=${(performance.now() - t_session).toFixed(2)}ms`);
      console.log(`[PROF][HD] TOTAL_FRONTEND | elapsed=${(performance.now() - t_ipc_start).toFixed(2)}ms | viewRange=[${viewStart.toFixed(3)}-${viewEnd.toFixed(3)}]`);

      showToast('Enfoque HD calculado con éxito');
    } catch (err) {
      console.warn('[VOSTOK] Fallo al adaptar STFT local:', err);
      updateSession({ status: 'ready' });
      showToast('Error al procesar render HD');
    }
  }, [viewStart, viewEnd, status, fileName, duration, matrixVersion, updateSession, showToast]);

  const handleViewportChange = useCallback((start, end) => {
    setViewStart(start);
    setViewEnd(end);
    setFollowPlayhead(false); // Detener el auto-scroll si el usuario interactúa manualmente
    
    // Si estábamos en modo Local HD, restaurar la STFT completa de forma instantánea al mover la vista
    if (spectrogramMode === 'local_hd') {
      restaurarEspectrogramaCompleto();
    }
  }, [spectrogramMode, restaurarEspectrogramaCompleto]);

  const handleViewportYChange = useCallback((start, end) => {
    setViewYStart(start);
    setViewYEnd(end);
  }, []);

  const handleScanAudio = async () => {
    setIsDetectorExpanded(false);
    setIsInspectorExpanded(true);
    await scanAudio();
  };

  const handleToggleVisibility = useCallback((sampleIndex) => {
    setHiddenGlitches(prev => {
      const next = new Set(prev);
      if (next.has(sampleIndex)) {
        next.delete(sampleIndex);
      } else {
        next.add(sampleIndex);
      }
      return next;
    });
  }, []);

  const visibleGlitches = useMemo(() => {
    return glitches.map((g, i) => ({ ...g, originalIdx: i })).filter(g => !hiddenGlitches.has(g.sample_index));
  }, [glitches, hiddenGlitches]);

  const handleRenderComplete = useCallback(() => {
    if (!isCanvasReady) setIsCanvasReady(true);
  }, [isCanvasReady]);

  // Sincronizar estado del Canvas WebGL cuando los metadatos y la matriz estén listos
  useEffect(() => {
    if (status === 'ready' && SPECTROGRAM_STORAGE['hum']) {
      setIsCanvasReady(true);
    }
  }, [status, matrixVersion]);



  // Constant for fixed audio output latency compensation (set to 0.0 to start playhead instantly)
  const PLAYBACK_LATENCY_SEC = 0.0;

  // Refs de sincronización de viewport para el loop de animación (evitan re-crear el callback)
  const viewStartRef = useRef(viewStart);
  const viewEndRef = useRef(viewEnd);
  viewStartRef.current = viewStart;
  viewEndRef.current = viewEnd;

  const followPlayheadRef = useRef(followPlayhead);
  followPlayheadRef.current = followPlayhead;

  const loopStartRef = useRef(loopStart);
  const loopEndRef = useRef(loopEnd);
  loopStartRef.current = loopStart;
  loopEndRef.current = loopEnd;

  // Loop de reproducción simulado de alta precisión temporal
  const updatePlayhead = useCallback(() => {
    if (!isPlaying) return;
    const now     = performance.now() / 1000;
    const elapsed = now - playStartRef.current;
    
    // Evitamos valores negativos o retrocesos durante la ventana de compensación de latencia
    let current = audioStartRef.current + Math.max(0, elapsed);

    const targetEnd = (loopEndRef.current !== undefined && loopEndRef.current > 0) ? loopEndRef.current : duration;
    const targetStart = (loopStartRef.current !== undefined) ? loopStartRef.current : 0.0;

    if (current >= targetEnd) {
      current = targetStart;
      playStartRef.current = now;
      audioStartRef.current = current;
      
      invoke('toggle_playback', { timeSecs: current }).catch(err => {
        console.error('Error seeking playback on loop:', err);
      });
    }

    setPlayheadTime(current);

    // Auto-scroll de alto rendimiento en modo zoom (Page Scroll / Threshold Scroll)
    const playheadPercent = duration > 0 ? (current / duration) : 0;
    const vStart = viewStartRef.current;
    const vEnd = viewEndRef.current;
    const vWidth = vEnd - vStart;
    
    if (followPlayheadRef.current && vWidth < 0.99) {
      // Calcular posición relativa de la aguja en el viewport actual (0.0 a 1.0)
      const relPercent = (playheadPercent - vStart) / vWidth;

      // Si la aguja se sale del viewport visible (mayor al 95% o menor al 0%)
      if (relPercent > 0.95 || relPercent < 0.0) {
        // Hacemos scroll de página centrando la aguja al 10% del viewport visible
        let newStart = playheadPercent - vWidth * 0.1;
        let newEnd = newStart + vWidth;

        if (newStart < 0) {
          newStart = 0;
          newEnd = vWidth;
        } else if (newEnd > 1.0) {
          newEnd = 1.0;
          newStart = 1.0 - vWidth;
        }
        
        setViewStart(newStart);
        setViewEnd(newEnd);
      }
    }

    animationRef.current = requestAnimationFrame(updatePlayhead);
  }, [isPlaying, duration]);

  useEffect(() => {
    if (isPlaying) {
      playStartRef.current  = (performance.now() / 1000) - playheadStartOffsetRef.current;
      audioStartRef.current = playheadTime;
      animationRef.current  = requestAnimationFrame(updatePlayhead);
    } else {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    }
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [isPlaying, updatePlayhead]);

  // Garantizar el apagado del hardware al desmontar el componente (VHRP)
  useEffect(() => {
    return () => {
      invoke('stop_playback').catch(err => {
        console.warn('[VOSTOK] Error al silenciar hardware al desmontar VostokRestoration:', err);
      });
    };
  }, []);

  // ── HANDLERS DE TRANSPORTE DE AUDIO NATIVO ──
  const handlePlayPause = useCallback(async () => {
    if (status !== 'ready') return;
    try {
      const timeToPlay   = isPlaying ? null : playheadTime;
      const newIsPlaying = await invoke('toggle_playback', { timeSecs: timeToPlay });
      
      if (newIsPlaying) {
        // Compensamos la latencia fija del hardware de audio (45ms) de manera constante e invariable
        playheadStartOffsetRef.current = -PLAYBACK_LATENCY_SEC;
        setFollowPlayhead(true); // Reactivar auto-scroll al dar play
      } else {
        playheadStartOffsetRef.current = 0;
      }

      setIsPlaying(newIsPlaying);
      console.log(
        `%c[VOSTOK PLAYBACK] ESTADO DE REPRODUCCIÓN\n` +
        `• Acción         : ${newIsPlaying ? 'INICIAR' : 'PAUSAR'}\n` +
        `• Posición (sec) : ${playheadTime.toFixed(4)}s\n` +
        `• Dispositivo    : Rodio Output Sink Activo`,
        'color: #FF00FF; font-weight: bold;'
      );
    } catch (err) {
      console.error('Error toggling playback:', err);
      showToast(`Error en motor de audio: ${err}`);
    }
  }, [isPlaying, playheadTime, status, showToast]);

  const handleStop = async () => {
    if (status !== 'ready') return;
    try {
      await invoke('stop_playback');
      playheadStartOffsetRef.current = 0;
      setIsPlaying(false);
      setPlayheadTime(0);
      console.log(
        `%c[VOSTOK PLAYBACK] REPRODUCCIÓN DETENIDA\n` +
        `• Estado         : Reset (Playhead en 0.0s)`,
        'color: #FF00FF; font-weight: bold;'
      );
    } catch (err) {
      console.error('Error stopping playback:', err);
      showToast(`Error al detener: ${err}`);
    }
  };

  const handleSeek = useCallback(async (timeInSecs) => {
    const newTime = Math.max(0, Math.min(timeInSecs, duration));
    
    if (isPlaying) {
      try {
        await invoke('toggle_playback', { timeSecs: newTime });
        // Compensamos la latencia fija del hardware de audio (45ms) de manera constante e invariable
        playheadStartOffsetRef.current = -PLAYBACK_LATENCY_SEC;
        playStartRef.current = performance.now() / 1000;
        audioStartRef.current = newTime;
        setPlayheadTime(newTime);
      } catch (err) {
        console.error('Error seeking playback:', err);
        showToast(`Error en motor de audio: ${err}`);
      }
    } else {
      setPlayheadTime(newTime);
    }

    console.log(
      `%c[VOSTOK PLAYBACK] SEEK PLAYHEAD\n` +
      `• Posición Nueva : ${newTime.toFixed(4)}s / ${duration.toFixed(4)}s`,
      'color: #FF8800; font-weight: bold;'
    );
  }, [duration, isPlaying, showToast]);



  // Atajo de teclado: Play/Pause, Undo y Redo
  useEffect(() => {
    const handleKeyDown = (e) => {
      const el = document.activeElement;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          redo();
        } else {
          undo();
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlayPause, undo, redo]);

  const handleExportFile = async () => {
    if (status !== 'ready') return;
    try {
      const targetPath = await save({
        filters:     [{ name: 'Audio WAV', extensions: ['wav'] }],
        defaultPath: 'restored_' + fileName,
      });
      if (!targetPath) return;
      showToast('Exportando archivo nativo...');
      await invoke('export_repaired_file', { path: targetPath });
      showToast('Archivo maestro guardado con éxito');
    } catch (err) {
      console.error(err);
      showToast('Error al escribir el contenedor WAV');
    }
  };

  // ── REPORTE DE ANÁLISIS FORENSE ──────────────────────────────────────────
  // Genera y guarda un archivo .txt con metadata del archivo, resumen del
  // análisis y detalle timecodeado de cada anomalía. (Nativo OS vía Tauri)
  const handleDownloadReport = async () => { // <-- Añadimos 'async' aquí
    if (status !== 'ready' || glitches.length === 0) return;

    const now        = new Date();
    const dateStr    = now.toISOString().slice(0, 10);
    const timeStr    = now.toTimeString().slice(0, 8);
    const channels   = session.channels === 1 ? '1 (Mono)' : session.channels === 2 ? '2 (Stereo)' : `${session.channels}`;
    const repaired   = glitches.filter(g => g.repaired);
    const pending    = glitches.filter(g => !g.repaired);

    // ── Helpers de formato ──
    const pad   = (n, w = 2) => String(n).padStart(w, '0');
    const toTC  = (secs) => {
      const m = Math.floor(secs / 60);
      const s = (secs % 60).toFixed(3);
      return `${pad(m)}:${s.length < 6 ? '0' + s : s}`;
    };
    const chMap = { 0: 'L', 1: 'R', 2: 'Ambos' };
    const typeFmt = (t) => (t || 'CLICK').toUpperCase().padEnd(7);
    const sep    = '═'.repeat(60);
    const div    = '─'.repeat(60);

    // ── Detalle de eventos ──
    const eventLines = glitches.map((g, i) => {
      const estado  = g.repaired ? 'REPARADO ' : 'PENDIENTE';
      const startSecs   = g.time_secs ?? 0;
      const startTc     = toTC(startSecs);
      const evType      = (g.event_type || '').toLowerCase();
      const durationSecs = (g.duration_samples && sampleRate > 0)
        ? g.duration_samples / sampleRate
        : 0;
      const showRange =
        evType === 'hum' ||
        evType === 'hiss' ||
        (evType === 'dropout' && durationSecs > 2.0);
      const tc = (showRange && durationSecs > 0)
        ? `${startTc} -> ${toTC(startSecs + durationSecs)}`
        : startTc;
      const tipo    = typeFmt(g.event_type);
      const canal   = (chMap[g.channel] ?? String(g.channel)).padEnd(5);
      const mag     = (g.amplitude_delta ?? 0).toFixed(5);
      const freq    = g.frequency ? `${g.frequency.toFixed(1)} Hz` : '—';
      return `  [${pad(i + 1, 2)}] ${estado} | ${tc} | ${tipo} | Canal: ${canal} | ΔV: ${mag} | ${freq}`;
    }).join('\n');

    const report = [
      sep,
      '  VOSTOK RESTORATION v1 — REPORTE DE ANÁLISIS FORENSE',
      sep,
      '',
      `  Archivo     : ${fileName}`,
      `  Ruta        : ${session.filePath || '—'}`,
      `  Duración    : ${(duration || 0).toFixed(3)}s`,
      `  Sample Rate : ${sampleRate} Hz`,
      `  Bit Depth   : ${bitDepth}-bit`,
      `  Canales     : ${channels}`,
      `  Fecha       : ${dateStr}  ${timeStr}`,
      '',
      div,
      '  RESUMEN DE ANÁLISIS',
      div,
      `  Anomalías detectadas  : ${glitches.length}`,
      `  Reparadas             : ${repaired.length}`,
      `  Pendientes            : ${pending.length}`,
      '',
      div,
      '  DETALLE POR EVENTO',
      div,
      '',
      eventLines,
      '',
      sep,
      '  Generado por Vostok Restoration v1 · Rust DSP Core · SIMD RealFFT',
      sep,
      '',
    ].join('\n');

    // ── Descarga Nativa OS (Tauri IPC) ──
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    
    try {
      const filePath = await save({
        defaultPath: `${baseName}_restoration_report.txt`,
        filters: [{
          name: 'Reporte de Auditoría',
          extensions: ['txt']
        }]
      });

      if (!filePath) return; // El usuario canceló el diálogo

      await invoke('guardar_reporte_auditoria', { 
        path: filePath, 
        content: report 
      });

      showToast('Reporte de análisis guardado con éxito');
    } catch (error) {
      console.error("Error de I/O al guardar el reporte:", error);
      showToast('Error al guardar el reporte');
    }
  };

  const renderInspectorParameters = () => {
    if (selectedGlitch.repaired) {
      return (
        <div style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          background: 'rgba(82, 255, 60, 0.04)',
          padding: '16px',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid rgba(82, 255, 60, 0.2)',
          textAlign: 'center'
        }}>
          <span style={{ color: 'var(--vostok-green)', fontSize: '11px', fontWeight: 900, letterSpacing: '0.05em' }}>
            ✓ ESTA ANOMALÍA YA FUE REPARADA CON ÉXITO
          </span>
          <span style={{ color: 'rgba(255, 255, 255, 0.4)', fontSize: '9px' }}>
            Los cambios se han consolidado en el buffer de audio.
          </span>
        </div>
      );
    }

    const type = (selectedGlitch.event_type || 'click').toLowerCase();

    if (type === 'hum') {
      const freq = selectedGlitch.frequency;
      const freqStr = freq ? `${freq.toFixed(1)} Hz` : '50/60 Hz (Fundamental)';
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(0, 245, 255, 0.02)', padding: '12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(0, 245, 255, 0.2)' }}>
          <div style={{ fontSize: '10px', color: 'var(--vostok-cyan)', fontWeight: 'bold', letterSpacing: '0.05em' }}>PARÁMETROS DE REPARACIÓN (HUM)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Frecuencia:</span>
              <span style={{ color: 'var(--vostok-cyan)', fontWeight: 'bold' }}>{freqStr}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Algoritmo:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>Filtro Notch IIR en Fundamental + 2 Armónicos</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Q-Factor:</span>
              <span style={{ color: '#fff' }}>50.0 (Ultra-estrecho)</span>
            </div>
          </div>
        </div>
      );
    }

    if (type === 'hiss') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(40, 96, 235, 0.02)', padding: '12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(40, 96, 235, 0.2)' }}>
          <div style={{ fontSize: '10px', color: 'var(--vostok-blue)', fontWeight: 'bold', letterSpacing: '0.05em' }}>PARÁMETROS DE REPARACIÓN (HISS)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Filtro:</span>
              <span style={{ color: 'var(--vostok-blue)', fontWeight: 'bold' }}>High-Shelf (5000 Hz)</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Atenuación:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>-12.0 dB</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Modo:</span>
              <span style={{ color: '#fff' }}>Filtro de fase lineal</span>
            </div>
          </div>
        </div>
      );
    }

    if (type === 'distortion') {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: 'rgba(255, 81, 141, 0.02)', padding: '12px', borderRadius: 'var(--radius-sm)', border: '1px solid rgba(255, 81, 141, 0.2)' }}>
          <div style={{ fontSize: '10px', color: 'var(--vostok-pink)', fontWeight: 'bold', letterSpacing: '0.05em' }}>PARÁMETROS DE REPARACIÓN (DISTORTION)</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Reconstrucción:</span>
              <span style={{ color: 'var(--vostok-pink)', fontWeight: 'bold' }}>Spline Hermite C1-Continua</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Atenuación:</span>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>20% (Previene saturación)</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>Rango Umbral:</span>
              <span style={{ color: '#fff' }}>Detección de clipping (&gt;0.98)</span>
            </div>
          </div>
        </div>
      );
    }

    // Default for clicks, pops, dropouts, slips
    let titleColor = 'var(--vostok-green)';
    let borderColor = 'rgba(82, 255, 60, 0.15)';
    let bgColor = 'rgba(82, 255, 60, 0.02)';
    let sliderClass = 'slider-green';
    if (type === 'dropout') {
      titleColor = 'var(--vostok-cyan)';
      borderColor = 'rgba(0, 245, 255, 0.15)';
      bgColor = 'rgba(0, 245, 255, 0.02)';
      sliderClass = 'slider-cyan';
    } else if (type === 'slip') {
      titleColor = 'var(--vostok-green)';
      borderColor = 'rgba(82, 255, 60, 0.15)';
      bgColor = 'rgba(82, 255, 60, 0.02)';
      sliderClass = 'slider-green';
    } else if (type === 'pop') {
      titleColor = 'var(--vostok-green)';
      borderColor = 'rgba(82, 255, 60, 0.15)';
      bgColor = 'rgba(82, 255, 60, 0.02)';
      sliderClass = 'slider-green';
    }

    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', background: bgColor, padding: '12px', borderRadius: 'var(--radius-sm)', border: `1px solid ${borderColor}` }}>
        <div style={{ fontSize: '10px', color: titleColor, fontWeight: 'bold', letterSpacing: '0.05em' }}>
          PARÁMETROS SPLINE CÚBICA ({type.toUpperCase()})
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
            <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Ventana (muestras):</span>
            <span style={{ color: titleColor, fontWeight: 'bold' }}>{config.window_size}</span>
          </div>
          <input 
            type="range" 
            min="4" 
            max="64" 
            step="2" 
            value={config.window_size} 
            onChange={e => setConfig(p => ({ ...p, window_size: parseInt(e.target.value) }))} 
            className={sliderClass}
            style={{ cursor: 'pointer' }} 
          />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px' }}>
            <span style={{ color: 'rgba(255, 255, 255, 0.6)' }}>Tensión:</span>
            <span style={{ color: titleColor, fontWeight: 'bold' }}>{config.tension.toFixed(2)}</span>
          </div>
          <input 
            type="range" 
            min="-1" 
            max="1" 
            step="0.1" 
            value={config.tension} 
            onChange={e => setConfig(p => ({ ...p, tension: parseFloat(e.target.value) }))} 
            className={sliderClass}
            style={{ cursor: 'pointer' }} 
          />
        </div>
      </div>
    );
  };

  const currentMatrix = SPECTROGRAM_STORAGE.hum;
  const currentFrames = stftFrames;
  const currentBins   = stftBins;
  const isZoomed      = false;

  // ── RENDER ──
  return (
    <div className="workspace-container grid-bg crt-scanlines" style={{ display: 'flex', flexDirection: 'column', height: '100vh', backgroundColor: 'var(--vostok-black)', color: '#fff', fontFamily: 'var(--font-ui)', overflow: 'hidden' }}>
      <div className="app-noise-overlay" />

      {/* HEADER QUIRÚRGICO DE NAVEGACIÓN */}
      {!isMaximized && (
        <header style={{ 
          display: 'flex', 
          justifyContent: 'space-between', 
          alignItems: 'center', 
          padding: '12px 16px', 
          borderBottom: '1px solid rgba(255, 255, 255, 0.06)', 
          background: '#04070a', 
          zIndex: 10 
        }}>
          {/* IZQUIERDA: Marca + Botón de Retorno Enmarcado */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
            <button 
              onClick={onReset} 
              className="btn-icon" 
              style={{ 
                background: 'rgba(255, 255, 255, 0.02)', 
                border: '1px solid rgba(255, 255, 255, 0.08)', 
                color: 'rgba(255, 255, 255, 0.5)', 
                cursor: 'pointer', 
                padding: '5px',
                borderRadius: '3px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s ease',
                width: '26px',
                height: '26px'
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = 'var(--vostok-green)';
                e.currentTarget.style.color = '#fff';
                e.currentTarget.style.backgroundColor = 'rgba(57, 255, 20, 0.03)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)';
                e.currentTarget.style.color = 'rgba(255, 255, 255, 0.5)';
                e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
              }}
              title="Volver a la vista de carga"
            >
              <ArrowLeft style={{ width: 14, height: 14 }} />
            </button>
            <div style={{ position: 'relative', paddingBottom: '2px' }}>
              <h1 style={{ 
                fontSize: '11px', 
                fontWeight: 900, 
                margin: 0, 
                letterSpacing: '0.15em', 
                color: '#fff', 
                fontFamily: 'var(--font-mono)' 
              }}>
                VOSTOK <span style={{ color: 'var(--vostok-green)' }}>//</span> RESTORATION v1
              </h1>
              {/* Línea de anclaje de marca */}
              <div style={{ 
                position: 'absolute', 
                bottom: '-4px', 
                left: 0, 
                width: '32px', 
                height: '2px', 
                backgroundColor: 'var(--vostok-green)' 
              }} />
              <p style={{ 
                fontSize: '9px', 
                color: 'rgba(255, 255, 255, 0.3)', 
                margin: '6px 0 0 0', 
                fontWeight: 'bold',
                fontFamily: 'var(--font-mono)'
              }}>
                FILE: <span style={{ color: 'rgba(255, 255, 255, 0.7)' }}>{fileName}</span>
              </p>
            </div>
          </div>

          {/* CENTRO: Monitoreo de Telemetría del Motor DSP */}
          <div style={{ 
            display: 'flex', 
            alignItems: 'center', 
            gap: '8px', 
            padding: '4px 10px', 
            backgroundColor: 'rgba(255, 255, 255, 0.02)', 
            border: '1px solid rgba(255, 255, 255, 0.04)', 
            borderRadius: '3px',
            userSelect: 'none'
          }}>
            <span className="vostok-led" style={{ color: 'var(--vostok-cyan)', backgroundColor: 'var(--vostok-cyan)' }} />
            <span style={{ 
              fontSize: '8px', 
              fontWeight: 'bold', 
              letterSpacing: '0.08em', 
              color: 'rgba(255, 255, 255, 0.4)', 
              fontFamily: 'var(--font-mono)' 
            }}>
              CORE STATE: ACTIVE // 64-BIT DSP // BUFFER STABLE
            </span>
          </div>

          {/* DERECHA: Botones de Acción en Monospace (Rack Switches) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <button 
              onClick={undo} 
              disabled={status !== 'ready'} 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px', 
                background: '#090d10', 
                border: '1px solid rgba(255, 255, 255, 0.08)', 
                color: status === 'ready' ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.2)', 
                borderRadius: '3px', 
                padding: '5px 10px', 
                fontSize: '10px', 
                fontWeight: 'bold', 
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.05em',
                cursor: status === 'ready' ? 'pointer' : 'not-allowed', 
                opacity: status === 'ready' ? 1 : 0.4, 
                transition: 'all 0.15s ease' 
              }} 
              title="Deshacer (Ctrl+Z)" 
              onMouseEnter={(e) => { 
                if (status === 'ready') {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'; 
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
                }
              }} 
              onMouseLeave={(e) => { 
                if (status === 'ready') {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; 
                  e.currentTarget.style.backgroundColor = '#090d10';
                }
              }}
            >
              <Undo style={{ width: 12, height: 12 }} /> DESHACER
            </button>
            
            <button 
              onClick={redo} 
              disabled={status !== 'ready'} 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px', 
                background: '#090d10', 
                border: '1px solid rgba(255, 255, 255, 0.08)', 
                color: status === 'ready' ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.2)', 
                borderRadius: '3px', 
                padding: '5px 10px', 
                fontSize: '10px', 
                fontWeight: 'bold', 
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.05em',
                cursor: status === 'ready' ? 'pointer' : 'not-allowed', 
                opacity: status === 'ready' ? 1 : 0.4, 
                transition: 'all 0.15s ease' 
              }} 
              title="Rehacer (Ctrl+Y / Ctrl+Shift+Z)" 
              onMouseEnter={(e) => { 
                if (status === 'ready') {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.2)'; 
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
                }
              }} 
              onMouseLeave={(e) => { 
                if (status === 'ready') {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; 
                  e.currentTarget.style.backgroundColor = '#090d10';
                }
              }}
            >
              <Redo style={{ width: 12, height: 12 }} /> REHACER
            </button>
            
            <button 
              onClick={handleExportFile} 
              disabled={status !== 'ready'} 
              style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px', 
                background: '#090d10', 
                border: '1px solid rgba(255, 255, 255, 0.08)', 
                color: status === 'ready' ? 'rgba(255, 255, 255, 0.8)' : 'rgba(255, 255, 255, 0.2)', 
                borderRadius: '3px', 
                padding: '5px 10px', 
                fontSize: '10px', 
                fontWeight: 'bold', 
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.05em',
                cursor: status === 'ready' ? 'pointer' : 'not-allowed', 
                opacity: status === 'ready' ? 1 : 0.4, 
                transition: 'all 0.15s ease' 
              }} 
              onMouseEnter={(e) => { 
                if (status === 'ready') {
                  e.currentTarget.style.borderColor = 'var(--vostok-green)'; 
                  e.currentTarget.style.color = 'var(--vostok-green)';
                  e.currentTarget.style.backgroundColor = 'rgba(57, 255, 20, 0.03)';
                }
              }} 
              onMouseLeave={(e) => { 
                if (status === 'ready') {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.08)'; 
                  e.currentTarget.style.color = 'rgba(255, 255, 255, 0.8)';
                  e.currentTarget.style.backgroundColor = '#090d10';
                }
              }}
            >
              <Download style={{ width: 12, height: 12 }} /> EXPORTAR WAV
            </button>
            
            <button
              onClick={handleDownloadReport}
              disabled={status !== 'ready' || glitches.length === 0}
              title={glitches.length === 0 ? 'Ejecuta un análisis primero' : 'Descargar reporte de análisis forense (.txt)'}
              style={{
                display: 'flex', 
                alignItems: 'center', 
                gap: '6px',
                background: glitches.length > 0 ? 'rgba(0, 245, 255, 0.03)' : '#090d10',
                border: `1px solid ${glitches.length > 0 ? 'rgba(0, 245, 255, 0.25)' : 'rgba(255, 255, 255, 0.08)'}`,
                color: glitches.length > 0 ? 'var(--vostok-cyan)' : 'rgba(255, 255, 255, 0.3)',
                borderRadius: '3px', 
                padding: '5px 10px', 
                fontSize: '10px', 
                fontWeight: 'bold',
                fontFamily: 'var(--font-mono)',
                letterSpacing: '0.05em',
                cursor: (status === 'ready' && glitches.length > 0) ? 'pointer' : 'not-allowed',
                opacity: (status === 'ready' && glitches.length > 0) ? 1 : 0.4,
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => { 
                if (status === 'ready' && glitches.length > 0) {
                  e.currentTarget.style.backgroundColor = 'rgba(0, 245, 255, 0.08)'; 
                  e.currentTarget.style.borderColor = 'var(--vostok-cyan)';
                  e.currentTarget.style.color = '#fff';
                }
              }}
              onMouseLeave={(e) => { 
                if (status === 'ready' && glitches.length > 0) {
                  e.currentTarget.style.backgroundColor = 'rgba(0, 245, 255, 0.03)'; 
                  e.currentTarget.style.borderColor = 'rgba(0, 245, 255, 0.25)';
                  e.currentTarget.style.color = 'var(--vostok-cyan)';
                }
              }}
            >
              <FileText style={{ width: 12, height: 12 }} /> REPORTE
            </button>
          </div>
        </header>
      )}

      {/* CUERPO PRINCIPAL BENTO GRID */}
      <div style={{ display: 'flex', flex: 1, overflow: 'hidden', padding: isMaximized ? '8px' : '16px', gap: isMaximized ? '8px' : '16px' }}>

        {/* PANEL CENTRAL: ESPECTROGRAMA Y LÍNEA DE TIEMPO */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: isMaximized ? '8px' : '16px', height: '100%', overflow: 'hidden' }}>

          {/* BENTO BOX: VISUALIZADOR CORE CON CONTROL VERTICAL EXTERNO */}
          <div style={{ flex: 1, display: 'flex', gap: '12px', overflow: 'hidden', paddingTop: '0px', minHeight: 0 }}>

            {/* Contenedor alineador del Vertical Scrubber para coincidir exactamente con el WebGL Canvas del espectrograma */}
            <div style={{ display: 'flex', flexDirection: 'column', paddingTop: '25px', paddingBottom: '33px', height: '100%', boxSizing: 'border-box' }}>
              <VerticalScrubber viewStart={viewYStart} viewEnd={viewYEnd} onViewportChange={handleViewportYChange} scaleMode={scaleMode} />
            </div>

            {/* CONTENEDOR DEL ESPECTROGRAMA */}
            <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column' }}>
              
              <div className="glass-panel" style={{ flex: 1, position: 'relative', overflow: 'hidden', borderRadius: '0px', padding: 0, display: 'flex', flexDirection: 'column' }}>
                
                {/* Botón Flotante para Maximizar/Pantalla Completa */}
                <button
                  onClick={() => setIsMaximized(!isMaximized)}
                  style={{
                    position: 'absolute',
                    top: '10px',
                    right: '10px',
                    zIndex: 200,
                    backgroundColor: 'rgba(6, 9, 12, 0.75)',
                    backdropFilter: 'var(--blur-glass)',
                    border: '1px solid rgba(82, 255, 60, 0.25)',
                    borderRadius: '4px',
                    padding: '6px',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#fff',
                    transition: 'all 0.15s ease',
                    boxShadow: 'var(--shadow-panel)'
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--vostok-green)';
                    e.currentTarget.style.boxShadow = '0 0 10px rgba(82, 255, 60, 0.4)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(82, 255, 60, 0.25)';
                    e.currentTarget.style.boxShadow = 'var(--shadow-panel)';
                  }}
                  title={isMaximized ? 'Restaurar interfaz' : 'Pantalla completa / Maximizar espectrograma'}
                >
                  {isMaximized ? <Minimize2 style={{ width: 14, height: 14, color: 'var(--vostok-green)' }} /> : <Maximize2 style={{ width: 14, height: 14, color: '#fff' }} />}
                </button>
                {!currentMatrix ? (
                  <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', background: 'var(--vostok-black)' }}>
                    <Cpu className="spinning" style={{ width: 24, height: 24, color: 'var(--vostok-green)' }} />
                    <span style={{ fontSize: '10px', color: 'rgba(255,255,255,0.4)', letterSpacing: '0.1em' }}>
                      {globalHealingProgress !== null
                        ? `RESTRUCTURANDO SEÑAL NATURALEZA (${globalHealingProgress}%)`
                        : 'INICIALIZANDO MOTOR GRÁFICO WEBGL...'}
                    </span>
                  </div>
                ) : (
                  <div style={{ width: '100%', height: '100%', position: 'relative' }}>
                    <SpectrogramGL
                      matrix={currentMatrix}
                      frames={currentFrames}
                      bins={currentBins}
                      sampleRate={sampleRate}
                      viewStart={viewStart}
                      viewEnd={viewEnd}
                      viewYStart={viewYStart}
                      viewYEnd={viewYEnd}
                      isLocalHD={spectrogramMode === 'local_hd'}
                      glitches={visibleGlitches}
                      onGlitchClick={selectGlitch}
                      onGlitchContextMenu={discardGlitch}
                      selectedGlitchIdx={selectedGlitchIdx}
                      onViewportChange={handleViewportChange}
                      onRenderComplete={handleRenderComplete}
                      matrixVersion={matrixVersion}
                      duration={duration}
                      isZoomed={isZoomed}
                      dbFloor={dbFloor}
                      dbCeiling={dbCeiling}
                      scaleMode={scaleMode}
                      waveformOpacity={waveformOpacity}
                      waveformEnvelope={waveformEnvelope}
                      setDbFloor={setDbFloor}
                      setDbCeiling={setDbCeiling}
                      setScaleMode={setScaleMode}
                      setWaveformOpacity={setWaveformOpacity}
                      toolMode={toolMode}
                      healSelection={healSelection}
                      channels={channels}
                      playheadTime={playheadTime}
                      onSeek={handleSeek}
                      loopStart={loopStart}
                      loopEnd={loopEnd}
                      onLoopRangeChange={(start, end) => updateSession({ loopStart: start, loopEnd: end })}
                      onScanLoop={scanAudio}
                    />

                    {/* OVERLAY DE CARGA Y RESTAURACIÓN EN EL ESPECTROGRAMA */}
                    {(status === 'healing' || status === 'analyzing') && (
                      <div style={{
                        position: 'absolute',
                        inset: 0,
                        backgroundColor: 'rgba(10, 14, 18, 0.4)',
                        backdropFilter: 'blur(6px)',
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: '16px',
                        zIndex: 10,
                        borderRadius: '4px',
                        pointerEvents: 'auto',
                     }}>
                        <div style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          gap: '12px',
                          padding: '24px 40px',
                          background: 'rgba(10, 14, 18, 0.85)',
                          border: '1px solid rgba(82, 255, 60, 0.2)',
                          boxShadow: '0 0 30px rgba(82, 255, 60, 0.1)',
                          borderRadius: '8px',
                        }}>
                          <Cpu className="spinning" style={{ width: 32, height: 32, color: 'var(--vostok-green)', filter: 'drop-shadow(0 0 8px rgba(82, 255, 60, 0.6))' }} />
                          <span style={{ fontSize: '11px', color: '#fff', fontWeight: 900, letterSpacing: '0.2em', textAlign: 'center', fontFamily: 'JetBrains Mono, monospace' }}>
                            {status === 'healing' 
                              ? `RECONSTRUYENDO SEÑAL...` 
                              : `ANALIZANDO AUDIO...`}
                          </span>
                          {status === 'healing' && globalHealingProgress !== null && (
                            <div style={{ width: '120px', height: '3px', backgroundColor: 'rgba(255,255,255,0.05)', borderRadius: '2px', overflow: 'hidden', marginTop: '4px' }}>
                              <div style={{ width: `${globalHealingProgress}%`, height: '100%', backgroundColor: 'var(--vostok-green)', transition: 'width 0.2s ease', boxShadow: '0 0 6px var(--vostok-green)' }} />
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    
                    {/* FLOATING OVERLAY PARA EL GLITCH SELECCIONADO */}
                    {selectedGlitch && (
                      <div style={{
                        position: 'absolute',
                        left: '20px',
                        bottom: '20px',
                        width: '280px',
                        backgroundColor: 'rgba(10, 14, 18, 0.92)',
                        backdropFilter: 'blur(12px)',
                        border: '1px solid rgba(82, 255, 60, 0.4)',
                        borderRadius: '8px',
                        padding: '14px',
                        zIndex: 100,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '12px',
                        boxShadow: '0 12px 30px rgba(0,0,0,0.8), 0 0 15px rgba(82, 255, 60, 0.15)',
                        fontFamily: 'JetBrains Mono, monospace',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255,255,255,0.08)', paddingBottom: '6px' }}>
                          <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.4)', fontWeight: 'bold' }}>DETALLES DEL EVENTO</div>
                          <button 
                            onClick={() => selectGlitch(null)}
                            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.4)', cursor: 'pointer', fontSize: '11px', fontWeight: 'bold', padding: 0, transition: 'color 0.15s ease' }}
                            onMouseEnter={e => e.currentTarget.style.color = 'var(--vostok-green)'}
                            onMouseLeave={e => e.currentTarget.style.color = 'rgba(255,255,255,0.4)'}
                          >
                            ✕
                          </button>
                        </div>

                        <table style={{ width: '100%', fontSize: '10px', borderCollapse: 'collapse' }}>
                          <tbody>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                              <td style={{ padding: '4px 0', color: 'rgba(255,255,255,0.4)' }}>Muestra Index:</td>
                              <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 'bold', color: '#fff' }}>{selectedGlitch.sample_index}</td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                              <td style={{ padding: '4px 0', color: 'rgba(255,255,255,0.4)' }}>Tiempo Físico:</td>
                              <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 'bold', color: 'var(--vostok-green)' }}>{(selectedGlitch.sample_index / sampleRate).toFixed(4)}s</td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                              <td style={{ padding: '4px 0', color: 'rgba(255,255,255,0.4)' }}>Tipo Anomalía:</td>
                              <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 'bold', color: 'var(--vostok-green)' }}>{(selectedGlitch.event_type || 'click').toUpperCase()}</td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                              <td style={{ padding: '4px 0', color: 'rgba(255,255,255,0.4)' }}>Canal:</td>
                              <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 'bold', color: 'var(--vostok-green)' }}>
                                {selectedGlitch.channel === 1 ? 'Derecho (R)' : selectedGlitch.channel === 0 ? 'Izquierdo (L)' : selectedGlitch.channel === 2 ? 'Ambos' : `Ch ${selectedGlitch.channel}`}
                              </td>
                            </tr>
                            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                              <td style={{ padding: '4px 0', color: 'rgba(255,255,255,0.4)' }}>Magnitud (ΔV):</td>
                              <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 'bold', color: 'var(--vostok-cyan)' }}>{selectedGlitch.amplitude_delta.toFixed(5)}</td>
                            </tr>
                            <tr>
                              <td style={{ padding: '4px 0', color: 'rgba(255,255,255,0.4)' }}>Estado:</td>
                              <td style={{ padding: '4px 0', textAlign: 'right', fontWeight: 'bold', color: selectedGlitch.repaired ? 'var(--vostok-green)' : 'var(--vostok-cyan)' }}>
                                {selectedGlitch.repaired ? 'REPARADO' : 'DAÑADO'}
                              </td>
                            </tr>
                          </tbody>
                        </table>

                        {renderInspectorParameters()}

                        {!selectedGlitch.repaired && (
                          <button
                            onClick={() => healGlitch(glitches[selectedGlitch.internalIdx], selectedGlitch.internalIdx)}
                            disabled={healingProgress[selectedGlitch.internalIdx] !== undefined}
                            style={{
                              width: '100%',
                              background: 'none',
                              border: '1px solid var(--vostok-green)',
                              color: 'var(--vostok-green)',
                              borderRadius: '4px',
                              padding: '8px',
                              fontSize: '10px',
                              fontWeight: 900,
                              cursor: 'pointer',
                              fontFamily: 'JetBrains Mono, monospace',
                              marginTop: '4px',
                              transition: 'all 0.15s ease',
                            }}
                          >
                            {healingProgress[selectedGlitch.internalIdx] !== undefined
                              ? `REPARANDO... (${healingProgress[selectedGlitch.internalIdx]}%)`
                              : 'REPARAR EVENTO'}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* BENTO BOX: CONTROLES DE TRANSPORTE Y SCRUBBER HORIZONTAL */}
          <div style={{ padding: isMaximized ? '0px' : '4px 0 0 0', display: 'flex', flexDirection: 'column', gap: isMaximized ? '6px' : '10px', position: 'relative', flexShrink: 0 }}>
            
            <div style={{ paddingLeft: '40px', width: '100%', boxSizing: 'border-box' }}>
              <TimelineScrubber
                viewStart={viewStart}
                viewEnd={viewEnd}
                onViewportChange={handleViewportChange}
                playheadTime={playheadTime}
                onSeek={(percent) => handleSeek(percent * duration)}
                duration={duration}
                envelope={waveformEnvelope || []}
              />
            </div>

            {/* Flat Monospace Section Header aligned to grid */}
            <div style={{ paddingLeft: '40px', display: 'flex', alignItems: 'center', gap: '8px', marginTop: '2px', marginBottom: '-2px', userSelect: 'none' }}>
              <span className="vostok-led" style={{ backgroundColor: 'var(--vostok-cyan)', color: 'var(--vostok-cyan)' }} />
              <span style={{
                fontFamily: 'var(--font-mono)',
                fontSize: '9px',
                fontWeight: 900,
                letterSpacing: '0.15em',
                color: 'rgba(255, 255, 255, 0.45)'
              }}>
                VOSTOK // SYSTEM_TRANSPORT
              </span>
            </div>

            <div className="transport-container">
              <div className="buttons-row">
                {/* Grupo de Transporte: Play/Pause/Stop */}
                <div className="buttons-group">
                  <button 
                    onClick={handlePlayPause} 
                    disabled={status !== 'ready'} 
                    className={`vostok-btn-transport ${isPlaying ? 'vostok-btn-transport--active-green' : ''}`}
                  >
                    {isPlaying ? <Pause style={{ width: 12, height: 12, fill: 'currentColor' }} /> : <Play style={{ width: 12, height: 12, fill: 'currentColor' }} />}
                    {isPlaying ? 'PAUSA' : 'REPRODUCIR'}
                  </button>
                  <button 
                    onClick={handleStop} 
                    disabled={status !== 'ready'} 
                    className="vostok-btn-transport"
                  >
                    <Square style={{ width: 11, height: 11, fill: 'currentColor' }} /> DETENER
                  </button>
                </div>

                {/* Separador */}
                <div className="hidden-mobile-divider" style={{ width: '1px', height: '16px', backgroundColor: 'rgba(255,255,255,0.15)', margin: '0 8px' }} />

                {/* Grupo de Visualización: Seguir Aguja / Enfoque HD */}
                <div className="buttons-group">
                  <button
                    onClick={() => setFollowPlayhead(!followPlayhead)}
                    disabled={status !== 'ready'}
                    className={`vostok-btn-transport ${followPlayhead ? 'vostok-btn-transport--active-green' : ''}`}
                    title="Mantiene la vista centrada en la aguja de reproducción durante la reproducción"
                  >
                    <Compass style={{ width: 12, height: 12 }} />
                    {followPlayhead ? 'SEGUIR AGUJA' : 'SEGUIR AGUJA'}
                  </button>

                  <button
                    onClick={spectrogramMode === 'local_hd' ? restaurarEspectrogramaCompleto : handleReRenderLocal}
                    disabled={status !== 'ready'}
                    className={`vostok-btn-transport ${spectrogramMode === 'local_hd' ? 'vostok-btn-transport--active-cyan' : ''}`}
                    title={spectrogramMode === 'local_hd' ? "Restaurar espectrograma completo original" : "Calcular STFT de alta resolución local (HD) para el área visible actual"}
                  >
                    <Sparkles style={{ width: 12, height: 12 }} />
                    {spectrogramMode === 'local_hd' ? 'RESTAURAR FULL' : 'ENFOQUE HD'}
                  </button>
                </div>

                {/* Separador */}
                <div className="hidden-mobile-divider" style={{ width: '1px', height: '16px', backgroundColor: 'rgba(255,255,255,0.15)', margin: '0 8px' }} />

                {/* Grupo de Cursor/Edición: Navegar / Selección 2D */}
                <div className="buttons-group">
                  <button
                    onClick={() => setToolMode('navigate')}
                    className={`vostok-btn-transport ${toolMode === 'navigate' ? 'vostok-btn-transport--active-green' : ''}`}
                  >
                    <Move style={{ width: 12, height: 12 }} />
                    NAVEGAR
                  </button>
                  <button
                    onClick={() => setToolMode('select')}
                    className={`vostok-btn-transport ${toolMode === 'select' ? 'vostok-btn-transport--active-green' : ''}`}
                  >
                    <Crop style={{ width: 12, height: 12 }} />
                    SELECCIÓN MANUAL
                  </button>
                </div>
              </div>

              <div className="telemetry-row">
                <div>TIME: <span style={{ color: 'var(--vostok-green)' }}>{playheadTime.toFixed(3)}s</span> / {duration.toFixed(3)}s</div>
                <div style={{ color: 'rgba(255,255,255,0.3)' }}>SR: {sampleRate}Hz | {bitDepth}-bit</div>
              </div>
            </div>
          </div>
        </div>

        {/* PANEL LATERAL: INSPECTOR BENTO Y ACCIONES QUIRÚRGICAS */}
        {!isMaximized && (
          <div style={{ width: '320px', display: 'flex', flexDirection: 'column', gap: '16px', height: '100%', overflow: 'hidden' }}>
          {/* DETECTOR DE IMPULSOS (Colapsable) */}
          <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
            <div 
              onClick={() => setIsDetectorExpanded(!isDetectorExpanded)}
              onMouseEnter={() => setIsDetectorHovered(true)}
              onMouseLeave={() => setIsDetectorHovered(false)}
              style={{ 
                padding: '12px 16px', 
                borderTop: '1px solid var(--vostok-border-g)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)',
                background: isDetectorHovered ? 'rgba(57, 255, 20, 0.03)' : 'transparent',
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                cursor: 'pointer', 
                userSelect: 'none',
                transition: 'background-color 0.2s ease, border-color 0.2s ease'
              }}
            >
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '8px', 
                fontSize: '11px', 
                fontWeight: 900, 
                letterSpacing: '0.08em', 
                fontFamily: 'var(--font-ui)',
                color: 'rgba(255, 255, 255, 0.85)' 
              }}>
                <Zap style={{ width: 13, height: 13, color: 'var(--vostok-green)' }} /> DETECTOR DE IMPULSOS
              </div>
              <ChevronDown style={{ width: 14, height: 14, color: 'rgba(255, 255, 255, 0.6)', transform: isDetectorExpanded ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s ease' }} />
            </div>

            {isDetectorExpanded && (
              <div style={{ padding: '16px', display: 'flex', flexDirection: 'column', gap: '14px' }}>
                {/* DOMINIOS DE ARTEFACTOS */}
                <div style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                  background: 'rgba(6, 9, 12, 0.4)',
                  border: '1px solid rgba(255, 255, 255, 0.05)',
                  boxShadow: 'inset 0 1px 1px rgba(255, 255, 255, 0.02), 0 4px 10px rgba(0, 0, 0, 0.3)',
                  borderRadius: '8px',
                  padding: '12px'
                }}>
                  <div style={{ fontSize: '9px', color: 'rgba(255,255,255,0.3)', fontWeight: 'bold', letterSpacing: '0.05em', marginBottom: '4px' }}>DOMINIOS ACTIVOS</div>
                  
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', cursor: 'pointer', userSelect: 'none' }}>
                      <input type="checkbox" className="vostok-checkbox" checked={scanParams.clicks} onChange={e => setScanParams(p => ({ ...p, clicks: e.target.checked }))} />
                      <span style={{ transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--vostok-green)'} onMouseLeave={e => e.currentTarget.style.color = ''}>Clicks & Pops</span>
                    </label>
                    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
                      <button 
                        onClick={() => setShowAdvanced(prev => !prev)} 
                        onMouseEnter={(e) => e.currentTarget.style.color = 'var(--vostok-green)'}
                        onMouseLeave={(e) => e.currentTarget.style.color = showAdvanced ? 'var(--vostok-green)' : 'rgba(255,255,255,0.25)'}
                        style={{ 
                          background: 'none', 
                          border: 'none', 
                          color: showAdvanced ? 'var(--vostok-green)' : 'rgba(255,255,255,0.25)', 
                          cursor: 'pointer', 
                          padding: '2px', 
                          display: 'flex', 
                          alignItems: 'center', 
                          transition: 'color 0.15s ease' 
                        }}
                        title="Opciones Avanzadas"
                      >
                        <Settings size={12} style={{ transform: showAdvanced ? 'rotate(45deg)' : 'none', transition: 'transform 0.3s ease' }} />
                      </button>
                      {showAdvanced && (
                        <div style={{
                          position: 'absolute',
                          right: '20px',
                          top: '-15px',
                          width: '180px',
                          backgroundColor: 'rgba(6, 9, 12, 0.96)',
                          backdropFilter: 'var(--blur-glass)',
                          border: (scanParams.audio_mode === 'voice' && scanParams.sensitivity > 0.75) 
                            ? '1px solid rgba(0, 245, 255, 0.25)' 
                            : '1px solid rgba(82, 255, 60, 0.25)',
                          boxShadow: (scanParams.audio_mode === 'voice' && scanParams.sensitivity > 0.75)
                            ? '0 8px 32px rgba(0, 0, 0, 0.8), 0 0 15px rgba(0, 245, 255, 0.12)'
                            : '0 8px 32px rgba(0, 0, 0, 0.8), 0 0 15px rgba(82, 255, 60, 0.12)',
                          borderRadius: '6px',
                          padding: '12px',
                          zIndex: 999,
                          display: 'flex',
                          flexDirection: 'column',
                          gap: '6px',
                        }}>
                          {/* Flecha indicadora (CSS arrow) apuntando al botón de ajustes */}
                          <div style={{
                            position: 'absolute',
                            right: '-5px',
                            top: '17px',
                            width: '8px',
                            height: '8px',
                            backgroundColor: 'rgba(6, 9, 12, 0.96)',
                            borderRight: (scanParams.audio_mode === 'voice' && scanParams.sensitivity > 0.75) 
                              ? '1px solid rgba(0, 245, 255, 0.25)' 
                              : '1px solid rgba(82, 255, 60, 0.25)',
                            borderTop: (scanParams.audio_mode === 'voice' && scanParams.sensitivity > 0.75) 
                              ? '1px solid rgba(0, 245, 255, 0.25)' 
                              : '1px solid rgba(82, 255, 60, 0.25)',
                            transform: 'rotate(45deg)',
                            zIndex: 1000
                          }} />

                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: 'bold', zIndex: 2 }}>
                            <span style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)' }}>SENSIBILIDAD</span>
                            <span style={{ color: (scanParams.audio_mode === 'voice' && scanParams.sensitivity > 0.75) ? 'var(--vostok-cyan)' : 'var(--vostok-green)', fontFamily: 'var(--font-mono)' }}>{(scanParams.sensitivity * 100).toFixed(0)}%</span>
                          </div>
                          <input 
                            type="range" 
                            min="0.0" 
                            max="1.0" 
                            step="0.05" 
                            value={scanParams.sensitivity} 
                            onChange={e => setScanParams(p => ({ ...p, sensitivity: parseFloat(e.target.value) }))} 
                            className={(scanParams.audio_mode === 'voice' && scanParams.sensitivity > 0.75) ? 'slider-cyan' : 'slider-green'}
                            style={{ cursor: 'pointer', zIndex: 2 }}
                          />
                          
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', fontWeight: 'bold', marginTop: '8px', zIndex: 2 }}>
                            <span style={{ color: 'rgba(255,255,255,0.4)', letterSpacing: '0.05em', fontFamily: 'var(--font-mono)' }}>MODO DE AUDIO</span>
                          </div>
                          <div style={{ display: 'flex', gap: '4px', marginTop: '4px', zIndex: 2 }}>
                            <button
                              onClick={() => setScanParams(p => ({ ...p, audio_mode: 'music' }))}
                              style={{ 
                                flex: 1, 
                                padding: '5px', 
                                fontSize: '9px', 
                                fontWeight: 'bold',
                                fontFamily: 'var(--font-mono)',
                                letterSpacing: '0.05em',
                                background: scanParams.audio_mode === 'music' ? 'rgba(82,255,60,0.15)' : 'rgba(255,255,255,0.02)', 
                                border: `1px solid ${scanParams.audio_mode === 'music' ? 'var(--vostok-green)' : 'rgba(255,255,255,0.08)'}`, 
                                color: scanParams.audio_mode === 'music' ? 'var(--vostok-green)' : 'rgba(255,255,255,0.4)', 
                                borderRadius: '4px', 
                                cursor: 'pointer', 
                                transition: 'all 0.15s ease' 
                              }}
                              onMouseEnter={(e) => {
                                if (scanParams.audio_mode !== 'music') {
                                  e.currentTarget.style.borderColor = 'rgba(82, 255, 60, 0.4)';
                                  e.currentTarget.style.color = '#fff';
                                  e.currentTarget.style.backgroundColor = 'rgba(82, 255, 60, 0.05)';
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (scanParams.audio_mode !== 'music') {
                                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                                  e.currentTarget.style.color = 'rgba(255,255,255,0.4)';
                                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
                                }
                              }}
                            >
                              🎵 MÚSICA
                            </button>
                            <button
                              onClick={() => setScanParams(p => ({ ...p, audio_mode: 'voice', sensitivity: (p.audio_mode !== 'voice' && p.sensitivity > 0.75) ? 0.75 : p.sensitivity }))}
                              style={{ 
                                flex: 1, 
                                padding: '5px', 
                                fontSize: '9px', 
                                fontWeight: 'bold',
                                fontFamily: 'var(--font-mono)',
                                letterSpacing: '0.05em',
                                background: scanParams.audio_mode === 'voice' 
                                  ? ((scanParams.sensitivity > 0.75) ? 'rgba(0,245,255,0.15)' : 'rgba(82,255,60,0.15)') 
                                  : 'rgba(255,255,255,0.02)', 
                                border: `1px solid ${scanParams.audio_mode === 'voice' 
                                  ? ((scanParams.sensitivity > 0.75) ? 'var(--vostok-cyan)' : 'var(--vostok-green)') 
                                  : 'rgba(255,255,255,0.08)'}`, 
                                color: scanParams.audio_mode === 'voice' 
                                  ? ((scanParams.sensitivity > 0.75) ? 'var(--vostok-cyan)' : 'var(--vostok-green)') 
                                  : 'rgba(255,255,255,0.4)', 
                                borderRadius: '4px', 
                                cursor: 'pointer', 
                                transition: 'all 0.15s ease' 
                              }}
                              onMouseEnter={(e) => {
                                if (scanParams.audio_mode !== 'voice') {
                                  const hoverColor = (scanParams.sensitivity > 0.75) ? 'var(--vostok-cyan)' : 'var(--vostok-green)';
                                  e.currentTarget.style.borderColor = hoverColor;
                                  e.currentTarget.style.color = '#fff';
                                  e.currentTarget.style.backgroundColor = (scanParams.sensitivity > 0.75) ? 'rgba(0, 245, 255, 0.05)' : 'rgba(82, 255, 60, 0.05)';
                                }
                              }}
                              onMouseLeave={(e) => {
                                if (scanParams.audio_mode !== 'voice') {
                                  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
                                  e.currentTarget.style.color = 'rgba(255,255,255,0.4)';
                                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.02)';
                                }
                              }}
                            >
                              🎙️ VOZ
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                  
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" className="vostok-checkbox vostok-checkbox--cyan" checked={scanParams.dropouts} onChange={e => setScanParams(p => ({ ...p, dropouts: e.target.checked }))} />
                    <span style={{ transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--vostok-cyan)'} onMouseLeave={e => e.currentTarget.style.color = ''}>Signal Dropouts</span>
                  </label>
                  
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" className="vostok-checkbox vostok-checkbox--cyan" checked={scanParams.hum} onChange={e => setScanParams(p => ({ ...p, hum: e.target.checked }))} />
                    <span style={{ transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--vostok-cyan)'} onMouseLeave={e => e.currentTarget.style.color = ''}>Powerline Hum</span>
                  </label>
                  
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" className="vostok-checkbox vostok-checkbox--blue" checked={scanParams.hiss} onChange={e => setScanParams(p => ({ ...p, hiss: e.target.checked }))} />
                    <span style={{ transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--vostok-blue)'} onMouseLeave={e => e.currentTarget.style.color = ''}>Background Hiss</span>
                  </label>
                  
                  <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11px', cursor: 'pointer', userSelect: 'none' }}>
                    <input type="checkbox" className="vostok-checkbox vostok-checkbox--pink" checked={scanParams.distortion} onChange={e => setScanParams(p => ({ ...p, distortion: e.target.checked }))} />
                    <span style={{ transition: 'color 0.2s' }} onMouseEnter={e => e.currentTarget.style.color = 'var(--vostok-pink)'} onMouseLeave={e => e.currentTarget.style.color = ''}>Clipping / Distortion</span>
                  </label>
                </div>

                {/* BOTÓN ÚNICO DE ANÁLISIS */}
                <button 
                  onClick={handleScanAudio} 
                  disabled={status !== 'ready'} 
                  className={`vostok-btn-analyze ${
                    status === 'analyzing'
                      ? 'vostok-btn-analyze--analyzing'
                      : glitches.length > 0
                      ? 'vostok-btn-analyze--reanalyze'
                      : 'vostok-btn-analyze--idle'
                  }`}
                >
                  <Zap style={{ width: 12, height: 12, color: 'inherit', animation: status === 'analyzing' ? 'spin-slow 3s linear infinite' : 'none' }} />
                  {status === 'analyzing' ? 'ANALIZANDO SEÑAL...' : (glitches.length > 0 ? 'RE-ANALIZAR AUDIO' : 'ANALIZAR AUDIO')}
                </button>
              </div>
            )}
          </div>

          {/* INSPECTOR QUIRÚRGICO (Colapsable y flexible) */}
          <div style={{ flex: isInspectorExpanded ? 1 : 'none', display: 'flex', flexDirection: 'column', position: 'relative', minHeight: 0 }}>
            <div 
              onClick={() => setIsInspectorExpanded(!isInspectorExpanded)}
              onMouseEnter={() => setIsInspectorHovered(true)}
              onMouseLeave={() => setIsInspectorHovered(false)}
              style={{ 
                padding: '12px 16px', 
                borderTop: '1px solid var(--vostok-border-c)',
                borderBottom: '1px solid rgba(255, 255, 255, 0.08)', 
                background: isInspectorHovered ? 'rgba(0, 255, 255, 0.03)' : 'transparent',
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                cursor: 'pointer', 
                userSelect: 'none',
                transition: 'background-color 0.2s ease, border-color 0.2s ease'
              }}
            >
              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '8px', 
                fontSize: '11px', 
                fontWeight: 900, 
                letterSpacing: '0.08em', 
                fontFamily: 'var(--font-ui)',
                color: 'rgba(255, 255, 255, 0.85)' 
              }}>
                <Cpu style={{ width: 13, height: 13, color: 'var(--vostok-cyan)' }} /> INSPECTOR QUIRÚRGICO
              </div>
              <ChevronDown style={{ width: 14, height: 14, color: 'rgba(255, 255, 255, 0.6)', transform: isInspectorExpanded ? 'none' : 'rotate(-90deg)', transition: 'transform 0.15s ease' }} />
            </div>

            {isInspectorExpanded && (
              <>
                <div style={{ flex: 1, padding: '16px', overflowY: 'hidden', display: 'flex', flexDirection: 'column', gap: '16px', minHeight: 0 }}>
                  {/* TELEMETRÍA DE RESULTADOS MOVILIZADA AQUÍ */}
                  {glitches.length > 0 && (
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <div className="vostok-telemetry-card vostok-telemetry-card--detected" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.05em' }}>DETECTADOS</span>
                          <span className="vostok-led" style={{ color: 'var(--vostok-green)', backgroundColor: 'var(--vostok-green)' }} />
                        </div>
                        <span style={{ color: '#fff', fontWeight: '900', fontSize: '14px', lineHeight: 1 }}>{glitches.length}</span>
                      </div>
                      <div className={`vostok-telemetry-card ${pendingGlitchesCount > 0 ? 'vostok-telemetry-card--pending' : 'vostok-telemetry-card--stable'}`} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                          <span style={{ color: 'rgba(255,255,255,0.35)', fontSize: '9px', fontWeight: 'bold', letterSpacing: '0.05em' }}>PENDIENTES</span>
                          <span className="vostok-led" style={{ 
                            color: pendingGlitchesCount > 0 ? 'var(--vostok-cyan)' : 'var(--vostok-green)', 
                            backgroundColor: pendingGlitchesCount > 0 ? 'var(--vostok-cyan)' : 'var(--vostok-green)' 
                          }} />
                        </div>
                        <span style={{ color: pendingGlitchesCount > 0 ? 'var(--vostok-cyan)' : 'var(--vostok-green)', fontWeight: '900', fontSize: '14px', lineHeight: 1 }}>{pendingGlitchesCount}</span>
                      </div>
                    </div>
                  )}

                  {glitches.length > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', height: '100%', overflow: 'hidden', minHeight: 0 }}>
                      <div style={{ fontSize: '10px', color: 'rgba(255,255,255,0.3)', fontWeight: 'bold', letterSpacing: '0.05em' }}>ANOMALÍAS DETECTADAS ({glitches.length})</div>
                      
                      <GlitchList
                        glitches={glitches}
                        onSelectGlitch={selectGlitch}
                        onDiscardGlitch={discardGlitch}
                        hiddenGlitches={hiddenGlitches}
                        onToggleVisibility={handleToggleVisibility}
                        selectedGlitch={selectedGlitch}
                      />
                    </div>
                  ) : (
                    <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', color: 'rgba(255,255,255,0.2)', fontSize: '10px', padding: '0 24px', letterSpacing: '0.05em', lineHeight: '1.5' }}>
                      SELECCIONA UNA LÍNEA DE GLITCH EN EL ESPECTROGRAMA PARA MAPEAR SUS COORDENADAS MATEMÁTICAS
                    </div>
                  )}
                </div>

                {pendingGlitchesCount > 0 && (
                  <div style={{ padding: '16px', borderTop: '1px solid rgba(255,255,255,0.05)', background: 'rgba(3, 5, 7, 0.2)' }}>
                    <button 
                      onClick={healAll} 
                      disabled={status !== 'ready'}
                      className="vostok-btn-heal-all"
                    >
                      <Zap style={{ width: 12, height: 12, fill: 'currentColor', animation: status === 'healing' ? 'spin-slow 1.2s linear infinite' : 'none' }} />
                      {status === 'healing' ? 'REPARANDO...' : `REPARAR TODO (${pendingGlitchesCount})`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      </div>

      {/* TOASTS CONTENEDOR */}
      <div style={{ position: 'fixed', bottom: '24px', right: '24px', display: 'flex', flexDirection: 'column', gap: '10px', zIndex: 9999, pointerEvents: 'none' }}>
        {toasts.map(t => (
          <div key={t.id} style={{ background: 'var(--vostok-black)', border: '1px solid var(--vostok-green)', boxShadow: '0 0 15px rgba(82, 255, 60, 0.2)', borderRadius: '6px', padding: '12px 18px', color: '#fff', fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 'bold' }}>
            {t.msg}
          </div>
        ))}
      </div>
    </div>
  );
}

function GlitchList({ glitches, onSelectGlitch, onDiscardGlitch, hiddenGlitches, onToggleVisibility, selectedGlitch }) {
  return (
    <div className="scrollable" style={{ flex: 1, paddingRight: '4px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {glitches.map((glitch, i) => {
        const isHidden = hiddenGlitches.has(glitch.sample_index);
        const isSelected = selectedGlitch && selectedGlitch.sample_index === glitch.sample_index && selectedGlitch.channel === glitch.channel;
        const type = glitch.event_type ? glitch.event_type.toUpperCase() : 'CLICK';
        
        let color = 'var(--vostok-green)';
        if (type === 'POP') color = 'var(--vostok-green)';
        if (type === 'DROPOUT') color = 'var(--vostok-cyan)';
        if (type === 'HUM') color = 'var(--vostok-cyan)';
        if (type === 'HISS') color = 'var(--vostok-blue)';
        if (type === 'DISTORTION' || type === 'CLIPPING') color = 'var(--vostok-pink)';

        return (
          <div 
            key={`${glitch.channel}-${glitch.sample_index}-${i}`}
            onClick={() => onSelectGlitch(glitch)}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onDiscardGlitch(glitch); }}
            style={{ 
              display: 'flex', 
              alignItems: 'center', 
              justifyContent: 'space-between', 
              fontSize: '10px', 
              fontFamily: 'JetBrains Mono, monospace', 
              border: `1px solid ${isSelected ? color : 'rgba(255, 255, 255, 0.05)'}`, 
              padding: '8px 10px', 
              background: isSelected ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.015)', 
              borderRadius: '4px', 
              cursor: 'pointer',
              opacity: isHidden ? 0.4 : 1,
              boxShadow: isSelected ? 'inset 0 1px 1px rgba(255, 255, 255, 0.02), 0 4px 15px rgba(0, 0, 0, 0.3)' : 'none',
              transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = color;
              e.currentTarget.style.background = 'rgba(255, 255, 255, 0.04)';
              e.currentTarget.style.boxShadow = 'inset 0 1px 1px rgba(255, 255, 255, 0.02), 0 4px 12px rgba(0, 0, 0, 0.2)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = isSelected ? color : 'rgba(255, 255, 255, 0.05)';
              e.currentTarget.style.background = isSelected ? 'rgba(255, 255, 255, 0.04)' : 'rgba(255, 255, 255, 0.015)';
              e.currentTarget.style.boxShadow = isSelected ? 'inset 0 1px 1px rgba(255, 255, 255, 0.02), 0 4px 15px rgba(0, 0, 0, 0.3)' : 'none';
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <button 
                onClick={(e) => { e.stopPropagation(); onToggleVisibility(glitch.sample_index); }}
                style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: isHidden ? 'rgba(255,255,255,0.2)' : color, display: 'flex' }}
                title={isHidden ? "Mostrar en espectrograma" : "Ocultar"}
              >
                {isHidden ? <EyeOff size={12} /> : <Eye size={12} />}
              </button>
              <div style={{ width: '6px', height: '6px', borderRadius: '50%', backgroundColor: color, boxShadow: `0 0 6px ${color}` }}></div>
              <span style={{ color: '#fff', fontWeight: 'bold' }}>
                {type} <span style={{ color: 'rgba(255,255,255,0.4)', fontWeight: 'normal' }}>[{glitch.channel === 0 ? 'L' : glitch.channel === 1 ? 'R' : 'L+R'}]</span>
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ color: 'rgba(255,255,255,0.5)' }}>{glitch.time_secs.toFixed(3)}s</span>
              {glitch.repaired ? (
                <span style={{
                  padding: '2px 6px',
                  borderRadius: '3px',
                  fontSize: '8px',
                  fontWeight: '900',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.08em',
                  background: 'rgba(82, 255, 60, 0.06)',
                  border: '1px solid rgba(82, 255, 60, 0.2)',
                  color: 'var(--vostok-green)',
                  boxShadow: '0 0 6px rgba(82, 255, 60, 0.06)',
                  display: 'inline-flex',
                  alignItems: 'center'
                }}>REPAIRED</span>
              ) : (
                <span style={{
                  padding: '2px 6px',
                  borderRadius: '3px',
                  fontSize: '8px',
                  fontWeight: '900',
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: '0.08em',
                  background: 'rgba(0, 245, 255, 0.06)',
                  border: '1px solid rgba(0, 245, 255, 0.2)',
                  color: 'var(--vostok-cyan)',
                  boxShadow: '0 0 6px rgba(0, 245, 255, 0.06)',
                  display: 'inline-flex',
                  alignItems: 'center'
                }}>PENDING</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
