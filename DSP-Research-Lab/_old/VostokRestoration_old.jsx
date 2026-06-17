/**
 * VostokRestoration.jsx — Componente Workspace Principal para la App Standalone (Tauri + Rust)
 *
 * Utiliza Bento Grid (Noir-Tech), fondo #010101, acentos en #39FF14.
 * Conecta los controles de zoom/scroll con la API IPC de Tauri.
 */
import { useState, useEffect, useRef, useCallback, useMemo, useReducer, Profiler } from 'react';
import { ArrowLeft, Download, Zap, Cpu, Volume2, Play, Pause, Square, SkipBack, SkipForward } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import SpectrogramGL, { PlaybackCursor } from './SpectrogramGL.jsx';
import TimelineScrubber from './TimelineScrubber.jsx';
import VerticalScrubber from './VerticalScrubber.jsx';

function parseBinarySpectrogram(responseBytes) {
  if (!responseBytes) return null;
  const tStart = performance.now();

  // Tauri serializa Vec<u8> como ArrayBuffer nativo.
  // Normalizamos cualquier variante TypedArray al ArrayBuffer subyacente.
  let buffer, byteOffset, byteLength;
  if (responseBytes instanceof ArrayBuffer) {
    buffer     = responseBytes;
    byteOffset = 0;
    byteLength = responseBytes.byteLength;
  } else {
    // Uint8Array / Int8Array / vista tipada — extraer el buffer subyacente
    const view = ArrayBuffer.isView(responseBytes)
      ? responseBytes
      : new Uint8Array(responseBytes);
    buffer     = view.buffer;
    byteOffset = view.byteOffset;
    byteLength = view.byteLength;
  }

  // Header: 2 × u32 little-endian  [0..4) frames  [4..8) bins
  const dv        = new DataView(buffer, byteOffset, byteLength);
  const num_frames = dv.getUint32(0, true);
  const num_bins   = dv.getUint32(4, true);

  // Payload: u8 magnitudes zero-copy (vista directa, sin copia)
  const matrix = new Uint8Array(buffer, byteOffset + 8, num_frames * num_bins);

  console.log(`[VOSTOK MEMORY] BINARY_PARSING | ELAPSED: ${(performance.now() - tStart).toFixed(3)}ms | FRAMES: ${num_frames} | BINS: ${num_bins}`);
  return { matrix, num_frames, num_bins };
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

function cleanGlitchForBackend(g) {
  return {
    sample_index: typeof g.sample_index === 'number' ? g.sample_index : 0,
    time_secs: typeof g.time_secs === 'number' ? g.time_secs : (g.start_time_secs || 0.0),
    amplitude_delta: typeof g.amplitude_delta === 'number' ? g.amplitude_delta : (g.average_db || 0.0),
    direction: typeof g.direction === 'number' ? g.direction : 0,
    event_type: typeof g.event_type === 'string' ? g.event_type.toLowerCase() : 'sample',
    repaired: !!g.repaired,
    artifact_type: g.artifact_type || '',
    confidence: typeof g.confidence === 'number' ? g.confidence : 1.0,
    hum_evidence: g.hum_evidence || null
  };
}

// Lock global de módulo para evitar dobles disparos en StrictMode o remounts rápidos
let GLOBAL_IS_FETCHING = false;

// ALMACENAMIENTO BINARIO GLOBAL (Noir-Tech Zero-Copy)
// Exportado para que LandingView pueda depositar la matriz directamente
// sin pasar binarios pesados por el estado de React.
export const SPECTROGRAM_STORAGE = {
  transient: null,
  hum: null
};

// PERF-003 / MEM-001: Helper de instrumentación de memoria
const logVostokMemory = (label, session, profile) => {
  const mem = (window.performance && window.performance.memory) || { usedJSHeapSize: 0 };
  const heapUsed = mem.usedJSHeapSize;
  
  const currentMatrix = SPECTROGRAM_STORAGE[profile || 'hum'];
  const arrayBytes = (currentMatrix ? currentMatrix.byteLength : 0) + 
                     (session.samples ? session.samples.byteLength : 0);
  
  const glitchesRaw = session.glitches || [];
  const glitchCount = Array.isArray(glitchesRaw) ? glitchesRaw.length : 
                      ((glitchesRaw.transients?.length || 0) + (glitchesRaw.stationaries?.length || 0));

  console.log(`[VOSTOK MEMORY] ${label} | HEAP_USED: ${(heapUsed / 1024 / 1024).toFixed(2)} MB | ARRAY_BYTES: ${(arrayBytes / 1024 / 1024).toFixed(2)} MB | OBJECT_COUNT_EST: ~${glitchCount}`);
};

// Viewport reducer — fuera del componente para evitar re-creación en cada render
// Un solo dispatch = un solo commit de React (vs. dos setState que producen 2 renders)
function viewportReducer(_state, action) {
  return {
    start: Math.max(0.0, action.start),
    end:   Math.min(1.0, action.end),
  };
}
const INITIAL_VIEWPORT = { start: 0.0, end: 1.0 };

// Global render counter for VostokRestoration
let VOSTOK_RENDER_COUNT = 0;

export default function VostokRestoration({ session, updateSession, onReset }) {
  const tRenderStart = performance.now();
  VOSTOK_RENDER_COUNT++;
  console.log(`[VOSTOK PROFILE] RENDER_BEGIN | COMPONENT: VostokRestoration | COUNT: ${VOSTOK_RENDER_COUNT}`);

  const { fileName, duration, sampleRate, channels, bitDepth, glitches, stftFrames, stftBins, status, matrixVersion } = session;

  // Fallback defensivo para la caché persistente
  const spectrogramCache = session.spectrogramCache || { transient: null, hum: null };

  // Acceso directo a la matriz actual basada en el perfil (Noir-Tech Zero-Copy)
  const stftMatrix = SPECTROGRAM_STORAGE[session.profile || 'hum'];

  const containerRef = useRef(null);
  const visualizerContainerRef = useRef(null);
  const isFetchingInitial = useRef(false);

  // 1. Viewport unificado (F-1): useReducer garantiza un único commit de React por gesto
  const [viewport, dispatchViewport] = useReducer(viewportReducer, INITIAL_VIEWPORT);
  // Alias transparentes: todo el JSX descendiente sigue funcionando sin cambios
  const viewStart = viewport.start;
  const viewEnd   = viewport.end;
  const [isPlaying, setIsPlaying] = useState(false);
  const [localThreshold, setLocalThreshold] = useState(session.threshold || 0.01);
  const [backendThreshold, setBackendThreshold] = useState(session.threshold || 0.01);
  const [selectedGlitchIdx, setSelectedGlitchIdx] = useState(null);
  const [profile, setProfile] = useState(session.profile || 'hum');
  const [isAnalyzed, setIsAnalyzed] = useState(false);
  const [isCanvasReady, setIsCanvasReady] = useState(false);

  const [selectedArtifacts, setSelectedArtifacts] = useState({
    clicks: true,
    pops: true,
    hum: false,
    clipping: true,
    dropouts: false,
    hiss: false
  });
  const [sortBy, setSortBy] = useState('time'); // 'time' | 'magnitude' | 'confidence'
  const [sortAsc, setSortAsc] = useState(true);
  const [minConfidence, setMinConfidence] = useState(0.15); // Default certainty filter (15%)
  const [healingProgress, setHealingProgress] = useState({}); // originalIdx -> number (0 a 100)
  const [globalHealingProgress, setGlobalHealingProgress] = useState(null); // number or null

  const [toasts, setToasts] = useState([]);
  const showToast = useCallback((message) => {
    const id = Date.now() + Math.random().toString(36).substr(2, 9);
    setToasts(prev => [...prev, { id, message }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 2000);
  }, []);


  // Path rápido: LandingView deposita en SPECTROGRAM_STORAGE ANTES de montar este componente.
  // Al montar con status:'ready', si ya hay matriz en storage, habilitamos el canvas directamente.
  useEffect(() => {
    if (status === 'ready' && SPECTROGRAM_STORAGE[session.profile || 'hum']) {
      setIsCanvasReady(true);
    }
  // Solo al montar (matrixVersion como proxy de "nuevo archivo cargado")
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.matrixVersion]);


  // Carga inicial del archivo cuando se monta en estado 'loading'
  useEffect(() => {
    // Condición de arranque: solo si hay archivo y no hay una carga ya en curso
    if (status !== 'loading' || !session.filePath || isFetchingInitial.current) return;

    // FIX F-3 + StrictMode: Limpiar caché de sesión anterior ANTES de comprobar stftMatrix.
    // SPECTROGRAM_STORAGE es un módulo global que persiste entre sesiones. Si tiene datos
    // viejos, stftMatrix sería truthy y bloquearía la carga del nuevo archivo.
    SPECTROGRAM_STORAGE.transient = null;
    SPECTROGRAM_STORAGE.hum = null;

    isFetchingInitial.current = true;
    setIsCanvasReady(false);
    let active = true;

    // Emergency fallback: liberar el lock tras 30s si el proceso se queda en el limbo
    const emergencyTimeout = setTimeout(() => {
      if (isFetchingInitial.current) {
        console.warn('[Vostok] Liberando lock de carga por timeout de emergencia');
        isFetchingInitial.current = false;
      }
    }, 30000);

    const loadInitial = async () => {
      try {
        console.log('[Vostok] FASE 1: Iniciando carga y análisis...');
        const analysis = await invoke('cargar_y_analizar_archivo', { path: session.filePath, threshold: -1.0 });

        console.log('[Vostok] FASE 2: Obteniendo textura espectral...');
        const config = {
          start_frame: 0,
          end_frame: analysis.stft_frames,
          max_texture_width: 16384,
        };
        
        const stftRes = await invoke('obtener_espectrograma_visible', { config });
        const parsed = parseBinarySpectrogram(stftRes);

        // POBLAR CACHÉ PERSISTENTE (Noir-Tech Storage & Metadata)
        const initialCache = { transient: null, hum: null };
        if (parsed) {
          SPECTROGRAM_STORAGE['hum'] = parsed.matrix;
          initialCache['hum'] = {
            frames: parsed.num_frames,
            bins: parsed.num_bins,
            totalFrames: analysis.stft_frames,
            threshold: analysis.recommended_threshold
          };
        }

        if (!active) return; // El efecto fue cancelado (StrictMode cleanup)

        console.log('[Vostok] Finalizando sincronización de estado.');
        updateSession({
          duration: analysis.duration_seconds,
          sampleRate: analysis.sample_rate,
          channels: analysis.channels,
          bitDepth: analysis.bit_depth,
          glitches: analysis.glitches,
          stftFrames: parsed ? parsed.num_frames : 0,
          stftBins: parsed ? parsed.num_bins : 0,
          totalStftFrames: analysis.stft_frames,
          status: 'ready',
          threshold: analysis.recommended_threshold,
          matrixVersion: session.matrixVersion + 1,
          spectrogramCache: initialCache
        });
        setLocalThreshold(analysis.recommended_threshold);
        setBackendThreshold(analysis.recommended_threshold);

        // FUSIBLE DE HANDSHAKE: Si en 2s el canvas no dice "listo", lo forzamos
        setTimeout(() => {
          setIsCanvasReady(true);
        }, 2000);

      } catch (err) {
        console.error('[Vostok Error]:', err);
        if (active) onReset();
      } finally {
        isFetchingInitial.current = false;
        clearTimeout(emergencyTimeout);
      }
    };
    loadInitial();

    return () => {
      active = false;
      // FIX StrictMode: resetear el lock para que el segundo montaje pueda ejecutar la carga
      isFetchingInitial.current = false;
      clearTimeout(emergencyTimeout);
    };
  // stftMatrix eliminado del dep array: ya no es condición de guarda (se limpia al inicio)
  }, [status, session.filePath, updateSession, onReset, session.matrixVersion]);


  // Filter glitches dynamically based on the confidence score
  const displayedGlitches = useMemo(() => {
    const tMemoStart = performance.now();
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
    
    const result = allEvents
      .map((g, idx) => ({ ...g, originalIdx: idx, time_secs: g.time_secs !== undefined ? g.time_secs : g.start_time_secs, sample_index: g.sample_index !== undefined ? g.sample_index : 0, amplitude_delta: g.amplitude_delta !== undefined ? g.amplitude_delta : (g.average_db !== undefined ? g.average_db : 0.0) }))
      .filter(g => {
        const conf = g.confidence !== undefined ? g.confidence : 1.0;
        return conf >= minConfidence;
      });
    console.log(`[VOSTOK PROFILE] MEMO_DISPLAYED_GLITCHES | ELAPSED: ${(performance.now() - tMemoStart).toFixed(3)}ms`);
    return result;
  }, [glitches, minConfidence]);

  const [visibleCount, setVisibleCount] = useState(100);

  // Reset de la paginación al cambiar de diagnóstico o filtro de certeza
  useEffect(() => {
    const tEffectStart = performance.now();
    console.log('[VOSTOK PROFILE] EFFECT_BEGIN | ID: ResetPagination');
    setVisibleCount(100);
    console.log(`[VOSTOK PROFILE] EFFECT_END | ID: ResetPagination | ELAPSED: ${(performance.now() - tEffectStart).toFixed(3)}ms`);
  }, [minConfidence, glitches]);

  const sortedGlitches = useMemo(() => {
    const tMemoStart = performance.now();
    const result = [...displayedGlitches].sort((a, b) => {
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
    });
    console.log(`[VOSTOK PROFILE] MEMO_SORTED_GLITCHES | ELAPSED: ${(performance.now() - tMemoStart).toFixed(3)}ms`);
    return result;
  }, [displayedGlitches, sortBy, sortAsc]);

  const visibleGlitches = useMemo(() => {
    const tMemoStart = performance.now();
    const result = sortedGlitches.slice(0, visibleCount);
    console.log(`[VOSTOK PROFILE] MEMO_VISIBLE_GLITCHES | ELAPSED: ${(performance.now() - tMemoStart).toFixed(3)}ms`);
    return result;
  }, [sortedGlitches, visibleCount]);

  const pendingGlitchesCount = useMemo(() => {
    const tMemoStart = performance.now();
    const result = displayedGlitches.filter(g => !g.repaired).length;
    console.log(`[VOSTOK PROFILE] MEMO_PENDING_COUNT | ELAPSED: ${(performance.now() - tMemoStart).toFixed(3)}ms`);
    return result;
  }, [displayedGlitches]);

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
    if (newProfile === profile) return;

    // PERF-004: FRONTEND_START
    performance.mark('profile-switch-start');
    console.log('[VOSTOK PROFILE] FRONTEND_START | FROM:', profile, '| TO:', newProfile);
    
    // MEM-001: Pre-switch memory snapshot
    logVostokMemory('PRE_PROFILE_SWITCH', session, profile);

    // 1. Intentar recuperar de la caché persistente
    const cached = spectrogramCache[newProfile];
    if (cached) {
      console.log('[VOSTOK PROFILE] FRONTEND_CACHE_HIT | PROFILE:', newProfile);
      
      console.log('[VOSTOK PROFILE] STATE_UPDATE_BATCH_START');
      const tStateStart = performance.now();
      
      // TRIGGER 1: Local profile change
      setProfile(newProfile);
      
      // TRIGGER 2: Canvas reset
      setIsCanvasReady(false);
      
      // TRIGGER 3: Parent session update
      updateSession({
        stftFrames: cached.frames,
        stftBins: cached.bins,
        totalStftFrames: cached.totalFrames,
        threshold: cached.threshold,
        profile: newProfile,
        status: 'ready',
        matrixVersion: session.matrixVersion + 1
      });
      
      // TRIGGER 4: Threshold syncs
      setLocalThreshold(cached.threshold);
      setBackendThreshold(cached.threshold);

      console.log('[VOSTOK PROFILE] REACT_STATE_CALLS_COMPLETE | ELAPSED:', (performance.now() - tStateStart).toFixed(3), 'ms');

      // FUSIBLE DE HANDSHAKE: Si en 2s el canvas no dice "listo", lo forzamos
      setTimeout(() => {
        setIsCanvasReady(true);
      }, 2000);

      return;
    }

    // 2. Si no hay caché (Cache MISS), calcular normalmente
    console.log('[VOSTOK PROFILE] FRONTEND_CACHE_MISS | PROFILE:', newProfile);
    setProfile(newProfile);
    setIsCanvasReady(false);
    updateSession({ status: 'analyzing' });
    try {
      const tBackendStart = performance.now();
      const analysis = await invoke('calcular_espectrograma', { profile: newProfile });
      
      const config = {
        start_frame: 0,
        end_frame: analysis.stft_frames,
        max_texture_width: 16384,
      };
      
      const stftRes = await invoke('obtener_espectrograma_visible', { config });
      console.log('[VOSTOK PROFILE] BACKEND_WAIT | ELAPSED:', (performance.now() - tBackendStart).toFixed(3), 'ms');

      const parsed = parseBinarySpectrogram(stftRes);
      
      // POBLAR CACHÉ PERSISTENTE (Noir-Tech Storage)
      const newCache = { ...spectrogramCache };
      if (parsed) {
        SPECTROGRAM_STORAGE[newProfile] = parsed.matrix;
        newCache[newProfile] = {
          frames: parsed.num_frames,
          bins: parsed.num_bins,
          totalFrames: analysis.stft_frames,
          threshold: analysis.recommended_threshold
        };
      }

      const tStateStart = performance.now();
      updateSession({
        stftFrames: parsed ? parsed.num_frames : 0,
        stftBins: parsed ? parsed.num_bins : 0,
        totalStftFrames: analysis.stft_frames,
        threshold: analysis.recommended_threshold,
        profile: newProfile,
        status: 'ready',
        spectrogramCache: newCache,
        matrixVersion: session.matrixVersion + 1
      });
      console.log('[VOSTOK PROFILE] REACT_UPDATE (New) | ELAPSED:', (performance.now() - tStateStart).toFixed(3), 'ms');

      // MEM-001: Post-switch memory snapshot (New)
      logVostokMemory('POST_PROFILE_SWITCH (New Data)', session, newProfile);
      
      setLocalThreshold(analysis.recommended_threshold);
      setBackendThreshold(analysis.recommended_threshold);
    } catch (err) {
      console.error('[Profile Change Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [profile, spectrogramCache, updateSession, session.matrixVersion, session.samples, session.glitches]);

  // Transport and Seeking states (Estilo Reaper)
  const [playheadTime, setPlayheadTime] = useState(0.0);
  const [lastClickTime, setLastClickTime] = useState(0.0);

  const handleViewportChange = useCallback((start, end) => {
    dispatchViewport({ start, end });
  }, []);

  const [viewYStart, setViewYStart] = useState(0.0);
  const [viewYEnd, setViewYEnd] = useState(1.0);

  const handleViewportYChange = useCallback((start, end) => {
    setViewYStart(start);
    setViewYEnd(end);
  }, []);

  const handleRenderComplete = useCallback(() => {
    setIsCanvasReady(true);
    // PERF-002: PROFILE_SWITCH_TOTAL
    performance.mark('profile-switch-end');
    try {
      const measure = performance.measure('profile-switch-total', 'profile-switch-start', 'profile-switch-end');
      console.log('[VOSTOK PROFILE] PROFILE_SWITCH_TOTAL | ELAPSED:', measure.duration.toFixed(3), 'ms');
    } catch (e) {
      // Silencioso si no hay marca de inicio
    }
  }, []);

  // Referencias para evitar inundar el canal IPC durante operaciones de zoom/scroll rápidos
  const pendingUpdateRef = useRef(false);
  const nextRangeRef = useRef(null);

  // Detener la reproducción cuando el componente se desmonte
  useEffect(() => {
    const tEffectStart = performance.now();
    console.log('[VOSTOK PROFILE] EFFECT_BEGIN | ID: PlaybackCleanup');
    return () => {
      invoke('stop_playback').catch(err => console.error('[Playback] Error deteniendo reproducción:', err));
      console.log(`[VOSTOK PROFILE] EFFECT_END | ID: PlaybackCleanup | ELAPSED: ${(performance.now() - tEffectStart).toFixed(3)}ms`);
    };
  }, []);

  // Lógica de centrado de viewport
  const centerViewportOnTime = useCallback((time) => {
    const fileDuration = duration || 1.0;
    const centerPercent = time / fileDuration;
    const range = viewEnd - viewStart;
    const nextStart = Math.max(0.0, centerPercent - range / 2);
    const nextEnd   = Math.min(1.0, centerPercent + range / 2);
    dispatchViewport({ start: nextStart, end: nextEnd });
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
      if (isPlayingRef.current) {
        await invoke('stop_playback');
      }
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
      if (isPlayingRef.current) {
        await invoke('stop_playback');
        setIsPlaying(false);
      }
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

      console.log("[JS Debug] handleAnalyze: threshold =", localThreshold, "timeStart =", timeStart, "timeEnd =", timeEnd);

      const resGlitches = await invoke('actualizar_umbral_detector', {
        threshold: localThreshold,
        activeFilters: selectedArtifacts,
        timeStart: timeStart,
        timeEnd: timeEnd
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
  }, [selectedArtifacts, viewStart, viewEnd, duration, glitches, updateSession, localThreshold]);

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
    const tEffectStart = performance.now();
    console.log('[VOSTOK PROFILE] EFFECT_BEGIN | ID: KeyDownListener');
    window.addEventListener('keydown', handleKeyDown);
    console.log(`[VOSTOK PROFILE] EFFECT_END | ID: KeyDownListener | ELAPSED: ${(performance.now() - tEffectStart).toFixed(3)}ms`);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handlePlayPause]);

  // 3. Captura del scroll (Pan) y zoom (Ctrl + scroll) en el contenedor principal
  const handleWheel = useCallback((e) => {
    const range = viewEnd - viewStart;

    if (e.shiftKey) {
      // Scroll/Pan horizontal (Shift + rueda)
      const delta = e.deltaY > 0 ? 0.05 : -0.05;
      const shift = delta * range * 0.4;
      let nextStart = viewStart + shift;
      let nextEnd   = viewEnd   + shift;

      if (nextStart < 0.0) { nextEnd -= nextStart; nextStart = 0.0; }
      if (nextEnd   > 1.0) { nextStart -= (nextEnd - 1.0); nextEnd = 1.0; }
      // Un único dispatch = un único commit de React
      dispatchViewport({ start: nextStart, end: nextEnd });
    } else {
      // Zoom anclado en la posición horizontal del cursor del mouse
      const visualizer = visualizerContainerRef.current;
      if (!visualizer) return;

      const rect           = visualizer.getBoundingClientRect();
      const mouseX         = e.clientX - rect.left;
      const mousePercent   = Math.max(0.0, Math.min(1.0, mouseX / rect.width));
      const mouseTimePercent = viewStart + mousePercent * range;

      const zoomFactor = 0.15;
      let newRange = e.deltaY > 0
        ? range * (1.0 + zoomFactor)  // Zoom out
        : range * (1.0 - zoomFactor); // Zoom in

      newRange = Math.max(0.005, Math.min(1.0, newRange));

      let nextStart = mouseTimePercent - mousePercent * newRange;
      let nextEnd   = nextStart + newRange;

      if (nextStart < 0.0) { nextEnd = newRange; nextStart = 0.0; }
      if (nextEnd   > 1.0) { nextStart = 1.0 - newRange; nextEnd = 1.0; }

      // Un único dispatch = un único commit de React
      dispatchViewport({ start: nextStart, end: nextEnd });
    }
  }, [viewStart, viewEnd]);

  useEffect(() => {
    const visualizer = visualizerContainerRef.current;
    if (!visualizer) return;

    const handleWheelNative = (e) => {
      e.preventDefault();
      handleWheel(e);
    };

    const tEffectStart = performance.now();
    console.log('[VOSTOK PROFILE] EFFECT_BEGIN | ID: WheelListener');
    visualizer.addEventListener('wheel', handleWheelNative, { passive: false });
    console.log(`[VOSTOK PROFILE] EFFECT_END | ID: WheelListener | ELAPSED: ${(performance.now() - tEffectStart).toFixed(3)}ms`);
    return () => {
      visualizer.removeEventListener('wheel', handleWheelNative);
    };
  }, [handleWheel]);

  // 4. Centrar canvas sobre la muestra dañada al hacer clic en un glitch de la lista
  const handleGlitchFocus = useCallback((glitch) => {
    const fileDuration  = duration || 1.0;
    const centerPercent = glitch.time_secs / fileDuration;

    // Zoom concentrado al 4% del archivo alrededor del glitch
    const zoomRange = 0.04;
    const nextStart = Math.max(0.0, centerPercent - zoomRange / 2);
    const nextEnd   = Math.min(1.0, centerPercent + zoomRange / 2);

    dispatchViewport({ start: nextStart, end: nextEnd });
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

  // 5. Invocación quirúrgica in-place de la reparación nativa en Rust con simulación de progreso
  const handleHealGlitch = useCallback(async (glitch) => {
    if (glitch.repaired) return;
    updateSession({ status: 'healing' });
    
    const glitchIdx = glitch.originalIdx;
    setHealingProgress(prev => ({ ...prev, [glitchIdx]: 5 }));
    
    const interval = setInterval(() => {
      setHealingProgress(prev => {
        const val = prev[glitchIdx];
        if (val === undefined) return prev;
        if (val >= 90) return prev;
        return { ...prev, [glitchIdx]: val + Math.floor(Math.random() * 10) + 5 };
      });
    }, 60);

    const totalFrames = session.totalStftFrames || session.stftFrames || 1000;
    const config = {
      start_frame: 0,
      end_frame: totalFrames,
      max_texture_width: 16384,
    };

    try {
      const resSpectrogram = await invoke('reparar_glitches_seleccionados', {
        glitches: [cleanGlitchForBackend(glitch)],
        config,
        profile,
      });

      // INVALIDAR CACHÉ PERSISTENTE: Al reparar, las imágenes viejas ya no coinciden con el nuevo audio
      const emptyCache = { transient: null, hum: null };

      const parsed = parseBinarySpectrogram(resSpectrogram);
      
      // ACTUALIZAR STORAGE BINARIO (Noir-Tech Zero-Copy)
      if (parsed) {
        SPECTROGRAM_STORAGE[profile] = parsed.matrix;
      }

      clearInterval(interval);
      setHealingProgress(prev => ({ ...prev, [glitchIdx]: 100 }));
      
      await new Promise(resolve => setTimeout(resolve, 250));

      const updatedGlitches = (Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).map(g => g.sample_index === glitch.sample_index ? { ...g, repaired: true } : g);

      updateSession({
        stftFrames: parsed ? parsed.num_frames : 0,
        stftBins: parsed ? parsed.num_bins : 0,
        glitches: updatedGlitches,
        status: 'ready',
        spectrogramCache: emptyCache,
        matrixVersion: session.matrixVersion + 1
      });
      const mapType = (type) => {
        const t = (type || '').toLowerCase();
        if (t.includes('click')) return 'Click';
        if (t.includes('pop')) return 'Pop';
        if (t.includes('clip')) return 'Clipping';
        if (t.includes('dropout')) return 'Dropout';
        if (t.includes('hiss')) return 'Hiss';
        if (t.includes('hum')) return 'Hum';
        return 'Glitch';
      };
      const glitchName = mapType(glitch.artifact_type);
      showToast(`${glitchName} reparado`);
    } catch (err) {
      console.error('[Tauri Healer Error]:', err);
      clearInterval(interval);
      updateSession({ status: 'ready' });
    } finally {
      setHealingProgress(prev => {
        const copy = { ...prev };
        delete copy[glitchIdx];
        return copy;
      });
    }
  }, [glitches, session.totalStftFrames, profile, updateSession, showToast, session.stftFrames, session.matrixVersion]);

  // Reparar todos los glitches restantes con progreso global y por tarjeta
  const handleHealAll = useCallback(async () => {
    const pendingGlitches = displayedGlitches.filter(g => !g.repaired);
    if (pendingGlitches.length === 0) return;

    updateSession({ status: 'healing' });
    setGlobalHealingProgress(5);
    
    const pendingIndices = new Set(pendingGlitches.map(pg => pg.originalIdx));
    setHealingProgress(prev => {
      const next = { ...prev };
      pendingIndices.forEach(idx => {
        next[idx] = 5;
      });
      return next;
    });

    const interval = setInterval(() => {
      setGlobalHealingProgress(prev => {
        if (prev === null) return null;
        if (prev >= 90) return prev;
        return prev + Math.floor(Math.random() * 8) + 4;
      });
      setHealingProgress(prev => {
        const next = { ...prev };
        pendingIndices.forEach(idx => {
          const val = next[idx];
          if (val !== undefined && val < 90) {
            next[idx] = val + Math.floor(Math.random() * 12) + 4;
          }
        });
        return next;
      });
    }, 80);

    const totalFrames = session.totalStftFrames || 1000;
    const config = {
      start_frame: 0,
      end_frame: totalFrames,
      max_texture_width: 16384,
    };

    try {
      const resSpectrogram = await invoke('reparar_glitches_seleccionados', {
        glitches: pendingGlitches.map(cleanGlitchForBackend),
        config,
        profile,
      });

      // INVALIDAR CACHÉ PERSISTENTE: Al reparar masivamente, las imágenes guardadas ya no son válidas
      const emptyCache = { transient: null, hum: null };

      const parsed = parseBinarySpectrogram(resSpectrogram);
      
      // ACTUALIZAR STORAGE BINARIO (Noir-Tech Zero-Copy)
      if (parsed) {
        SPECTROGRAM_STORAGE[profile] = parsed.matrix;
      }

      clearInterval(interval);
      setGlobalHealingProgress(100);
      setHealingProgress(prev => {
        const next = { ...prev };
        pendingIndices.forEach(idx => {
          next[idx] = 100;
        });
        return next;
      });

      await new Promise(resolve => setTimeout(resolve, 350));

      const pendingSampleIndices = new Set(pendingGlitches.map(pg => pg.sample_index));
      const updatedGlitches = (Array.isArray(glitches) ? glitches : [...(glitches?.transients || []), ...(glitches?.stationaries || [])]).map(g => pendingSampleIndices.has(g.sample_index) ? { ...g, repaired: true } : g);

      updateSession({
        stftFrames: parsed ? parsed.num_frames : 0,
        stftBins: parsed ? parsed.num_bins : 0,
        glitches: updatedGlitches,
        status: 'ready',
        spectrogramCache: emptyCache,
        matrixVersion: session.matrixVersion + 1
      });
      showToast(`${pendingGlitches.length} glitches reparados`);
    } catch (err) {
      console.error(err);
      clearInterval(interval);
      updateSession({ status: 'ready' });
    } finally {
      setGlobalHealingProgress(null);
      setHealingProgress(prev => {
        const next = { ...prev };
        pendingIndices.forEach(idx => {
          delete next[idx];
        });
        return next;
      });
    }
  }, [displayedGlitches, glitches, session.totalStftFrames, profile, updateSession, showToast, session.matrixVersion]);

  // 6. Preescuchar Audio (Toggle Playback con Rodio)
  const handleTogglePlayback = useCallback(async () => {
    try {
      const playing = await invoke('toggle_playback');
      setIsPlaying(playing);
    } catch (err) {
      console.error('[Tauri Playback Error]:', err);
    }
  }, []);

  // 6.2 Guardar ajuste de umbral en la caché (Sin disparar análisis automático)
  const updateThresholdPersistent = useCallback((val) => {
    setBackendThreshold(val);
    // PERSISTENCIA EN CACHÉ: Guardar el ajuste manual para este perfil
    if (spectrogramCache[profile]) {
      spectrogramCache[profile].threshold = val;
    }
    updateSession({
      threshold: val,
    });
  }, [updateSession, profile, spectrogramCache]);

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
        showToast("Wav exportado");
      }
    } catch (err) {
      console.error('[Tauri Export Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [fileName, updateSession, showToast]);

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
        showToast("Reporte listo");
      }
    } catch (err) {
      console.error('[Export Report Error]:', err);
      updateSession({ status: 'ready' });
    }
  }, [fileName, duration, sampleRate, bitDepth, channels, backendThreshold, minConfidence, glitches, displayedGlitches, updateSession, showToast]);

  const formatTime = (secs) => {
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toFixed(3);
    return `${m}:${s.padStart(6, '0')}`;
  };

  // PERF-004: Profiler Callbacks
  const onRenderHUD = (id, phase, actual) => console.log(`[VOSTOK PROFILE] PROFILER_COMMIT | ID: ${id} | PHASE: ${phase} | ACTUAL: ${actual.toFixed(3)}ms`);
  const onRenderMain = (id, phase, actual) => console.log(`[VOSTOK PROFILE] PROFILER_COMMIT | ID: ${id} | PHASE: ${phase} | ACTUAL: ${actual.toFixed(3)}ms`);
  const onRenderSidebar = (id, phase, actual) => console.log(`[VOSTOK PROFILE] PROFILER_COMMIT | ID: ${id} | PHASE: ${phase} | ACTUAL: ${actual.toFixed(3)}ms`);

  // PERF-003: Render Run End (Calculamos el tiempo justo antes de retornar el JSX)
  const tRenderEnd = performance.now();
  console.log(`[VOSTOK PROFILE] RENDER_END | COMPONENT: VostokRestoration | ELAPSED: ${(tRenderEnd - tRenderStart).toFixed(3)}ms`);

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
      {status === 'healing' && (
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
      <Profiler id="HUD" onRender={onRenderHUD}>
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
                  onMouseUp={(e) => updateThresholdPersistent(parseFloat(e.target.value))}
                  onTouchEnd={(e) => updateThresholdPersistent(parseFloat(e.target.value))}
                  onKeyUp={(e) => {
                    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                      updateThresholdPersistent(parseFloat(e.target.value));
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
              disabled={pendingGlitchesCount === 0 || globalHealingProgress !== null}
              style={{
                background: '#39FF14', border: 'none', color: '#010101',
                borderRadius: '4px', cursor: (pendingGlitchesCount === 0 || globalHealingProgress !== null) ? 'default' : 'pointer', padding: '8px 16px',
                fontFamily: 'JetBrains Mono, monospace', fontSize: '11px', fontWeight: 900,
                display: 'flex', alignItems: 'center', gap: '8px',
                opacity: (pendingGlitchesCount === 0 || globalHealingProgress !== null) ? 0.3 : 1
              }}
            >
              <Zap style={{ width: 14, height: 14 }} /> 
              {globalHealingProgress !== null ? `Reparando (${globalHealingProgress}%)` : `Reparar Todo (${pendingGlitchesCount})`}
            </button>
          </div>
        </div>
      </Profiler>

      {/* ── BLOQUE CENTRAL (Workstation Espectrograma + Scrubbers) ── */}
      <Profiler id="Workstation" onRender={onRenderMain}>
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
              {(status === 'loading' || status === 'analyzing' || !stftMatrix || !isCanvasReady) && (
                <div style={{
                  position: 'absolute',
                  inset: 0,
                  backgroundColor: '#010101',
                  zIndex: 100,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '16px',
                  fontFamily: 'JetBrains Mono, monospace',
                  backgroundImage: 'linear-gradient(rgba(18, 16, 16, 0) 50%, rgba(0, 0, 0, 0.25) 50%), linear-gradient(90deg, rgba(255, 0, 0, 0.03), rgba(0, 255, 0, 0.01), rgba(0, 0, 255, 0.03))',
                  backgroundSize: '100% 4px, 6px 100%',
                }}>
                  <div style={{
                    position: 'absolute',
                    left: 0,
                    width: '100%',
                    height: '2px',
                    backgroundColor: '#39FF14',
                    boxShadow: '0 0 15px #39FF14, 0 0 5px #39FF14',
                    animation: 'vostokLaserSweep 4s infinite linear',
                    opacity: 0.8,
                  }} />
                  <div style={{
                    fontSize: '18px',
                    fontWeight: 900,
                    letterSpacing: '0.2em',
                    color: '#39FF14',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px',
                    textShadow: '0 0 8px rgba(57, 255, 20, 0.4)',
                  }}>
                    VOSTOK <span style={{ color: '#ffffff' }}>RESTORATION</span>
                  </div>
                  <div style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: '12px',
                    color: 'rgba(255, 255, 255, 0.7)',
                    fontSize: '11px',
                  }}>
                    <div style={{
                      width: '14px',
                      height: '14px',
                      borderRadius: '50%',
                      border: '2px solid rgba(57, 255, 20, 0.1)',
                      borderTopColor: '#39FF14',
                      animation: 'vostokSpin 1s infinite linear, vostokPulseGlow 2s infinite ease-in-out',
                    }} />
                    <span>CONSTRUYENDO ESPECTROGRAMA...</span>
                  </div>
                </div>
              )}
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
                onTimelineClick={handleTimelineClick}
                onRenderComplete={handleRenderComplete}
                matrixVersion={matrixVersion}
              />
              <PlaybackCursor
                playheadTime={playheadTime}
                viewStart={viewStart}
                viewEnd={viewEnd}
                duration={duration}
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
              playheadTime={playheadTime}
              duration={duration}
            />
          </div>
        </div>
      </Profiler>

      {/* ── BLOQUE LATERAL (Inspector de Glitches o Filtros de Diagnóstico) ── */}
      <Profiler id="Sidebar" onRender={onRenderSidebar}>
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
                  {pendingGlitchesCount} PENDIENTES
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
              {globalHealingProgress !== null && (
                <div style={{
                  padding: '10px 16px',
                  background: 'rgba(57, 255, 20, 0.05)',
                  borderBottom: '1px solid rgba(57, 255, 20, 0.2)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '6px'
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', fontWeight: 900, color: '#39FF14', letterSpacing: '0.05em' }}>
                      REPARANDO ERRORES...
                    </span>
                    <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '9px', fontWeight: 900, color: '#39FF14' }}>
                      {globalHealingProgress}%
                    </span>
                  </div>
                  <div style={{ width: '100%', height: '4px', background: 'rgba(0,0,0,0.4)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{
                      width: `${globalHealingProgress}%`,
                      height: '100%',
                      background: 'linear-gradient(90deg, #39FF14 0%, #00FFFF 100%)',
                      boxShadow: '0 0 8px #39FF14',
                      transition: 'width 0.1s linear'
                    }} />
                  </div>
                </div>
              )}
              <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
                {displayedGlitches.length === 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', opacity: 0.3, gap: '8px' }}>
                    <Volume2 style={{ width: 24, height: 24 }} />
                    <span className="label-xs">Cero ruidos detectados</span>
                  </div>
                ) : (
                  <>
                    {visibleGlitches.map((glitch) => {
                      const tagColor = getArtifactTagColor(glitch.artifact_type);
                      const conf = glitch.confidence !== undefined ? glitch.confidence : 1.0;
                      
                      let confColor = '#39FF14';
                      if (conf < 0.5) {
                        confColor = '#FFB000'; // Amber
                      } else if (conf < 0.8) {
                        confColor = 'rgba(57, 255, 20, 0.6)'; // Translucent green
                      }

                      const isHealing = healingProgress[glitch.originalIdx] !== undefined;
                      const progress = healingProgress[glitch.originalIdx] || 0;

                      return (
                        <div
                          key={glitch.originalIdx}
                          onClick={() => handleGlitchClick(glitch, glitch.originalIdx)}
                          style={{
                            display: 'flex', flexDirection: 'column',
                            padding: '10px 12px',
                            border: selectedGlitchIdx === glitch.originalIdx ? '1px solid #39FF14' : '1px solid rgba(255,255,255,0.05)',
                            borderRadius: '4px', marginBottom: '6px', cursor: 'pointer',
                            background: selectedGlitchIdx === glitch.originalIdx ? 'rgba(57,255,20,0.15)' : (glitch.repaired ? 'rgba(57,255,20,0.02)' : 'rgba(255,255,255,0.01)'),
                            transition: 'all 0.2s',
                          }}
                          className="hover-glitch-item"
                        >
                          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%' }}>
                            <div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '10px', color: glitch.repaired ? 'rgba(57, 255, 20, 0.5)' : '#fff' }}>
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
                              disabled={glitch.repaired || isHealing}
                              style={{
                                background: glitch.repaired ? 'rgba(255,255,255,0.05)' : (isHealing ? 'rgba(57,255,20,0.05)' : 'rgba(57,255,20,0.1)'),
                                border: glitch.repaired ? '1px solid rgba(255,255,255,0.1)' : (isHealing ? '1px solid rgba(57,255,20,0.2)' : '1px solid rgba(57,255,20,0.4)'),
                                color: glitch.repaired ? 'rgba(255,255,255,0.3)' : '#39FF14',
                                borderRadius: '4px', cursor: (glitch.repaired || isHealing) ? 'default' : 'pointer',
                                padding: '4px 8px', fontSize: '9px', fontFamily: 'JetBrains Mono, monospace',
                                minWidth: '70px', textAlign: 'center'
                              }}
                            >
                              {glitch.repaired ? 'Reparado' : (isHealing ? `${progress}%` : 'Reparar')}
                            </button>
                          </div>

                          {/* Barra de carga de reparación */}
                          {isHealing && (
                            <div style={{
                              width: '100%',
                              height: '3px',
                              background: 'rgba(255,255,255,0.05)',
                              borderRadius: '1.5px',
                              marginTop: '8px',
                              overflow: 'hidden',
                              position: 'relative'
                            }}>
                              <div style={{
                                width: `${progress}%`,
                                height: '100%',
                                background: 'linear-gradient(90deg, #39FF14 0%, #00FFFF 100%)',
                                boxShadow: '0 0 6px #39FF14',
                                transition: 'width 0.08s linear'
                              }} />
                            </div>
                          )}
                        </div>
                      );
                    })}

                    {sortedGlitches.length > visibleCount && (
                      <button
                        onClick={() => setVisibleCount(prev => prev + 150)}
                        style={{
                          width: '100%',
                          padding: '10px',
                          background: 'rgba(57, 255, 20, 0.05)',
                          border: '1px dashed rgba(57, 255, 20, 0.3)',
                          color: '#39FF14',
                          borderRadius: '4px',
                          cursor: 'pointer',
                          fontFamily: 'JetBrains Mono, monospace',
                          fontSize: '10px',
                          fontWeight: 900,
                          marginTop: '8px',
                          textAlign: 'center',
                          transition: 'all 0.2s',
                        }}
                        className="vostok-load-more-btn"
                      >
                        Cargar más (+{sortedGlitches.length - visibleCount} restantes)
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )}
        </div>
      </Profiler>

      {/* Toast Notification Container */}
      <div style={{
        position: 'fixed',
        bottom: '24px',
        right: '24px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
        zIndex: 9999,
        pointerEvents: 'none',
      }}>
        {toasts.map(toast => (
          <div key={toast.id} style={{
            background: '#010101',
            border: '1px solid #39FF14',
            boxShadow: '0 0 10px rgba(57, 255, 20, 0.3)',
            borderRadius: '4px',
            padding: '12px 18px',
            color: '#ffffff',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: '11px',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            pointerEvents: 'auto',
            animation: 'vostokToastIn 0.2s cubic-bezier(0.16, 1, 0.3, 1)',
            minWidth: '160px',
          }}>
            <span style={{ color: '#39FF14' }}>✔</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>

      {/* CSS Keyframes Injection */}
      <style>{`
        @keyframes vostokToastIn {
          from {
            opacity: 0;
            transform: translateY(12px) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        @keyframes vostokLaserSweep {
          0% {
            top: 0%;
          }
          50% {
            top: 100%;
          }
          100% {
            top: 0%;
          }
        }
        @keyframes vostokPulseGlow {
          0% {
            box-shadow: 0 0 10px rgba(57, 255, 20, 0.2);
          }
          50% {
            box-shadow: 0 0 20px rgba(57, 255, 20, 0.5);
          }
          100% {
            box-shadow: 0 0 10px rgba(57, 255, 20, 0.2);
          }
        }
        @keyframes vostokSpin {
          from {
            transform: rotate(0deg);
          }
          to {
            transform: rotate(360deg);
          }
        }
      `}</style>

    </div>
  );
}
