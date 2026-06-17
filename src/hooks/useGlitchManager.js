/**
 * useGlitchManager.js — Custom Hook: Gestión de Detección y Reparación de Glitches
 *
 * Encapsula todo el estado y la lógica de comunicación con los comandos Tauri
 * relacionados con glitches, desacoplando VostokRestoration.jsx del "God Component".
 *
 * Principio de alineación frontend ↔ backend:
 *   scanAudio()   ↔  invoke('ejecutar_escaneo_manual')
 *   healGlitch()  ↔  invoke('reparar_glitches_seleccionados')
 *   healAll()     ↔  invoke('reparar_glitches_seleccionados')  [lote completo]
 */
import { useState, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { SPECTROGRAM_STORAGE } from '../components/spectrogramStore.js';

// ── HELPERS INTERNOS (no exportados) ──

/**
 * Parsea la respuesta binaria del espectrograma enviada por el backend Rust.
 * Formato: [frames: u32 LE][bins: u32 LE][matrix: u8 × frames×bins]
 */
function parseBinarySpectrogram(responseBytes) {
  if (!responseBytes) return null;
  const tStart = performance.now();

  let buffer, byteOffset, byteLength;
  if (responseBytes instanceof ArrayBuffer) {
    buffer     = responseBytes;
    byteOffset = 0;
    byteLength = responseBytes.byteLength;
  } else {
    const view = ArrayBuffer.isView(responseBytes) ? responseBytes : new Uint8Array(responseBytes);
    buffer     = view.buffer;
    byteOffset = view.byteOffset;
    byteLength = view.byteLength;
  }

  const dv     = new DataView(buffer, byteOffset, byteLength);
  const frames = dv.getUint32(0, true);
  const bins   = dv.getUint32(4, true);
  const matrix = new Uint8Array(buffer, byteOffset + 8, frames * bins);

  console.log(`[VOSTOK MEMORY] BINARY_PARSING | ELAPSED: ${(performance.now() - tStart).toFixed(3)}ms | FRAMES: ${frames} | BINS: ${bins}`);
  return { matrix, frames, bins };
}

/**
 * Serializa un GlitchEvent de JS al shape exacto que espera el struct Rust.
 * Todos los campos son requeridos por serde para deserializar correctamente.
 */
function cleanGlitchForBackend(g) {
  return {
    sample_index:    g.sample_index,
    time_secs:       g.time_secs       ?? 0.0,
    amplitude_delta: g.amplitude_delta ?? 0.0,
    direction:       g.direction       ?? 0,
    event_type:      g.event_type      ?? 'click',
    repaired:        g.repaired ? true : false,
    frequency:       g.frequency       ?? null,
    channel:         g.channel         ?? 0,
    duration_samples: g.duration_samples ?? null,
  };
}

// ── HOOK PRINCIPAL ──

export default function useGlitchManager(session, updateSession, showToast, stopPlaybackState) {
  const { glitches, matrixVersion, status } = session;

  // ── ESTADO LOCAL DEL HOOK ──
  const [selectedGlitch,        setSelectedGlitch]        = useState(null);
  const [healingProgress,       setHealingProgress]       = useState({});
  const [globalHealingProgress, setGlobalHealingProgress] = useState(null);

  // Parámetros de la spline Hermite cúbica (alineados con HermiteConfig en Rust)
  const [config, setConfig] = useState({
    window_size: 16,
    bias:        0.0,
    tension:     0.0,
  });

  // Parámetros del escáner multiparamétrico en paralelo (Tauri backend)
  const [scanParams, setScanParams] = useState({
    clicks: true,
    hum: true,
    hiss: false,
    dropouts: true,
    distortion: false,
    sensitivity: 0.0,
    audio_mode: 'music',
  });

  // ── VALORES DERIVADOS ──
  const pendingGlitchesCount = useMemo(
    () => glitches.filter(g => !g.repaired).length,
    [glitches]
  );
  const selectedGlitchIdx = selectedGlitch ? selectedGlitch.internalIdx : null;

  // ── ACCIONES ↔ COMANDOS TAURI ──

  /**
   * scanAudio ↔ invoke('ejecutar_analisis_avanzado')
   * Lanza el escaneo avanzado sobre el AudioBuffer y StftResult en memoria del backend.
   */
  const scanAudio = useCallback(async () => {
    if (status !== 'ready') return;
    updateSession({ status: 'analyzing', progress: 0 });
    try {
      const isLoopActive = session.loopEnd > session.loopStart;
      const detected = await invoke('ejecutar_analisis_avanzado', { 
        params: scanParams,
        loopStart: isLoopActive ? session.loopStart : null,
        loopEnd: isLoopActive ? session.loopEnd : null
      });
      updateSession({ glitches: detected, status: 'ready' });
      showToast(
        isLoopActive
          ? `Escaneo de región finalizado: ${detected.length} anomalías detectadas`
          : `Escaneo avanzado finalizado: ${detected.length} anomalías detectadas`
      );
    } catch (err) {
      console.error('[useGlitchManager] scanAudio error:', err);
      updateSession({ status: 'ready' });
      showToast('Error en el motor de análisis nativo');
    }
  }, [status, scanParams, session.loopStart, session.loopEnd, updateSession, showToast]);

  /**
   * healGlitch ↔ invoke('reparar_glitches_seleccionados')
   * Repara un único glitch seleccionado con interpolación Hermite cúbica.
   * El backend devuelve el espectrograma completo actualizado en binario.
   */
  const healGlitch = useCallback(async (glitch, glitchIdx) => {
    if (status !== 'ready') return;
    if (stopPlaybackState) stopPlaybackState();
    updateSession({ status: 'healing' });
    setHealingProgress(prev => ({ ...prev, [glitchIdx]: 10 }));
    try {
      const response = await invoke('reparar_glitches_seleccionados', {
        glitchesToRepair: [cleanGlitchForBackend(glitch)],
        allGlitches: glitches,
        config,
        isSelection: false,
      });

      const parsed = parseBinarySpectrogram(response.spectrogram);

      setHealingProgress(prev => ({ ...prev, [glitchIdx]: 100 }));
      await new Promise(r => setTimeout(r, 150));

      if (parsed) {
        SPECTROGRAM_STORAGE['hum'] = parsed.matrix;
        SPECTROGRAM_STORAGE['full'] = parsed.matrix;
      }

      updateSession({
        glitches: response.glitches,
        status: 'ready',
        matrixVersion: matrixVersion + 1,
        waveformEnvelope: response.waveform_envelope,
        ...(parsed ? { stftFrames: parsed.frames, stftBins: parsed.bins } : {})
      });

      if (selectedGlitch?.sample_index === glitch.sample_index) {
        setSelectedGlitch(prev => prev ? { ...prev, repaired: true } : null);
      }
      showToast('Interpolación Hermite ejecutada');
    } catch (err) {
      console.error('[useGlitchManager] healGlitch error:', err);
      updateSession({ status: 'ready' });
      showToast('Error en cómputo matemático nativo');
    } finally {
      setHealingProgress(prev => {
        const next = { ...prev };
        delete next[glitchIdx];
        return next;
      });
    }
  }, [status, glitches, config, matrixVersion, selectedGlitch, updateSession, showToast, stopPlaybackState]);

  /**
   * healAll ↔ invoke('reparar_glitches_seleccionados') [lote completo]
   * Repara todos los glitches pendientes en una sola llamada al backend.
   */
  const healAll = useCallback(async () => {
    const pending = glitches.filter(g => !g.repaired);
    if (pending.length === 0 || status !== 'ready') return;

    if (stopPlaybackState) stopPlaybackState();
    updateSession({ status: 'healing' });
    setGlobalHealingProgress(15);
    try {
      const response = await invoke('reparar_glitches_seleccionados', {
        glitchesToRepair: pending.map(cleanGlitchForBackend),
        allGlitches: glitches,
        config,
        isSelection: false,
      });

      setGlobalHealingProgress(60);
      const parsed = parseBinarySpectrogram(response.spectrogram);

      setGlobalHealingProgress(100);
      await new Promise(r => setTimeout(r, 200));

      if (parsed) {
        SPECTROGRAM_STORAGE['hum'] = parsed.matrix;
        SPECTROGRAM_STORAGE['full'] = parsed.matrix;
      }

      updateSession({
        glitches:      response.glitches,
        status:        'ready',
        matrixVersion: matrixVersion + 1,
        waveformEnvelope: response.waveform_envelope,
        ...(parsed ? { stftFrames: parsed.frames, stftBins: parsed.bins } : {})
      });
      setSelectedGlitch(null);
      showToast('Audio restaurado por completo');
    } catch (err) {
      console.error('[useGlitchManager] healAll error:', err);
      updateSession({ status: 'ready' });
      showToast('Fallo crítico en restauración por lotes');
    } finally {
      setGlobalHealingProgress(null);
    }
  }, [glitches, status, config, matrixVersion, updateSession, showToast, stopPlaybackState]);

  /**
   * healSelection ↔ invoke('reparar_glitches_seleccionados') para selección espectral manual
   */
  const healSelection = useCallback(async (manualGlitch) => {
    if (status !== 'ready') return;
    if (stopPlaybackState) stopPlaybackState();
    updateSession({ status: 'healing' });
    try {
      const response = await invoke('reparar_glitches_seleccionados', {
        glitchesToRepair: [cleanGlitchForBackend(manualGlitch)],
        allGlitches: glitches,
        config,
        isSelection: true,
        sensitivity: scanParams.sensitivity,
      });

      const parsed = parseBinarySpectrogram(response.spectrogram);
      if (parsed) {
        SPECTROGRAM_STORAGE['hum'] = parsed.matrix;
        SPECTROGRAM_STORAGE['full'] = parsed.matrix;
      }

      const initialRepaired = glitches.filter(g => g.repaired).length;
      const finalRepaired = response.glitches.filter(g => g.repaired).length;
      const newlyHealedCount = finalRepaired - initialRepaired;

      updateSession({
        glitches: response.glitches,
        status: 'ready',
        matrixVersion: matrixVersion + 1,
        waveformEnvelope: response.waveform_envelope,
        ...(parsed ? { stftFrames: parsed.frames, stftBins: parsed.bins } : {})
      });

      if (newlyHealedCount > 0) {
        showToast(`Reparación quirúrgica aplicada: ${newlyHealedCount} ${newlyHealedCount === 1 ? 'anomalía corroborada y reparada' : 'anomalías corroboradas y reparadas'}.`);
      } else {
        showToast('No se corroboró ningún glitch en la selección.');
      }
    } catch (err) {
      console.error('[useGlitchManager] healSelection error:', err);
      updateSession({ status: 'ready' });
      showToast('Error en la reparación manual');
    }
  }, [status, config, glitches, scanParams.sensitivity, matrixVersion, updateSession, showToast, stopPlaybackState]);

  /**
   * selectGlitch — Selección visual sin comunicación con el backend.
   * Almacena el glitch seleccionado con su índice interno para el inspector.
   */
  const selectGlitch = useCallback((g) => {
    if (!g) {
      setSelectedGlitch(null);
      return;
    }
    const matchedIdx = glitches.findIndex(item => item.sample_index === g.sample_index);
    setSelectedGlitch({ ...g, internalIdx: matchedIdx });
  }, [glitches]);

  /**
   * discardGlitch — Elimina un glitch de la lista sin procesarlo.
   */
  const discardGlitch = useCallback((g) => {
    if (!g) return;
    const newGlitches = glitches.filter(item => item.sample_index !== g.sample_index || item.channel !== g.channel);
    updateSession({ glitches: newGlitches });
    if (selectedGlitch && selectedGlitch.sample_index === g.sample_index && selectedGlitch.channel === g.channel) {
      setSelectedGlitch(null);
    }
    showToast(`Anomalía descartada.`);
  }, [glitches, selectedGlitch, updateSession, showToast]);

  /**
   * undo — Deshace la última acción de reparación en el backend.
   */
  const undo = useCallback(async () => {
    if (status !== 'ready') return;
    if (stopPlaybackState) stopPlaybackState();
    try {
      const response = await invoke('deshacer_accion', { glitches });
      const parsed = parseBinarySpectrogram(response.spectrogram);
      if (parsed) {
        SPECTROGRAM_STORAGE['hum'] = parsed.matrix;
        SPECTROGRAM_STORAGE['full'] = parsed.matrix;
      }
      updateSession({
        glitches: response.glitches,
        matrixVersion: matrixVersion + 1,
        waveformEnvelope: response.waveform_envelope,
        ...(parsed ? { stftFrames: parsed.frames, stftBins: parsed.bins } : {})
      });
      setSelectedGlitch(null);
      showToast('Deshacer: Reparación restaurada al estado original');
    } catch (err) {
      console.warn('[useGlitchManager] undo error:', err);
      showToast(err);
    }
  }, [status, glitches, matrixVersion, updateSession, showToast, stopPlaybackState]);

  /**
   * redo — Rehace la última acción deshecha en el backend.
   */
  const redo = useCallback(async () => {
    if (status !== 'ready') return;
    if (stopPlaybackState) stopPlaybackState();
    try {
      const response = await invoke('rehacer_accion', { glitches });
      const parsed = parseBinarySpectrogram(response.spectrogram);
      if (parsed) {
        SPECTROGRAM_STORAGE['hum'] = parsed.matrix;
        SPECTROGRAM_STORAGE['full'] = parsed.matrix;
      }
      updateSession({
        glitches: response.glitches,
        matrixVersion: matrixVersion + 1,
        waveformEnvelope: response.waveform_envelope,
        ...(parsed ? { stftFrames: parsed.frames, stftBins: parsed.bins } : {})
      });
      setSelectedGlitch(null);
      showToast('Rehacer: Reparación aplicada nuevamente');
    } catch (err) {
      console.warn('[useGlitchManager] redo error:', err);
      showToast(err);
    }
  }, [status, glitches, matrixVersion, updateSession, showToast, stopPlaybackState]);

  return {
    // Estado
    selectedGlitch,
    healingProgress,
    globalHealingProgress,
    config,
    setConfig,
    scanParams,
    setScanParams,
    // Derivados
    pendingGlitchesCount,
    selectedGlitchIdx,
    // Acciones
    scanAudio,
    healGlitch,
    healAll,
    healSelection,
    selectGlitch,
    discardGlitch,
    undo,
    redo,
  };
}
