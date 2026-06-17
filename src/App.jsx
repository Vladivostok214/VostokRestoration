/**
 * VOSTOK RESTORATION v1 — App.jsx
 * Orquestador principal: gestiona estado global, routing entre vistas
 * y el puente de datos DSP ↔ UI.
 *
 * Filosofía: Zero-allocation en el loop de render, estado mínimo en React,
 * lógica pesada delegada a Web Workers (simulando el backend Rust/Tauri).
 */
import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import LandingView from './components/LandingView.jsx';
import VostokRestoration from './components/VostokRestoration.jsx';

const INITIAL_SESSION = {
  fileName:     '',
  filePath:     '',
  duration:     0,
  sampleRate:   0,
  bitDepth:     0,
  samples:      null,   // Float32Array — PCM normalizado
  originalSamples: null, // Copia del audio original sin procesar
  glitches:     [],     // [{ index, magnitude, repaired }]
  noiseFloor:   0.005,   // estimado por glitchDetector durante el análisis
  stftFrames:   0,
  stftBins:     0,
  totalStftFrames: 0,
  threshold:    0.01,
  status:       'idle', // 'idle' | 'loading' | 'analyzing' | 'ready' | 'healing'
  progress:     0,      // 0–1
  profile:      'hum',  // 'transient' | 'hum'
  matrixVersion: 0,     // Contador ligero para notificar cambios en el buffer binario
  spectrogramCache: { transient: null, hum: null }, // Metadatos ligeros de visualización
  loopStart:    0.0,
  loopEnd:      0.0,
};

export default function App() {
  const [session, setSession] = useState(INITIAL_SESSION);
  const [view, setView]       = useState('landing'); // 'landing' | 'workspace'

  // Transición landing → workspace al cargar un archivo
  const handleFileLoaded = useCallback((sessionData) => {
    setSession(prev => ({ 
      ...prev, 
      ...sessionData,
      loopStart: 0.0,
      loopEnd: sessionData.duration,
      // ✨ CORRECCIÓN QUIRÚRGICA: Incrementamos la versión para forzar a WebGL a leer el storage binario
      matrixVersion: prev.matrixVersion + 1 
    }));
    setView('workspace');
  }, []);

  // Reset total — volver al inicio (silencia el hardware de audio de forma segura)
  const handleReset = useCallback(async () => {
    try {
      await invoke('stop_playback');
    } catch (err) {
      console.warn('Error al silenciar hardware en reset:', err);
    }
    setSession(INITIAL_SESSION);
    setView('landing');
  }, []);

  // Actualizar estado parcial de la sesión (desde Workers o acciones UI)
  const updateSession = useCallback((patch) => {
    setSession(prev => ({ ...prev, ...patch }));
  }, []);

  return (
    <div className="grid-bg crt-scanlines" style={{ width: '100%', height: '100%' }}>
      {view === 'landing' ? (
        <LandingView onFileLoaded={handleFileLoaded} />
      ) : (
        <VostokRestoration 
          session={session} 
          updateSession={updateSession} 
          onReset={handleReset} 
        />
      )}
    </div>
  );
}
