/**
 * VostokRestoration.jsx — Componente Workspace Principal para la App Standalone (Tauri + Rust)
 *
 * Utiliza Bento Grid (Noir-Tech), fondo #010101, acentos en #39FF14.
 * Conecta los controles de zoom/scroll con la API IPC de Tauri.
 */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { ArrowLeft, Download, Zap, Cpu, Volume2, Play, Pause, Square, SkipBack, SkipForward } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import SpectrogramGL from './SpectrogramGL.jsx';
import TimelineScrubber from './TimelineScrubber.jsx';
import VerticalScrubber from './VerticalScrubber.jsx';

function base64ToUint8Array(base64) {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
}

function getArtifactTagColor(type) {
  const t = (type || '').toUpperCase();
  if (t.includes('CLIP')) return '#FF5555'; // Rojo
  if (t.includes('CLICK')) return '#FFFF55'; // Amarillo
  if (t.includes('POP')) return '#00FFFF'; // Cian
  if (t.includes('HUM')) return '#39FF14'; // Verde Neón
  if (t.includes('DROPOUT')) return '#FF00FF'; // Magenta
  return '#FFFFFF';
}

export default function VostokRestoration({ session, updateSession, onReset }) {
  const { file, fileName, duration, sampleRate, channels, bitDepth, glitches, stftMatrix, stftFrames, stftBins, status } = session;

  const containerRef = useRef(null);
  const visualizerContainerRef = useRef(null);

  // 1. Estados flotantes dobles para el control de la línea de tiempo (Viewport)
  const [viewStart, setViewStart] = useState(0.0);
  const [viewEnd, setViewEnd] = useState(1.0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [localThreshold, setLocalThreshold] = useState(session.threshold || 0.01);
  const [backendThreshold, setBackendThreshold] = useState(session.threshold || 0.01);
  const [selectedGlitchIdx, setSelectedGlitchIdx] = useState(null);
  const [profile, setProfile] = useState(session.profile || 'hum');
  const [isAnalyzed, setIsAnalyzed] = useState(false);
  const [selectedArtifacts, setSelectedArtifacts] = useState({
    clicks: true,
    pops: true,
    hum: false,
    clipping: true,
    dropouts: false,
    hiss: false,
    use_hybrid_click_detector: false,
    use_hybrid_pop_detector: false
  });
  const [sortBy, setSortBy] = useState('time'); // 'time' | 'magnitude' | 'confidence'
  const [sortAsc, setSortAsc] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0.15); // Default certainty filter (15%)

  // Filter glitches dynamically based on the confidence score
  const displayedGlitches = useMemo(() => {
    if (!glitches) return [];
    
    // Support legacy array format or new segregated object format
    let transients = [];
    let stationaries = [];
    
    if (Array.isArray(glitches)) {
        transients = glitches;
    } else {
        transients = glitches.transients || [];
        stationaries = glitches.stationaries || [];
    }
    
    const allEvents = [...transients, ...stationaries];
    
    return allEvents
      .map((g, idx) => ({ ...g, originalIdx: idx }))
      .filter(g => {
        const conf = g.confidence !== undefined ? g.confidence : 1.0;
        return conf >= minConfidence;
      });
  }, [glitches, minConfidence]);

  const allSelected = Object.values(selectedArtifacts).every(val => val);
  const handleToggleSelectAll = (checked) => {
    setSelectedArtifacts({
      clicks: checked,
      pops: checked,
      hum: checked,
      clipping: checked,
      dropouts: checked,
      hiss: checked
    });
  };

  const handleProfileChange = useCallback(async (newProfile) => {
    setProfile(newProfile);
    updateSession({ status: 'analyzing' });
    try {
      const analysis = await invoke('calcular_espectrograma', { profile: newProfile });
      
      const config = {
        start_frame: 0,
        end_frame: analysis.stft_frames,
        max_texture_width: 2048,
      };
      
      const stftRes = await invoke('obtener_espectrograma_visible', { config });
      
      updateSession({
        glitches: analysis.glitches,
        stftMatrix: base64ToUint8Array(stftRes.matrix),
        stftFrames: stftRes.num_frames,
        stftBins: stftRes.num_bins,
        totalStftFrames: analysis.stft_frames,
        threshold: analysis.recommended_threshold,
        profile: newProfile,
        status: 'ready'
      });
      
      setLocalThreshold(analysis.recommended_threshold);
      setBackendThreshold(analysis.recommended_threshold);
    } catch (err) {
      console.error('[Profile Change Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [updateSession]);

  // Transport and Seeking states (Estilo Reaper)
  const [playheadTime, setPlayheadTime] = useState(0.0);
  const [lastClickTime, setLastClickTime] = useState(0.0);

  const handleViewportChange = useCallback((start, end) => {
    setViewStart(start);
    setViewEnd(end);
  }, []);

  const [viewYStart, setViewYStart] = useState(0.0);
  const [viewYEnd, setViewYEnd] = useState(1.0);

  const handleViewportYChange = useCallback((start, end) => {
    setViewYStart(start);
    setViewYEnd(end);
  }, []);

  // Sincronizar el threshold cuando cambie en la sesión (al cargar un nuevo archivo)
  useEffect(() => {
    const t = session.threshold || 0.01;
    setLocalThreshold(t);
    setBackendThreshold(t);
  }, [session.threshold]);

  // Referencias para evitar inundar el canal IPC durante operaciones de zoom/scroll rápidos
  const pendingUpdateRef = useRef(false);
  const nextRangeRef = useRef(null);

  // Detener la reproducción cuando el componente se desmonte
  useEffect(() => {
    return () => {
      invoke('stop_playback').catch(err => console.error('[Playback] Error deteniendo reproducción:', err));
    };
  }, []);

  // Lógica de centrado de viewport
  const centerViewportOnTime = useCallback((time) => {
    const fileDuration = duration || 1.0;
    const centerPercent = time / fileDuration;
    const range = viewEnd - viewStart;
    const nextStart = Math.max(0.0, centerPercent - range / 2);
    const nextEnd = Math.min(1.0, centerPercent + range / 2);
    setViewStart(nextStart);
    setViewEnd(nextEnd);
  }, [duration, viewStart, viewEnd]);

  // Navegación de marcadores (Saltar al siguiente/anterior glitch pendiente visible)
  const handleNextMarker = useCallback(() => {
    if (!displayedGlitches || displayedGlitches.length === 0) return;
    const sorted = [...displayedGlitches]
      .filter(g => !g.repaired && g.time_secs > playheadTime + 0.001)
      .sort((a, b) => a.time_secs - b.time_secs);
    if (sorted.length > 0) {
      const nextGlitch = sorted[0];
      setPlayheadTime(nextGlitch.time_secs);
      centerViewportOnTime(nextGlitch.time_secs);
      if (isPlaying) {
        invoke('play_from_position', { timeSecs: nextGlitch.time_secs }).catch(console.error);
      }
    }
  }, [displayedGlitches, playheadTime, centerViewportOnTime, isPlaying]);

  const handlePrevMarker = useCallback(() => {
    if (!displayedGlitches || displayedGlitches.length === 0) return;
    const sorted = [...displayedGlitches]
      .filter(g => !g.repaired && g.time_secs < playheadTime - 0.001)
      .sort((a, b) => b.time_secs - a.time_secs);
    if (sorted.length > 0) {
      const prevGlitch = sorted[0];
      setPlayheadTime(prevGlitch.time_secs);
      centerViewportOnTime(prevGlitch.time_secs);
      if (isPlaying) {
        invoke('play_from_position', { timeSecs: prevGlitch.time_secs }).catch(console.error);
      }
    }
  }, [displayedGlitches, playheadTime, centerViewportOnTime, isPlaying]);

  // Controles de transporte
  const handlePlayPause = useCallback(async () => {
    try {
      if (isPlaying) {
        await invoke('stop_playback');
        setIsPlaying(false);
      } else {
        await invoke('play_from_position', { timeSecs: playheadTime });
        setIsPlaying(true);
      }
    } catch (err) {
      console.error('[Transport Error]:', err);
    }
  }, [isPlaying, playheadTime]);

  const handleStop = useCallback(async () => {
    try {
      await invoke('stop_playback');
      setIsPlaying(false);
      setPlayheadTime(0.0);
    } catch (err) {
      console.error('[Transport Error]:', err);
    }
  }, []);

  const handleTimelineClick = useCallback(async (timeSecs) => {
    setPlayheadTime(timeSecs);
    setLastClickTime(timeSecs);
    try {
      await invoke('stop_playback');
      setIsPlaying(false);
    } catch (err) {
      console.error('[Tauri Stop on Click Error]:', err);
    }
  }, []);

  // Comando de análisis manual de glitches (Separando visualización de análisis)
  const handleAnalyze = useCallback(async () => {
    updateSession({ status: 'analyzing' });
    try {
      const timeStart = viewStart * (duration || 1.0);
      const timeEnd = viewEnd * (duration || 1.0);

      console.log("[JS Debug] handleAnalyze: viewStart =", viewStart, "viewEnd =", viewEnd, "timeStart =", timeStart, "timeEnd =", timeEnd);

      const resGlitches = await invoke('ejecutar_deteccion_glitches', {
        activeFilters: selectedArtifacts,
        timeStart: timeStart,
        timeEnd: timeEnd,
        time_start: timeStart,
        time_end: timeEnd
      });

      // Si el viewport está con zoom activo, combinamos los nuevos glitches con los que estén fuera de la zona visible
      let updatedGlitches = resGlitches;
      if (viewStart > 0.0 || viewEnd < 1.0) {
        const flatRes = Array.isArray(resGlitches) ? resGlitches : [...(resGlitches.transients || []), ...(resGlitches.stationaries || [])];
        const untouchedGlitches = ((Array.isArray(glitches) ? glitches : (glitches?.transients || []).concat(glitches?.stationaries || [])) || []).filter(g => g.time_secs < timeStart || g.time_secs > timeEnd);
        updatedGlitches = [...untouchedGlitches, ...flatRes].sort((a, b) => a.time_secs - b.time_secs);
      } else {
        updatedGlitches = Array.isArray(resGlitches) ? resGlitches : [...(resGlitches.transients || []), ...(resGlitches.stationaries || [])];
      }

      updateSession({
        glitches: updatedGlitches,
        status: 'ready'
      });
      setIsAnalyzed(true);
    } catch (err) {
      console.error('[Tauri Analysis Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [selectedArtifacts, viewStart, viewEnd, duration, glitches, updateSession]);

  // Animación del Playhead mediante requestAnimationFrame
  const isPlayingRef = useRef(isPlaying);
  useEffect(() => {
    isPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!isPlaying) return;

    let lastTime = performance.now();
    let animId;

    const tick = () => {
      if (!isPlayingRef.current) return;
      const now = performance.now();
      const deltaSecs = (now - lastTime) / 1000.0;
      lastTime = now;

      setPlayheadTime(prev => {
        const next = prev + deltaSecs;
        if (next >= duration) {
          setIsPlaying(false);
          invoke('stop_playback').catch(console.error);
          return duration;
        }
        return next;
      });

      animId = requestAnimationFrame(tick);
    };

    animId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animId);
  }, [isPlaying, duration]);

  // Atajo de teclado global: Barra espaciadora para reproducir/pausar
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.code === 'Space') {
        e.preventDefault();
        handlePlayPause();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handlePlayPause]);

  // 2. Sincronización del Viewport (Tauri IPC a obtener_espectrograma_visible)
  const syncViewportSpectrogram = useCallback(() => {
    if (status !== 'ready' && status !== 'healing') return;

    if (pendingUpdateRef.current) return;
    pendingUpdateRef.current = true;

    requestAnimationFrame(async () => {
      const totalFrames = session.totalStftFrames || session.stftFrames || 1000;
      const config = {
        start_frame: 0,
        end_frame: totalFrames,
        max_texture_width: 2048, // Límite seguro para no colapsar la GPU
      };

      try {
        const res = await invoke('obtener_espectrograma_visible', { config });
        const decodedMatrix = res.matrix ? base64ToUint8Array(res.matrix) : null;
        updateSession({
          stftMatrix: decodedMatrix,
          stftFrames: res.num_frames,
          stftBins: res.num_bins,
        });
      } catch (err) {
        console.error('[Tauri IPC Error] No se pudo obtener el espectrograma paged:', err);
      } finally {
        pendingUpdateRef.current = false;
      }
    });
  }, [status, session.stftFrames, session.totalStftFrames, updateSession]);

  // Disparar sincronización al cargar el archivo
  useEffect(() => {
    syncViewportSpectrogram();
  }, [syncViewportSpectrogram]);

  // 3. Captura del scroll (Pan) y zoom (Ctrl + scroll) en el contenedor principal
  const handleWheel = useCallback((e) => {
    const range = viewEnd - viewStart;
    const delta = e.deltaY > 0 ? 0.05 : -0.05;

    if (e.ctrlKey) {
      // Zoom centrado
      const zoomFactor = 0.5;
      const newRange = Math.max(0.01, Math.min(1.0, range + delta * zoomFactor * range));
      const center = (viewStart + viewEnd) / 2;
      const nextStart = Math.max(0.0, center - newRange / 2);
      const nextEnd = Math.min(1.0, center + newRange / 2);
      setViewStart(nextStart);
      setViewEnd(nextEnd);
    } else {
      // Scroll horizontal
      const shift = delta * range * 0.4;
      let nextStart = viewStart + shift;
      let nextEnd = viewEnd + shift;

      if (nextStart < 0.0) {
        nextEnd -= nextStart;
        nextStart = 0.0;
      }
      if (nextEnd > 1.0) {
        nextStart -= (nextEnd - 1.0);
        nextEnd = 1.0;
      }
      setViewStart(Math.max(0.0, nextStart));
      setViewEnd(Math.min(1.0, nextEnd));
    }
  }, [viewStart, viewEnd]);

  useEffect(() => {
    const visualizer = visualizerContainerRef.current;
    if (!visualizer) return;

    const handleWheelNative = (e) => {
      e.preventDefault();
      handleWheel(e);
    };

    visualizer.addEventListener('wheel', handleWheelNative, { passive: false });
    return () => {
      visualizer.removeEventListener('wheel', handleWheelNative);
    };
  }, [handleWheel]);

  // 4. Centrar canvas sobre la muestra dañada al hacer clic en un glitch de la lista
  const handleGlitchFocus = useCallback((glitch) => {
    const fileDuration = duration || 1.0;
    const centerPercent = glitch.time_secs / fileDuration;

    // Zoom concentrado al 4% del archivo alrededor del glitch
    const zoomRange = 0.04;
    const nextStart = Math.max(0.0, centerPercent - zoomRange / 2);
    const nextEnd = Math.min(1.0, centerPercent + zoomRange / 2);

    setViewStart(nextStart);
    setViewEnd(nextEnd);
  }, [duration]);

  const handleGlitchClick = useCallback(async (glitch, idx) => {
    setSelectedGlitchIdx(idx);
    handleGlitchFocus(glitch);
    
    try {
      await invoke('preview_glitch_region', { timeSecs: glitch.time_secs });
      setIsPlaying(true);
    } catch (err) {
      console.error('[Preview Glitch Error]', err);
    }
  }, [handleGlitchFocus]);

  // 5. Invocación quirúrgica in-place de la reparación nativa en Rust
  const handleHealGlitch = useCallback(async (glitch) => {
    if (glitch.repaired) return;
    updateSession({ status: 'healing' });

    const totalFrames = session.totalStftFrames || session.stftFrames || 1000;
    const config = {
      start_frame: 0,
      end_frame: totalFrames,
      max_texture_width: 2048,
    };

    try {
      const resSpectrogram = await invoke('reparar_glitches_seleccionados', {
        glitches: [glitch],
        config,
        profile,
      });

      const decodedMatrix = resSpectrogram.matrix ? base64ToUint8Array(resSpectrogram.matrix) : null;

      const updatedGlitches = (Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).map(g => g.sample_index === glitch.sample_index ? { ...g, repaired: true } : g);

      updateSession({
        stftMatrix: decodedMatrix,
        stftFrames: resSpectrogram.num_frames,
        stftBins: resSpectrogram.num_bins,
        glitches: updatedGlitches,
        status: 'ready',
      });
    } catch (err) {
      console.error('[Tauri Healer Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [glitches, session.totalStftFrames, profile, updateSession]);

  // Reparar todos los glitches restantes
  const handleHealAll = useCallback(async () => {
    updateSession({ status: 'healing' });
    const pendingGlitches = displayedGlitches.filter(g => !g.repaired);

    const totalFrames = session.totalStftFrames || 1000;
    const config = {
      start_frame: 0,
      end_frame: totalFrames,
      max_texture_width: 2048,
    };

    try {
      const resSpectrogram = await invoke('reparar_glitches_seleccionados', {
        glitches: pendingGlitches,
        config,
        profile,
      });

      const decodedMatrix = resSpectrogram.matrix ? base64ToUint8Array(resSpectrogram.matrix) : null;

      const pendingIndices = new Set(pendingGlitches.map(pg => pg.sample_index));
      const updatedGlitches = (Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).map(g => pendingIndices.has(g.sample_index) ? { ...g, repaired: true } : g);

      updateSession({
        stftMatrix: decodedMatrix,
        stftFrames: resSpectrogram.num_frames,
        stftBins: resSpectrogram.num_bins,
        glitches: updatedGlitches,
        status: 'ready',
      });
    } catch (err) {
      console.error(err);
      updateSession({ status: 'ready' });
    }
  }, [displayedGlitches, glitches, session.totalStftFrames, profile, updateSession]);

  // 6. Preescuchar Audio (Toggle Playback con Rodio)
  const handleTogglePlayback = useCallback(async () => {
    try {
      const playing = await invoke('toggle_playback');
      setIsPlaying(playing);
    } catch (err) {
      console.error('[Tauri Playback Error]:', err);
    }
  }, []);

  // 6.2 Disparar re-análisis al cambiar el umbral (Directo en RAM)
  const triggerReanalysis = useCallback(async (val, filtersOverride = null) => {
    try {
      const timeStart = viewStart * (duration || 1.0);
      const timeEnd = viewEnd * (duration || 1.0);
      const resGlitches = await invoke('actualizar_umbral_detector', {
        threshold: val,
        activeFilters: filtersOverride || selectedArtifacts,
        timeStart: timeStart,
        timeEnd: timeEnd,
        time_start: timeStart,
        time_end: timeEnd
      });
      setBackendThreshold(val);
      updateSession({
        glitches: resGlitches,
        threshold: val,
      });
    } catch (err) {
      console.error('[Tauri Reanalysis Error]:', err);
    }
  }, [updateSession, viewStart, viewEnd, duration, selectedArtifacts]);

  // 7. Exportar Archivo WAV Nativo (Save Dialog + Export Command)
  const handleExport = useCallback(async () => {
    try {
      const defaultName = fileName.replace(/\.[^/.]+$/, '') + '_restored.wav';
      const filePath = await save({
        title: 'Exportar Audio Restaurado',
        filters: [{
          name: 'Audio WAV',
          extensions: ['wav']
        }],
        defaultPath: defaultName
      });

      if (filePath) {
        updateSession({ status: 'healing' }); // Activa el HUD de carga
        const resMessage = await invoke('export_repaired_file', { path: filePath });
        console.log(resMessage);
        updateSession({ status: 'ready' });
      }
    } catch (err) {
      console.error('[Tauri Export Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [fileName, updateSession]);

  // 7.2 Exportar Reporte de Auditoría a archivo TXT
  const handleExportReport = useCallback(async () => {
    try {
      const defaultName = fileName.replace(/\.[^/.]+$/, '') + '_audit_report.txt';
      const filePath = await save({
        title: 'Exportar Reporte de Auditoría',
        filters: [{
          name: 'Documento de Texto (.txt)',
          extensions: ['txt']
        }],
        defaultPath: defaultName
      });

      if (filePath) {
        updateSession({ status: 'analyzing' }); // Activa HUD de procesamiento temporal
        
        let report = `======================================================================\n`;
        report += `                     VOSTOK RESTORATION AUDIT REPORT\n`;
        report += `======================================================================\n`;
        report += `Archivo Original: ${fileName}\n`;
        report += `Duración: ${duration?.toFixed(3)} s\n`;
        report += `Sample Rate: ${sampleRate} Hz\n`;
        report += `Bit Depth: ${bitDepth}-bit\n`;
        report += `Canales: ${channels === 1 ? 'Mono' : 'Stereo'}\n`;
        report += `Umbral de Sensibilidad (Sensitivity): ${backendThreshold.toFixed(4)}\n`;
        report += `Filtro de Certeza UI (Certainty): ${Math.round(minConfidence * 100)}%\n`;
        report += `----------------------------------------------------------------------\n`;
        report += `Resumen:\n`;
        report += `  Total Glitches Detectados (Crudos): ${(Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).length}\n`;
        report += `  Glitches Filtrados Visibles: ${displayedGlitches.length}\n`;
        report += `  Glitches Pendientes: ${displayedGlitches.filter(g => !g.repaired).length}\n`;
        report += `======================================================================\n\n`;
        report += `DETALLE DE RUIDOS DETECTADOS:\n`;
        report += `----------------------------------------------------------------------\n`;
        report += `| #   | Tiempo (s) | Muestra Index | Tipo       | Certeza | Magnitud (ΔV) |\n`;
        report += `----------------------------------------------------------------------\n`;
        
        displayedGlitches.forEach((g, idx) => {
          const timeStr = g.time_secs.toFixed(4).padStart(10, ' ');
          const sampleStr = g.sample_index.toString().padStart(13, ' ');
          const typeStr = (g.artifact_type || 'GLITCH').padEnd(10, ' ');
          const confStr = `${Math.round((g.confidence || 1.0) * 100)}%`.padStart(7, ' ');
          const ampStr = g.amplitude_delta.toFixed(5).padStart(13, ' ');
          report += `| ${(idx + 1).toString().padEnd(3, ' ')} | ${timeStr} | ${sampleStr} | ${typeStr} | ${confStr} | ${ampStr} |\n`;
        });
        report += `----------------------------------------------------------------------\n\n`;

        // Telemetría específica de Hum
        const hums = displayedGlitches.filter(g => g.artifact_type === 'HUM');
        if (hums.length > 0) {
          report += `TELEMETRÍA DE HUM DETECTADA:\n`;
          hums.forEach((g, idx) => {
            if (g.hum_evidence) {
              report += `  Hum #${idx+1}: Tiempo: ${g.time_secs.toFixed(3)}s | CV: ${g.hum_evidence.cv.toFixed(3)} | Decaimiento Armónico: ${g.hum_evidence.harmonic_decay.toFixed(3)} | Persistencia: ${(g.hum_evidence.global_persistence * 100).toFixed(0)}%\n`;
            }
          });
          report += `\n`;
        }

        report += `======================================================================\n`;
        report += `Fin del Reporte - Vostok Standalone DSP Core v1.0\n`;
        report += `======================================================================\n`;

        await invoke('guardar_reporte_auditoria', { path: filePath, content: report });
        updateSession({ status: 'ready' });
      }
    } catch (err) {
      console.error('[Export Report Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [fileName, duration, sampleRate, bitDepth, channels, backendThreshold, minConfidence, glitches, displayedGlitches, updateSession]);

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toFixed(3);
    return `${m}:${s.padStart(6, '0')}`;
  };

  return (
    <div
      ref={containerRef}
      className="select-none"
      style={{
        width: '100%', height: '100%', display: 'grid',
        gridTemplateColumns: '1fr 340px', gridTemplateRows: '72px 1fr',
        gap: '12px', padding: '16px', backgroundColor: '#010101',
        color: '#fff', overflow: 'hidden', boxSizing: 'border-box'
      }}
    >
      {/* ── OVERLAY DE PROCESAMIENTO NATIVO ── */}
      {(status === 'healing' || status === 'analyzing') && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 100,
          background: 'rgba(1,1,1,0.85)',
          backdropFilter: 'blur(10px)',
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center', gap: '20px',
        }}>
          <div style={{ position: 'relative', width: 64, height: 64 }}>
            <div className="dot-pulse-green" style={{ width: 64, height: 64, filter: 'blur(10px)', opacity: 0.6 }} />
            <Cpu style={{ width: 64, height: 64, color: '#39FF14', position: 'absolute', top: 0, left: 0 }} />
          </div>
          <div style={{
            fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', fontWeight: 900,
            letterSpacing: '0.4em', color: '#39FF14', textTransform: 'uppercase'
          }}>
            {status === 'healing'
              ? "Vostok DSP Core: Reconstruyendo Hermite Spline..."
              : "Vostok DSP Core: Analizando transitorios de Glitch..."}
          </div>
        </div>
      )}

      {/* ── BLOQUE SUPERIOR (HUD) ── */}
      <div
        className="glass-panel"
        style={{
          gridColumn: '1 / span 2', gridRow: '1',
          border: '1px solid rgba(57,255,20,0.15)',
          borderRadius: '8px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          background: 'rgba(1,1,1,0.6)',
        }}
      >
        {/* Archivo y Retroceso */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <button
            onClick={onReset}
            style={{
              background: 'none', border: '1px solid rgba(255,255,255,0.15)',
              color: '#fff', borderRadius: '4px', cursor: 'pointer',
              padding: '6px 12px', display: 'flex', alignItems: 'center', gap: '6px',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '11px',
            }}
          >
            <ArrowLeft style={{ width: 14, height: 14 }} /> Volver
          </button>
          <div>
            <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '12px', fontWeight: 900, color: '#39FF14' }}>
              {fileName}
            </div>
            <div style={{ display: 'flex', gap: '14px', marginTop: '2px' }}>
              <span className="label-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>{sampleRate} Hz</span>
              <span className="label-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>{bitDepth}-bit PCM</span>
              <span className="label-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>{channels === 1 ? 'Mono' : 'Stereo'}</span>
              <span className="label-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>Duración: {duration?.toFixed(3)}s</span>
            </div>
          </div>
        </div>

        {/* Telemetría Central / Sensibilidad Slider */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', justifyContent: 'center' }}>
            <span style={{
              fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', fontWeight: 900,
              letterSpacing: '0.3em', color: '#39FF14',
            }}>ENGINE: TAURI-RUST SIMD ACTIVE</span>
            <div className="dot-pulse-green" style={{ width: 6, height: 6 }} />
          </div>

          {/* Selector de Perfil Espectral */}
          <div style={{ 
            display: 'flex', 
            background: 'rgba(0, 0, 0, 0.8)', 
            border: '1px solid rgba(57, 255, 20, 0.2)', 
            borderRadius: '4px', 
            padding: '2px', 
            margin: '4px 0' 
          }}>
            <button
              onClick={() => handleProfileChange('transient')}
              style={{
                background: profile === 'transient' ? 'rgba(57, 255, 20, 0.2)' : 'none',
                border: 'none',
                color: profile === 'transient' ? '#39FF14' : 'rgba(255, 255, 255, 0.6)',
                padding: '4px 10px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '9px',
                fontWeight: 900,
                borderRadius: '3px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              ⚡ Transitorios (1k FFT)
            </button>
            <button
              onClick={() => handleProfileChange('hum')}
              style={{
                background: profile === 'hum' ? 'rgba(57, 255, 20, 0.2)' : 'none',
                border: 'none',
                color: profile === 'hum' ? '#39FF14' : 'rgba(255, 255, 255, 0.6)',
                padding: '4px 10px',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '9px',
                fontWeight: 900,
                borderRadius: '3px',
                cursor: 'pointer',
                transition: 'all 0.2s',
                display: 'flex',
                alignItems: 'center',
                gap: '4px'
              }}
            >
              🔍 Precisión (4k FFT)
            </button>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '2px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: '8px', fontWeight: 900,
                letterSpacing: '0.15em', color: 'rgba(255,255,255,0.4)'
              }} title="Sensibilidad espectral del detector de transitorios (LPC/HFER)">
                SPECTRAL SENS:
              </span>
              <input
                type="range"
                min="0.01"
                max="0.25"
                step="0.01"
                value={localThreshold}
                onChange={(e) => setLocalThreshold(parseFloat(e.target.value))}
                onMouseUp={(e) => triggerReanalysis(parseFloat(e.target.value))}
                onTouchEnd={(e) => triggerReanalysis(parseFloat(e.target.value))}
                onKeyUp={(e) => {
                  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                    triggerReanalysis(parseFloat(e.target.value));
                  }
                }}
                className="vostok-slider"
                style={{ width: '100px' }}
              />
              <span style={{
                fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', fontWeight: 900,
                color: '#39FF14', minWidth: '40px', textAlign: 'left'
              }}>
                {localThreshold.toFixed(3)}
              </span>
            </div>
          </div>
        </div>

        {/* Botones de Control (Transporte, Exportar, Reparar Todo) */}
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          {/* Barra de Transporte (Estilo Reaper) */}
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center', background: 'rgba(0,0,0,0.8)', border: '1px solid rgba(255,255,255,0.1)', padding: '4px', borderRadius: '6px' }}>
            {/* Anterior Marcador */}
            <button
              onClick={handlePrevMarker}
              title="Anterior Glitch"
              style={{
                background: 'none', border: 'none', color: '#fff',
                cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center'
              }}
              className="transport-btn"
            >
              <SkipBack style={{ width: 16, height: 16 }} />
            </button>

            {/* Play/Pause */}
            <button
              onClick={handlePlayPause}
              title={isPlaying ? "Pausar" : "Reproducir"}
              style={{
                background: isPlaying ? 'rgba(57,255,20,0.2)' : 'none', border: 'none', color: isPlaying ? '#39FF14' : '#fff',
                cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center', borderRadius: '4px'
              }}
              className="transport-btn"
            >
              {isPlaying ? <Pause style={{ width: 16, height: 16 }} /> : <Play style={{ width: 16, height: 16 }} />}
            </button>

            {/* Stop */}
            <button
              onClick={handleStop}
              title="Detener"
              style={{
                background: 'none', border: 'none', color: '#fff',
                cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center'
              }}
              className="transport-btn"
            >
              <Square style={{ width: 16, height: 16 }} />
            </button>

            {/* Siguiente Marcador */}
            <button
              onClick={handleNextMarker}
              title="Siguiente Glitch"
              style={{
                background: 'none', border: 'none', color: '#fff',
                cursor: 'pointer', padding: '6px', display: 'flex', alignItems: 'center'
              }}
              className="transport-btn"
            >
              <SkipForward style={{ width: 16, height: 16 }} />
            </button>
          </div>

          {/* Botón: Analizar Audio */}
          <button
            onClick={handleAnalyze}
            style={{
              background: 'rgba(0, 0, 0, 0.6)', border: '1px solid #39FF14', color: '#39FF14',
              borderRadius: '4px', cursor: 'pointer', padding: '8px 16px',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            <Zap style={{ width: 14, height: 14 }} /> Analizar Audio
          </button>

          {/* Botón B: Exportar WAV */}
          <button
            onClick={handleExport}
            style={{
              background: 'rgba(0, 0, 0, 0.6)', border: '1px solid #39FF14', color: '#39FF14',
              borderRadius: '4px', cursor: 'pointer', padding: '8px 16px',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            <Download style={{ width: 14, height: 14 }} /> Exportar WAV
          </button>

          {/* Botón B.2: Exportar Reporte TXT */}
          <button
            onClick={handleExportReport}
            style={{
              background: 'rgba(0, 0, 0, 0.6)', border: '1px solid #39FF14', color: '#39FF14',
              borderRadius: '4px', cursor: 'pointer', padding: '8px 16px',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900,
              display: 'flex', alignItems: 'center', gap: '8px',
            }}
          >
            <Download style={{ width: 14, height: 14 }} /> Exportar Reporte
          </button>

          {/* Botón C: Reparar Todo */}
          <button
            onClick={handleHealAll}
            disabled={displayedGlitches.filter(g => !g.repaired).length === 0}
            style={{
              background: '#39FF14', border: 'none', color: '#010101',
              borderRadius: '4px', cursor: 'pointer', padding: '8px 16px',
              fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900,
              display: 'flex', alignItems: 'center', gap: '8px',
              opacity: displayedGlitches.filter(g => !g.repaired).length === 0 ? 0.3 : 1
            }}
          >
            <Zap style={{ width: 14, height: 14 }} /> Reparar Todo ({displayedGlitches.filter(g => !g.repaired).length})
          </button>
        </div>
      </div>

      {/* ── BLOQUE CENTRAL (Workstation Espectrograma + Scrubbers) ── */}
      <div
        ref={visualizerContainerRef}
        style={{
          gridColumn: '1', gridRow: '2',
          display: 'flex', flexDirection: 'column', gap: '8px',
          overflow: 'hidden'
        }}
      >
        <div style={{ flex: 1, display: 'flex', gap: '8px', position: 'relative', overflow: 'hidden' }}>
          <div
            className="glass-panel"
            style={{
              flex: 1,
              position: 'relative', overflow: 'hidden',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: '8px', background: 'rgba(1, 1, 1, 0.4)',
            }}
          >
            <SpectrogramGL
              matrix={stftMatrix}
              frames={stftFrames}
              bins={stftBins}
              sampleRate={sampleRate}
              glitches={displayedGlitches}
              viewStart={viewStart}
              viewEnd={viewEnd}
              viewYStart={viewYStart}
              viewYEnd={viewYEnd}
              duration={duration}
              onGlitchClick={handleGlitchClick}
              selectedGlitchIdx={selectedGlitchIdx}
              playheadTime={playheadTime}
              onTimelineClick={handleTimelineClick}
            />
          </div>

          {/* Vertical Scrubber (Eje Y / Frecuencia) */}
          <VerticalScrubber
            viewStart={viewYStart}
            viewEnd={viewYEnd}
            onViewportChange={handleViewportYChange}
          />
        </div>

        {/* Timeline Scrubber */}
        <div style={{ display: 'flex', alignItems: 'center', width: '100%', padding: '0 4px' }}>
          <TimelineScrubber
            viewStart={viewStart}
            viewEnd={viewEnd}
            onViewportChange={handleViewportChange}
          />
        </div>
      </div>

      {/* ── BLOQUE LATERAL (Inspector de Glitches o Filtros de Diagnóstico) ── */}
      <div
        className="glass-panel"
        style={{
          gridColumn: '2', gridRow: '2',
          overflow: 'hidden', display: 'flex', flexDirection: 'column',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: '8px', background: 'rgba(5, 5, 5, 0.8)',
        }}
      >
        {!isAnalyzed ? (
          /* PANTALLA DE CONFIGURACIÓN DE FILTROS */
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Header */}
            <div style={{
              padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900, color: '#39FF14', letterSpacing: '0.1em' }}>
                FILTROS DE DIAGNÓSTICO
              </span>
            </div>

            {/* Checklist de Artefactos */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <p style={{ fontFamily: 'var(--font-ui)', fontSize: '11px', color: 'rgba(255,255,255,0.4)', lineHeight: '1.5' }}>
                Selecciona las firmas de audio y artefactos digitales que deseas escanear en esta Workstation:
              </p>

              {/* Opción Seleccionar Todos */}
              <label 
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '10px 14px',
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.1)',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  transition: 'all 0.2s',
                  userSelect: 'none'
                }}
              >
                <input 
                  type="checkbox" 
                  checked={allSelected} 
                  onChange={(e) => handleToggleSelectAll(e.target.checked)}
                  style={{
                    accentColor: '#39FF14',
                    width: '16px',
                    height: '16px',
                    cursor: 'pointer'
                  }}
                />
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900, color: allSelected ? '#39FF14' : '#fff' }}>
                  ☑️ SELECCIONAR TODOS
                </span>
              </label>

              {/* Grid de Checkboxes de diagnóstico */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '4px' }}>
                {[
                  { key: 'clicks', label: '⚡ Clicks & Spikes' },
                  { key: 'pops', label: '🔊 Pops & Low Thumps' },
                  { key: 'hum', label: '🔌 Hum de Red (50/60Hz)' },
                  { key: 'clipping', label: '🟥 Clipping (Recorte)' },
                  { key: 'dropouts', label: '📉 Dropouts (Caídas)' },
                  { key: 'hiss', label: '🐍 Siseo / Hiss' },
                ].map(({ key, label }) => (
                  <label 
                    key={key} 
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '12px',
                      padding: '10px 14px',
                      background: selectedArtifacts[key] ? 'rgba(57,255,20,0.08)' : 'rgba(255,255,255,0.02)',
                      border: selectedArtifacts[key] ? '1px solid rgba(57,255,20,0.25)' : '1px solid rgba(255,255,255,0.05)',
                      borderRadius: '6px',
                      cursor: 'pointer',
                      transition: 'all 0.15s',
                      userSelect: 'none'
                    }}
                  >
                    <input 
                      type="checkbox" 
                      checked={selectedArtifacts[key]} 
                      onChange={(e) => setSelectedArtifacts(prev => ({ ...prev, [key]: e.target.checked }))}
                      style={{
                        accentColor: '#39FF14',
                        width: '16px',
                        height: '16px',
                        cursor: 'pointer'
                      }}
                    />
                    <span style={{
                      fontFamily: 'JetBrains Mono, monospace',
                      fontSize: '11px',
                      fontWeight: 900,
                      color: selectedArtifacts[key] ? '#39FF14' : '#fff'
                    }}>
                      {label}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            {/* Botón de Acción Base */}
            <div style={{ padding: '16px', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
              <button
                onClick={handleAnalyze}
                style={{
                  width: '100%',
                  background: '#39FF14', border: 'none', color: '#010101',
                  borderRadius: '4px', cursor: 'pointer', padding: '12px',
                  fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900,
                  display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
                  boxShadow: '0 0 10px rgba(57,255,20,0.3)',
                }}
              >
                <Zap style={{ width: 14, height: 14 }} /> ANALIZAR AUDIO
              </button>
            </div>
          </div>
        ) : (
          /* INSPECTOR DE GLITCHES CLÁSICO */
          <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* header del panel */}
            <div style={{
              padding: '16px', borderBottom: '1px solid rgba(255,255,255,0.08)',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900, color: '#39FF14' }}>
                  INSPECTOR DE GLITCHES
                </span>
                <button
                  onClick={() => setIsAnalyzed(false)}
                  style={{
                    background: 'none', border: '1px solid rgba(57,255,20,0.3)',
                    color: '#39FF14', borderRadius: '4px', cursor: 'pointer',
                    padding: '2px 6px', fontSize: '9px', fontFamily: 'JetBrains Mono, monospace',
                  }}
                  title="Ajustar Filtros de Diagnóstico"
                >
                  ⚙️ Filtros
                </button>
              </div>
              <span className="label-xs" style={{ background: 'rgba(57,255,20,0.15)', color: '#39FF14', padding: '2px 6px', borderRadius: '4px' }}>
                {displayedGlitches.filter(g => !g.repaired).length} PENDIENTES
              </span>
            </div>

            {/* Cabeceras de Ordenamiento */}
            <div style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              background: 'rgba(0,0,0,0.1)',
            }}>
              {[
                { label: 'Tiempo', field: 'time' },
                { label: 'Magnitud', field: 'magnitude' },
                { label: 'CONF.', field: 'confidence' },
              ].map(({ label, field }) => (
                <span
                  key={field}
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: '8px',
                    fontWeight: 900,
                    cursor: 'pointer',
                    color: sortBy === field ? '#39FF14' : 'rgba(255,255,255,0.4)',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '2px',
                    userSelect: 'none'
                  }}
                  onClick={() => {
                    if (sortBy === field) {
                      setSortAsc(p => !p);
                    } else {
                      setSortBy(field);
                      setSortAsc(field === 'time'); // Ascending for time, descending for confidence/magnitude
                    }
                  }}
                >
                  {label} {sortBy === field ? (sortAsc ? '▲' : '▼') : ''}
                </span>
              ))}
            </div>

            {/* Filtro de Certeza */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: '8px 16px',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(0,0,0,0.2)',
            }}>
              <span style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '8px',
                fontWeight: 900,
                color: 'rgba(255,255,255,0.5)',
                letterSpacing: '0.1em'
              }}>
                FILTRO CERTEZA:
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                  className="vostok-slider"
                  style={{ width: '80px' }}
                />
                <span style={{
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '9px',
                  fontWeight: 900,
                  color: '#39FF14',
                  minWidth: '32px',
                  textAlign: 'right'
                }}>
                  {Math.round(minConfidence * 100)}%
                </span>
              </div>
            </div>

            {/* Lista de Glitches */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
              {displayedGlitches.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.3, gap: '8px' }}>
                  <Volume2 style={{ width: 24, height: 24 }} />
                  <span className="label-xs">Cero ruidos detectados</span>
                </div>
              ) : (
                [...displayedGlitches]
                  .sort((a, b) => {
                    let aVal, bVal;
                    if (sortBy === 'time') {
                      aVal = a.time_secs;
                      bVal = b.time_secs;
                    } else if (sortBy === 'magnitude') {
                      aVal = a.amplitude_delta;
                      bVal = b.amplitude_delta;
                    } else {
                      aVal = a.confidence !== undefined ? a.confidence : 1.0;
                      bVal = b.confidence !== undefined ? b.confidence : 1.0;
                    }
                    return sortAsc ? aVal - bVal : bVal - aVal;
                  })
                  .map((glitch) => {
                    const tagColor = getArtifactTagColor(glitch.artifact_type);
                    const conf = glitch.confidence !== undefined ? glitch.confidence : 1.0;
                    
                    let confColor = '#39FF14';
                    if (conf < 0.5) {
                      confColor = '#FFB000'; // Amber
                    } else if (conf < 0.8) {
                      confColor = 'rgba(57, 255, 20, 0.6)'; // Translucent green
                    }

                    return (
                      <div
                        key={glitch.originalIdx}
                        onClick={() => handleGlitchClick(glitch, glitch.originalIdx)}
                        style={{
                          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                          padding: '10px 12px',
                          border: selectedGlitchIdx === glitch.originalIdx ? '1px solid #39FF14' : '1px solid rgba(255,255,255,0.05)',
                          borderRadius: '4px', marginBottom: '6px', cursor: 'pointer',
                          background: selectedGlitchIdx === glitch.originalIdx ? 'rgba(57,255,20,0.15)' : (glitch.repaired ? 'rgba(57,255,20,0.02)' : 'rgba(255,255,255,0.01)'),
                          transition: 'all 0.2s',
                        }}
                        className="hover-glitch-item"
                      >
                        <div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: glitch.repaired ? 'rgba(57,255,20,0.5)' : '#fff' }}>
                              {formatTime(glitch.time_secs)}
                            </span>
                            <span 
                              className="label-xs" 
                              style={{
                                textTransform: 'uppercase', 
                                fontSize: '8px', 
                                border: `1px solid ${tagColor}`,
                                color: tagColor,
                                padding: '1px 4px',
                                borderRadius: '3px',
                                background: 'rgba(1, 1, 1, 0.4)',
                                fontWeight: 900
                              }}
                            >
                              {glitch.artifact_type || glitch.event_type}
                            </span>
                            <span style={{
                              fontFamily: 'JetBrains Mono, monospace',
                              fontSize: '8px',
                              fontWeight: 900,
                              color: confColor,
                              background: 'rgba(0,0,0,0.3)',
                              padding: '1px 4px',
                              borderRadius: '3px',
                              border: `1px solid ${confColor}40`
                            }}>
                              {Math.round(conf * 100)}% CONF
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginTop: '4px' }}>
                            <div style={{
                              width: '30px',
                              height: '3px',
                              background: 'rgba(255,255,255,0.05)',
                              borderRadius: '1px',
                              overflow: 'hidden',
                              display: 'inline-block'
                            }}>
                              <div style={{
                                width: `${Math.round(conf * 100)}%`,
                                height: '100%',
                                background: confColor,
                              }} />
                            </div>
                            <span className="label-xs" style={{ color: 'rgba(255,255,255,0.4)' }}>
                              {glitch.artifact_type && glitch.artifact_type.toUpperCase().includes("HUM") 
                                ? (glitch.hum_evidence 
                                    ? `Amp: ${glitch.amplitude_delta.toFixed(5)} · CV: ${glitch.hum_evidence.cv.toFixed(3)} · Decay: ${glitch.hum_evidence.harmonic_decay.toFixed(2)} · GP: ${(glitch.hum_evidence.global_persistence * 100).toFixed(0)}%`
                                    : `Amplitud: ${glitch.amplitude_delta.toFixed(5)}`
                                  )
                                : `ΔV: ${glitch.amplitude_delta.toFixed(4)} · Index: ${glitch.sample_index}`
                              }
                            </span>
                          </div>
                        </div>

                        {/* Botón quirúrgico de reparación */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleHealGlitch(glitch);
                          }}
                          disabled={glitch.repaired}
                          style={{
                            background: glitch.repaired ? 'rgba(255,255,255,0.05)' : 'rgba(57,255,20,0.1)',
                            border: glitch.repaired ? '1px solid rgba(255,255,255,0.1)' : '1px solid rgba(57,255,20,0.4)',
                            color: glitch.repaired ? 'rgba(255,255,255,0.3)' : '#39FF14',
                            borderRadius: '4px', cursor: glitch.repaired ? 'default' : 'pointer',
                            padding: '4px 8px', fontSize: '9px', fontFamily: 'JetBrains Mono, monospace',
                          }}
                        >
                          {glitch.repaired ? 'Reparado' : 'Reparar'}
                        </button>
                      </div>
                    );
                  })
              )}
            </div>
          </div>
        )}
      </div>


    </div>
  );
}
