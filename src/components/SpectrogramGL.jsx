import { useState, useEffect, useRef, useCallback, memo, useMemo } from 'react';

const FRAG_SHADER = `
  precision highp float;
  varying vec2 v_texCoord;

  uniform sampler2D u_stft;
  uniform float     u_sampleRate;
  uniform float     u_viewStart;
  uniform float     u_viewEnd;
  uniform float     u_viewYStart;
  uniform float     u_viewYEnd;
  uniform float     u_dbFloor;
  uniform float     u_dbCeiling;
  uniform float     u_isZoomed;
  uniform float     u_scaleMode;
  uniform float     u_colorPalette;

  void main() {
    vec2 uv = v_texCoord;

    // Mapeo temporal (Eje X en canvas -> Eje Y en textura)
    float tCoord = u_viewStart + uv.x * (u_viewEnd - u_viewStart);

    // Mapeo de Frecuencias (Eje Y)
    float yCoord = u_viewYStart + uv.y * (u_viewYEnd - u_viewYStart);
    float fmin = 20.0;
    float fmax = 20000.0;
    float freq;

    if (u_scaleMode < 0.5) {
      // 0.0: Lineal
      freq = fmin + yCoord * (fmax - fmin);
    } else if (u_scaleMode < 1.5) {
      // 1.0: Mel
      float log10Val = log(10.0);
      float melMin = 2595.0 * (log(1.0 + fmin / 700.0) / log10Val);
      float melMax = 2595.0 * (log(1.0 + fmax / 700.0) / log10Val);
      float mel = melMin + yCoord * (melMax - melMin);
      freq = 700.0 * (pow(10.0, mel / 2595.0) - 1.0);
    } else if (u_scaleMode < 2.5) {
      // 2.0: Logarítmica
      freq = fmin * pow(fmax / fmin, yCoord);
    } else {
      // 3.0: Bark
      float barkMin = 6.0 * log((fmin / 600.0) + sqrt((fmin / 600.0) * (fmin / 600.0) + 1.0));
      float barkMax = 6.0 * log((fmax / 600.0) + sqrt((fmax / 600.0) * (fmax / 600.0) + 1.0));
      float bark = barkMin + yCoord * (barkMax - barkMin);
      float sinhVal = (exp(bark / 6.0) - exp(-bark / 6.0)) * 0.5;
      freq = 600.0 * sinhVal;
    }

    float binNorm = 2.0 * freq / u_sampleRate;

    // Lectura de amplitud de textura [0.0, 1.0] (corresponde a [-96 dBFS, 0 dBFS] desde Rust)
    float val = texture2D(u_stft, vec2(binNorm, tCoord)).r;
    float db = val * 96.0 - 96.0;

    // Remapeo dinámico e interactivo
    float amp = clamp((db - u_dbFloor) / (u_dbCeiling - u_dbFloor), 0.0, 1.0);

    // Curva de transferencia gamma
    amp = pow(amp, 1.1);

    // Seleccionar Paleta de Colores Dinámica
    vec3 color;
    if (u_colorPalette < 0.5) {
      // 0.0: Inferno (Clásica Térmica)
      if (amp < 0.1) {
        color = mix(vec3(0.0, 0.0, 0.05), vec3(0.0, 0.1, 0.5), amp / 0.1);
      } else if (amp < 0.3) {
        color = mix(vec3(0.0, 0.1, 0.5), vec3(0.6, 0.0, 0.6), (amp - 0.1) / 0.2);
      } else if (amp < 0.6) {
        color = mix(vec3(0.6, 0.0, 0.6), vec3(1.0, 0.3, 0.0), (amp - 0.3) / 0.3);
      } else if (amp < 0.85) {
        color = mix(vec3(1.0, 0.3, 0.0), vec3(1.0, 0.9, 0.0), (amp - 0.6) / 0.25);
      } else {
        color = mix(vec3(1.0, 0.9, 0.0), vec3(1.0, 1.0, 1.0), (amp - 0.85) / 0.15);
      }
    } else if (u_colorPalette < 1.5) {
      // 1.0: Viridis (Espectral Azul-Verde-Amarillo)
      if (amp < 0.25) {
        color = mix(vec3(0.267, 0.004, 0.329), vec3(0.231, 0.322, 0.545), amp / 0.25);
      } else if (amp < 0.5) {
        color = mix(vec3(0.231, 0.322, 0.545), vec3(0.122, 0.631, 0.533), (amp - 0.25) / 0.25);
      } else if (amp < 0.75) {
        color = mix(vec3(0.122, 0.631, 0.533), vec3(0.369, 0.788, 0.384), (amp - 0.5) / 0.25);
      } else {
        color = mix(vec3(0.369, 0.788, 0.384), vec3(0.992, 0.906, 0.141), (amp - 0.75) / 0.25);
      }
    } else if (u_colorPalette < 2.5) {
      // 2.0: Hielo/Océano (Azul-Cian-Blanco)
      if (amp < 0.2) {
        color = mix(vec3(0.0, 0.0, 0.1), vec3(0.0, 0.2, 0.6), amp / 0.2);
      } else if (amp < 0.5) {
        color = mix(vec3(0.0, 0.2, 0.6), vec3(0.0, 0.8, 1.0), (amp - 0.2) / 0.3);
      } else if (amp < 0.8) {
        color = mix(vec3(0.0, 0.8, 1.0), vec3(0.6, 0.9, 1.0), (amp - 0.5) / 0.3);
      } else {
        color = mix(vec3(0.6, 0.9, 1.0), vec3(1.0, 1.0, 1.0), (amp - 0.8) / 0.2);
      }
    } else {
      // 3.0: Monocromo (Escala de Grises)
      color = vec3(amp);
    }

    // Grid Logarítmico armónico sutil
    float grid = 0.0;
    if (mod(log(freq/fmin)/log(2.0), 1.0) < 0.01) grid = 0.04;

    gl_FragColor = vec4(color + grid, 1.0);
  }
`;

const VERT_SHADER = `
  attribute vec2 position;
  varying vec2 v_texCoord;
  void main() {
    v_texCoord = position * 0.5 + 0.5;
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

// Conversión de frecuencia física (Hz) a porcentaje vertical según la escala seleccionada en el SVG
const getPercentYFromFreq = (freqHz, viewYStart, viewYEnd, scaleMode) => {
  const fmin = 20.0;
  const fmax = 20000.0;
  let yNorm = 0.0;

  if (scaleMode === 0) { // Linear
    yNorm = (freqHz - fmin) / (fmax - fmin);
  } else if (scaleMode === 2) { // Log
    yNorm = Math.log(freqHz / fmin) / Math.log(fmax / fmin);
  } else if (scaleMode === 3) { // Bark
    const barkTarget = 6.0 * Math.log((freqHz / 600.0) + Math.sqrt((freqHz / 600.0) * (freqHz / 600.0) + 1.0));
    const barkMin = 6.0 * Math.log((fmin / 600.0) + Math.sqrt((fmin / 600.0) * (fmin / 600.0) + 1.0));
    const barkMax = 6.0 * Math.log((fmax / 600.0) + Math.sqrt((fmax / 600.0) * (fmax / 600.0) + 1.0));
    yNorm = (barkTarget - barkMin) / (barkMax - barkMin);
  } else { // Mel (default/1)
    const log10Val = Math.log(10.0);
    const melMin = 2595.0 * (Math.log(1.0 + fmin / 700.0) / log10Val);
    const melMax = 2595.0 * (Math.log(1.0 + fmax / 700.0) / log10Val);
    const melTarget = 2595.0 * (Math.log(1.0 + freqHz / 700.0) / log10Val);
    yNorm = (melTarget - melMin) / (melMax - melMin);
  }

  const yView = (yNorm - viewYStart) / (viewYEnd - viewYStart);
  return (1.0 - yView) * 100;
};

// Conversión de porcentaje vertical de viewport a frecuencia física (Hz) según la escala seleccionada
const getFreqFromPercentY = (pctY, viewYStart, viewYEnd, scaleMode) => {
  const fmin = 20.0;
  const fmax = 20000.0;
  const yNorm = viewYStart + (1.0 - pctY) * (viewYEnd - viewYStart);

  if (scaleMode === 0) { // Linear
    return fmin + yNorm * (fmax - fmin);
  } else if (scaleMode === 2) { // Log
    return fmin * Math.pow(fmax / fmin, yNorm);
  } else if (scaleMode === 3) { // Bark
    const barkMin = 6.0 * Math.log((fmin / 600.0) + Math.sqrt((fmin / 600.0) * (fmin / 600.0) + 1.0));
    const barkMax = 6.0 * Math.log((fmax / 600.0) + Math.sqrt((fmax / 600.0) * (fmax / 600.0) + 1.0));
    const bark = barkMin + yNorm * (barkMax - barkMin);
    const sinhVal = (Math.exp(bark / 6.0) - Math.exp(-bark / 6.0)) * 0.5;
    return 600.0 * sinhVal;
  } else { // Mel (default/1)
    const log10Val = Math.log(10.0);
    const melMin = 2595.0 * (Math.log(1.0 + fmin / 700.0) / log10Val);
    const melMax = 2595.0 * (Math.log(1.0 + fmax / 700.0) / log10Val);
    const mel = melMin + yNorm * (melMax - melMin);
    return 700.0 * (Math.pow(10.0, mel / 2595.0) - 1.0);
  }
};

const GlitchLayer = memo(function GlitchLayer({ 
  glitches, viewStart, viewEnd, duration, onGlitchClick, onGlitchContextMenu, selectedGlitchIdx, 
  viewYStart, viewYEnd, scaleMode, sampleRate, isLocalHD
}) {
  if (!glitches || !duration) return null;

  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}>

      {glitches.map((glitch, idx) => {
        if (glitch.repaired) return null;
        
        // CORRECCIÓN EXACTA DE MAPEO STFT (Zero-Drift)
        // La textura STFT (WebGL) no abarca linealmente de 0 a total_samples.
        // El Frame 0 es (block_size/2) y el Frame N-1 es (samples - block_size/2).
        // Por lo tanto, el espectrograma está "comprimido" visualmente en los bordes.
        let timePercent = 0;
        if (sampleRate && duration) {
            const block_size = 4096;
            const centerOffset = block_size / 2;
            const total_samples = duration * sampleRate;
            const T = glitch.time_secs * sampleRate;

            if (isLocalHD) {
                // Modo Zoom: La textura cubre exactamente el slice [viewStart, viewEnd]
                const start_sample = viewStart * total_samples;
                const end_sample = viewEnd * total_samples;
                const slice_samples = end_sample - start_sample;
                
                const T_local = T - start_sample;
                
                // U_local es la coordenada [0, 1] dentro de la textura local
                const denominator = Math.max(1, slice_samples - block_size);
                let U_local = (T_local - centerOffset) / denominator;
                
                // Convertimos U_local de vuelta al espacio "timePercent" (0 a 1 global) 
                // para que la fórmula estándar de 'x' lo posicione correctamente en pantalla.
                timePercent = U_local * (viewEnd - viewStart) + viewStart;
            } else {
                // Modo Global: La textura abarca todo el archivo
                const denominator = Math.max(1, total_samples - block_size);
                const U_global = (T - centerOffset) / denominator;
                
                timePercent = U_global;
            }
        } else {
            // Fallback
            const stft_window_delay = (4096 / 2) / (sampleRate || 48000); 
            const visual_time_secs = glitch.time_secs - stft_window_delay;
            timePercent = visual_time_secs / duration;
        }
        
        if (timePercent < viewStart || timePercent > viewEnd) return null;

        const x = ((timePercent - viewStart) / (viewEnd - viewStart)) * 100;
        const actualIdx = glitch.originalIdx !== undefined ? glitch.originalIdx : idx;
        const isSelected = selectedGlitchIdx === actualIdx;
        
        // ── MAPEO DE COLORES Y ESTILOS POR TIPO DE EVENTO ──
        const type = glitch.event_type ? glitch.event_type.toLowerCase() : 'click';
        
        let baseColor = "#39FF14"; // Fallback: Verde Vostok Labs
        let dashArray = "none";
        let strokeW = isSelected ? "2.5" : "1";

        switch (type) {
          case 'click':
            baseColor = "#39FF14";
            dashArray = isSelected ? "none" : "3 2";
            break;
          case 'pop':
            baseColor = "#8AFF2E";
            dashArray = "none";
            strokeW = isSelected ? "3" : "1.5";
            break;
          case 'dropout':
            baseColor = "#FF9100";
            dashArray = isSelected ? "none" : "6 4";
            strokeW = isSelected ? "3" : "1.2";
            break;
          case 'hum':
            baseColor = "#00F5FF";
            dashArray = "none";
            strokeW = isSelected ? "2.5" : "1.2";
            break;
          case 'hiss':
            baseColor = "#BD00FF";
            dashArray = isSelected ? "none" : "2 2";
            strokeW = isSelected ? "2" : "0.8";
            break;
          case 'slip':
            baseColor = "#FFFF00";
            dashArray = isSelected ? "none" : "1 2";
            strokeW = isSelected ? "2.5" : "1.2";
            break;
          case 'distortion':
            baseColor = "#FF003C";
            dashArray = "none";
            strokeW = isSelected ? "3.5" : "2.0";
            break;
        }

        const opac = isSelected ? 1.0 : 0.60;
        const hasFreq = glitch.frequency !== null && glitch.frequency !== undefined;
        const isSpectral = (type === 'hum' || type === 'hiss') && hasFreq;

        let yPercent = 12.0; 
        if (isSpectral) {
          yPercent = getPercentYFromFreq(glitch.frequency, viewYStart, viewYEnd, scaleMode);
          if (yPercent < 0 || yPercent > 100) return null;
        }

        // --- CÁLCULO DE ANCHO DINÁMICO (THE PILL) ---
        let widthPercent = 1.2; // Ancho mínimo visual robusto (aprox 12px a 18px en pantalla)
        if (glitch.duration_samples && sampleRate) {
          const durSecs = glitch.duration_samples / sampleRate;
          // Porcentaje real del ancho en el viewport actual
          const exactWidth = ((durSecs / duration) / (viewEnd - viewStart)) * 100;
          widthPercent = Math.max(exactWidth, 1.2); // Garantiza que sea una cápsula gruesa y clickeable
        }

        const x_screen = ((timePercent - viewStart) / (viewEnd - viewStart)) * 100;
        // Desplazamos X ligeramente para centrar la cápsula
        const centeredX = x_screen - (widthPercent / 2);

        return (
          <g 
            key={`${glitch.channel}-${glitch.sample_index}-${idx}`} 
            className={`glitch-group ${isSelected ? 'selected' : ''}`}
            style={{ pointerEvents: 'auto', cursor: 'pointer', opacity: opac }} 
            onClick={(e) => { e.stopPropagation(); onGlitchClick && onGlitchClick(glitch, actualIdx); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onGlitchContextMenu && onGlitchContextMenu(glitch, actualIdx); }}
          >
            <title>[{type.toUpperCase()}] Tiempo: {glitch.time_secs.toFixed(4)}s | Ancho: {glitch.duration_samples} samples</title>
            
            {isSpectral ? (
              <>
                {/* Cápsula Horizontal para Ruidos Constantes */}
                <rect 
                  className="glitch-pill"
                  x={`${centeredX}%`} 
                  y={`${yPercent - 1}%`} 
                  width={`${widthPercent}%`} 
                  height="2%" 
                  rx="4" 
                  fill={isSelected ? `${baseColor}40` : "transparent"} 
                  stroke={baseColor} 
                  strokeWidth={strokeW} 
                  strokeDasharray={dashArray}
                />
              </>
            ) : (
              <>
                {/* 1. Top-Docked Pill (Anclada al cielo de la línea de tiempo) */}
                <rect 
                  className="glitch-pill"
                  x={`${centeredX}%`} 
                  y="2" 
                  width={`${widthPercent}%`} 
                  height="14" 
                  rx="3" 
                  fill={baseColor} 
                  fillOpacity={isSelected ? 1.0 : 0.6}
                  stroke={baseColor} 
                  strokeWidth="1" 
                />
                
                {/* 2. Haz de Luz (Ghost Beam) que baja desde la píldora */}
                <defs>
                  <linearGradient id={`grad-${idx}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={baseColor} stopOpacity="0.8" />
                    <stop offset="100%" stopColor={baseColor} stopOpacity="0" />
                  </linearGradient>
                </defs>
                <rect 
                  className="glitch-beam"
                  x={`${centeredX}%`} 
                  y="16" 
                  width={`${widthPercent}%`} 
                  height="100%" 
                  fill={`url(#grad-${idx})`} 
                  pointerEvents="none"
                />
                
                {/* 3. Hitbox invisible para facilitar el hover y click con el ratón */}
                <rect 
                  x={`calc(${centeredX}% - 8px)`} 
                  y="0" 
                  width={`calc(${widthPercent}% + 16px)`}
                  height="100%" 
                  fill="transparent" 
                />
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
});

const SettingsIcon = ({ size = 14, ...props }) => (
  <svg 
    xmlns="http://www.w3.org/2000/svg" 
    width={size} 
    height={size} 
    viewBox="0 0 24 24" 
    fill="none" 
    stroke="currentColor" 
    strokeWidth="2" 
    strokeLinecap="round" 
    strokeLinejoin="round" 
    {...props}
  >
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

const SpectrogramGL = memo(function SpectrogramGL({ 
  matrix, frames, bins, sampleRate, glitches, 
  viewStart, viewEnd, viewYStart, viewYEnd, duration, onGlitchClick, onGlitchContextMenu, selectedGlitchIdx,
  onViewportChange, onRenderComplete, matrixVersion,
  isZoomed, dbFloor, dbCeiling, scaleMode, waveformOpacity, waveformEnvelope,
  setDbFloor, setDbCeiling, setScaleMode, setWaveformOpacity,
  toolMode, healSelection, channels, playheadTime, onSeek,
  isLocalHD = false,
  loopStart = 0,
  loopEnd = duration,
  onLoopRangeChange,
  onScanLoop
}) {
  const canvasRef = useRef(null);
  const glRef     = useRef(null);
  const texRef    = useRef(null);
  const progRef   = useRef(null);
  const containerDivRef = useRef(null);

  const [selection, setSelection] = useState(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);
  const [showMenu, setShowMenu] = useState(false);
  const [colorPalette, setColorPalette] = useState(0); // 0 = Inferno, 1 = Viridis, 2 = Hielo, 3 = Monocromo
  const [showSettings, setShowSettings] = useState(false);

  const canvasAreaRef = useRef(null);

  // Limpiar selección si cambiamos de modo de herramienta
  useEffect(() => {
    if (toolMode !== 'select') {
      setSelection(null);
      setShowMenu(false);
    }
  }, [toolMode]);

  // Listener para la tecla ESC (para cancelar la selección)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        setSelection(null);
        setShowMenu(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleMouseDown = useCallback((e) => {
    if (e.button !== 0) return;

    if (toolMode === 'navigate') {
      if (!canvasAreaRef.current || !onSeek || !duration) return;
      const rect = canvasAreaRef.current.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const percent = Math.max(0, Math.min(1, clickX / rect.width));
      onSeek((viewStart + percent * (viewEnd - viewStart)) * duration);
      return;
    }

    if (toolMode !== 'select') return;
    
    e.stopPropagation();
    e.preventDefault();

    if (!canvasAreaRef.current) return;
    const rect = canvasAreaRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const clientY = e.clientY - rect.top;

    setIsDragging(true);
    setDragStart({ x: clientX, y: clientY });
    setSelection(null);
    setShowMenu(false);
  }, [toolMode, viewStart, viewEnd, duration, onSeek]);

  const handleMouseMove = useCallback((e) => {
    if (!isDragging || toolMode !== 'select' || !dragStart) return;

    e.stopPropagation();
    e.preventDefault();

    if (!canvasAreaRef.current) return;
    const rect = canvasAreaRef.current.getBoundingClientRect();
    const clientX = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const clientY = Math.max(0, Math.min(rect.height, e.clientY - rect.top));

    setSelection({
      x1: dragStart.x / rect.width,
      y1: dragStart.y / rect.height,
      x2: clientX / rect.width,
      y2: clientY / rect.height,
    });
  }, [isDragging, toolMode, dragStart]);

  const handleMouseUp = useCallback((e) => {
    if (!isDragging || toolMode !== 'select') return;

    e.stopPropagation();
    e.preventDefault();
    setIsDragging(false);

    if (selection && canvasAreaRef.current) {
      const rect = canvasAreaRef.current.getBoundingClientRect();
      const dragWidth = Math.abs(selection.x2 - selection.x1) * rect.width;
      const dragHeight = Math.abs(selection.y2 - selection.y1) * rect.height;

      // Umbral mínimo de 3 píxeles de arrastre para evitar clicks accidentales
      if (dragWidth > 3 || dragHeight > 3) {
        setShowMenu(true);
      } else {
        setSelection(null);
        setShowMenu(false);
      }
    } else {
      setSelection(null);
      setShowMenu(false);
    }
  }, [isDragging, toolMode, selection]);

  const handleApplyRepair = useCallback(async (type) => {
    if (!selection || !duration || !sampleRate || !healSelection) return;

    const left = Math.min(selection.x1, selection.x2);
    const right = Math.max(selection.x1, selection.x2);
    const top = Math.min(selection.y1, selection.y2);
    const bottom = Math.max(selection.y1, selection.y2);

    const t_start = (viewStart + left * (viewEnd - viewStart)) * duration;
    const t_end = (viewStart + right * (viewEnd - viewStart)) * duration;
    const t_dur = t_end - t_start;

    const sample_index = Math.floor(t_start * sampleRate);
    const duration_samples = Math.floor(t_dur * sampleRate);

    const pctYCenter = (top + bottom) / 2;
    const freqCenter = getFreqFromPercentY(pctYCenter, viewYStart, viewYEnd, scaleMode);

    // Mapeo de canal para estéreo (mitad superior = L, mitad inferior = R)
    const chCount = channels || 2;
    const channelSelected = chCount > 1 ? Math.floor(pctYCenter * chCount) : 0;

    const manualGlitch = {
      sample_index,
      time_secs: t_start,
      amplitude_delta: 0.1,
      direction: 0,
      event_type: type,
      repaired: false,
      frequency: freqCenter,
      channel: channelSelected,
      duration_samples: duration_samples,
    };

    console.log(
      `%c[VOSTOK SURGERY] SELECCIÓN SPECTRAL DETECTADA\n` +
      `-----------------------------------------\n` +
      `• Región Tiempo  : [${t_start.toFixed(4)}s - ${t_end.toFixed(4)}s] (Duración: ${(t_dur * 1000).toFixed(2)}ms)\n` +
      `• Coordenadas X  : [x1: ${(left*100).toFixed(2)}%, x2: ${(right*100).toFixed(2)}%] de pantalla\n` +
      `• Centro Freq    : ${freqCenter.toFixed(1)} Hz (Coordenadas Y: [y1: ${(top*100).toFixed(2)}%, y2: ${(bottom*100).toFixed(2)}%])\n` +
      `• Canal Objetivo : Ch ${channelSelected} (${channelSelected === 0 ? 'Izquierdo/L' : 'Derecho/R'})\n` +
      `• Tipo Glitch    : ${type.toUpperCase()}\n` +
      `• Algoritmo DSP  : ${
        type === 'click' ? 'Interpolación Hermite Cúbica (Tiempo)' :
        type === 'pop' || type === 'dropout' ? 'Modelo Autoregresivo LSAR' :
        type === 'hum' ? 'Filtro Notch IIR en fundamental y armónicos' :
        type === 'distortion' ? 'De-clipping Hermite Spline' : 'Restauración Predictiva'
      }\n` +
      `-----------------------------------------`,
      'color: #39FF14; font-weight: bold;'
    );

    // Limpiamos selección y cerramos menú inmediatamente para dar feedback ágil
    setSelection(null);
    setShowMenu(false);

    await healSelection(manualGlitch);
  }, [selection, duration, sampleRate, viewStart, viewEnd, viewYStart, viewYEnd, scaleMode, channels, healSelection]);

  const filteredGlitches = useMemo(() => {
    if (!glitches || !duration) return [];
    const margin = (viewEnd - viewStart) * 0.01;
    const startBound = viewStart - margin;
    const endBound = viewEnd + margin;

    const result = [];
    for (let i = 0; i < glitches.length; i++) {
      const g = glitches[i];
      const t = g.time_secs / duration;
      if (t >= startBound && t <= endBound) {
        result.push({ ...g, originalIdx: i });
      }
    }
    return result;
  }, [glitches, viewStart, viewEnd, duration]);

  const waveformPaths = useMemo(() => {
    if (!waveformEnvelope || waveformEnvelope.length === 0 || waveformOpacity === 0 || !sampleRate || !duration) {
      return { fillD: null, topD: null, bottomD: null };
    }
    const n = waveformEnvelope.length;
    const pointsTop = [];
    const pointsBottom = [];

    // Dibujamos un poco más allá de los bordes para que el trazo SVG no termine abruptamente
    const margin = Math.floor(n * 0.05); 
    const step = Math.max(1, Math.floor((viewEnd - viewStart) * n / 300));
    const startIdx = Math.max(0, Math.floor(viewStart * n) - margin);
    const endIdx = Math.min(n - 1, Math.ceil(viewEnd * n) + margin);

    const block_size = 4096;
    const centerOffset = block_size / 2;
    const total_samples = duration * sampleRate;

    for (let i = startIdx; i <= endIdx; i += step) {
      const idx = Math.min(i, n - 1);
      const val = waveformEnvelope[idx] || 0.0;
      
      const T = (idx / n) * total_samples;
      let timePercent = 0;

      if (isLocalHD) {
          const start_sample = viewStart * total_samples;
          const end_sample = viewEnd * total_samples;
          const slice_samples = end_sample - start_sample;
          const T_local = T - start_sample;
          const denominator = Math.max(1, slice_samples - block_size);
          const U_local = (T_local - centerOffset) / denominator;
          timePercent = U_local * (viewEnd - viewStart) + viewStart;
      } else {
          const denominator = Math.max(1, total_samples - block_size);
          timePercent = (T - centerOffset) / denominator;
      }

      const xPercent = ((timePercent - viewStart) / (viewEnd - viewStart)) * 100;
      
      const yTop = 50 - val * 45;
      const yBottom = 50 + val * 45;
      
      pointsTop.push(`${xPercent.toFixed(1)},${yTop.toFixed(1)}`);
      pointsBottom.push(`${xPercent.toFixed(1)},${yBottom.toFixed(1)}`);
    }

    if (pointsTop.length === 0) return { fillD: null, topD: null, bottomD: null };

    const topD = `M ${pointsTop.join(' L ')}`;
    const bottomD = `M ${pointsBottom.join(' L ')}`;
    
    const pointsBottomRev = [...pointsBottom].reverse();
    const fillD = `${topD} L ${pointsBottomRev.join(' L ')} Z`;

    return { fillD, topD, bottomD };
  }, [waveformEnvelope, viewStart, viewEnd, waveformOpacity, isLocalHD, sampleRate, duration]);

  const initGL = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl', { antialias: true, alpha: false });
    if (!gl) return;
    glRef.current = gl;

    const createShader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };

    const prog = gl.createProgram();
    gl.attachShader(prog, createShader(gl.VERTEX_SHADER, VERT_SHADER));
    gl.attachShader(prog, createShader(gl.FRAGMENT_SHADER, FRAG_SHADER));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    progRef.current = prog;

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    const posLoc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    texRef.current = tex;

    gl.uSampleRate = gl.getUniformLocation(prog, 'u_sampleRate');
    gl.uViewStart  = gl.getUniformLocation(prog, 'u_viewStart');
    gl.uViewEnd    = gl.getUniformLocation(prog, 'u_viewEnd');
    gl.uViewYStart = gl.getUniformLocation(prog, 'u_viewYStart');
    gl.uViewYEnd   = gl.getUniformLocation(prog, 'u_viewYEnd');
    gl.uDbFloor    = gl.getUniformLocation(prog, 'u_dbFloor');
    gl.uDbCeiling  = gl.getUniformLocation(prog, 'u_dbCeiling');
    gl.uIsZoomed   = gl.getUniformLocation(prog, 'u_isZoomed');
    gl.uScaleMode  = gl.getUniformLocation(prog, 'u_scaleMode');
    gl.uColorPalette = gl.getUniformLocation(prog, 'u_colorPalette');
  }, []);

  const draw = useCallback(() => {
    const gl = glRef.current;
    if (!gl || !texRef.current) return;
    gl.bindTexture(gl.TEXTURE_2D, texRef.current);
    gl.uniform1f(gl.uSampleRate, sampleRate || 48000);
    gl.uniform1f(gl.uViewStart, isLocalHD ? 0.0 : viewStart);
    gl.uniform1f(gl.uViewEnd, isLocalHD ? 1.0 : viewEnd);
    gl.uniform1f(gl.uViewYStart, viewYStart);
    gl.uniform1f(gl.uViewYEnd, viewYEnd);
    gl.uniform1f(gl.uDbFloor, dbFloor);
    gl.uniform1f(gl.uDbCeiling, dbCeiling);
    gl.uniform1f(gl.uIsZoomed, isZoomed ? 1.0 : 0.0);
    gl.uniform1f(gl.uScaleMode, parseFloat(scaleMode));
    gl.uniform1f(gl.uColorPalette, parseFloat(colorPalette));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [sampleRate, viewStart, viewEnd, viewYStart, viewYEnd, dbFloor, dbCeiling, isZoomed, scaleMode, colorPalette, isLocalHD]);

  useEffect(() => {
    if (!matrix || !glRef.current || !texRef.current) {
      return;
    }
    if (matrix.length !== frames * bins || frames === 0 || bins === 0) {
      console.warn(`[SpectrogramGL useEffect] Early return: dimension mismatch! matrix.length: ${matrix.length} vs frames*bins: ${frames * bins} (${frames}x${bins})`);
      return;
    }

    const gl = glRef.current;
    gl.bindTexture(gl.TEXTURE_2D, texRef.current);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

    // Transferencia Zero-Copy directa a la textura WebGL
    const t_tex = performance.now();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, bins, frames, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, matrix);
    const t_tex_elapsed = performance.now() - t_tex;

    console.log(
      `%c[VOSTOK RENDERING] ESPECTROGRAMA ACTUALIZADO\n` +
      `• Textura WebGL  : Cargada con éxito (${frames} frames x ${bins} bins)\n` +
      `• Matriz Versión : ${matrixVersion}\n` +
      `• Canal Visual   : Actualizado en GPU (Zero-Copy Transfer)`,
      'color: #00FFFF; font-weight: bold;'
    );
    console.log(`[PROF][WebGL] texImage2D | frames=${frames} bins=${bins} | matrix_bytes=${matrix.length} (${(matrix.length/1024).toFixed(1)}KB) | elapsed=${t_tex_elapsed.toFixed(2)}ms | version=${matrixVersion}`);

    if (drawRef.current) {
      drawRef.current();
    }

    if (onRenderComplete) {
      requestAnimationFrame(() => onRenderComplete());
    }
  }, [matrix, matrixVersion, frames, bins, onRenderComplete]);

  useEffect(() => { draw(); }, [draw]);

  const drawRef = useRef();
  drawRef.current = draw;

  useEffect(() => {
    initGL();
    const resize = () => {
      const c = canvasRef.current;
      if (!c) return;
      c.width = c.offsetWidth * window.devicePixelRatio;
      c.height = c.offsetHeight * window.devicePixelRatio;
      if (glRef.current) glRef.current.viewport(0, 0, c.width, c.height);
      if (drawRef.current) drawRef.current();
    };
    window.addEventListener('resize', resize);
    resize();
    return () => window.removeEventListener('resize', resize);
  }, [initGL]);

  const viewStartRef = useRef(viewStart);
  const viewEndRef = useRef(viewEnd);
  viewStartRef.current = viewStart;
  viewEndRef.current = viewEnd;

  useEffect(() => {
    const el = containerDivRef.current;
    if (!el) return;

    let rafId = null;
    let pendingViewport = null;

    const handleWheelLocal = (e) => {
      if (toolMode === 'select') return; // Deshabilitar zoom/scroll en modo selección
      e.preventDefault();
      if (!onViewportChange) return;

      const currentViewStart = viewStartRef.current;
      const currentViewEnd = viewEndRef.current;
      const currentWidth = currentViewEnd - currentViewStart;

      let nextStart, nextEnd;

      if (e.ctrlKey) {
        // --- Scroll / Paneo Horizontal ---
        const panFactor = (e.deltaY > 0 ? 1 : -1) * currentWidth * 0.1;
        nextStart = currentViewStart + panFactor;
        nextEnd = currentViewEnd + panFactor;

        if (nextStart < 0) {
          nextStart = 0;
          nextEnd = currentWidth;
        } else if (nextEnd > 1) {
          nextEnd = 1;
          nextStart = 1 - currentWidth;
        }
      } else {
        // --- Zoom Anclado al Mouse ---
        const rect = el.getBoundingClientRect();
        const mouseX = e.clientX - rect.left;
        const hoverPercent = mouseX / rect.width;

        const timeAtMouse = currentViewStart + hoverPercent * currentWidth;
        const zoomFactor = e.deltaY < 0 ? 1 / 1.2 : 1.2;
        const newWidth = Math.max(0.01, Math.min(1.0, currentWidth * zoomFactor));

        nextStart = timeAtMouse - hoverPercent * newWidth;
        nextEnd = nextStart + newWidth;

        if (nextStart < 0) {
          nextStart = 0;
          nextEnd = newWidth;
        } else if (nextEnd > 1) {
          nextEnd = 1;
          nextStart = 1 - newWidth;
        }
      }

      pendingViewport = { start: nextStart, end: nextEnd };

      if (!rafId) {
        rafId = requestAnimationFrame(() => {
          if (pendingViewport) {
            onViewportChange(pendingViewport.start, pendingViewport.end);
            pendingViewport = null;
          }
          rafId = null;
        });
      }
    };

    el.addEventListener('wheel', handleWheelLocal, { passive: false });
    return () => {
      el.removeEventListener('wheel', handleWheelLocal);
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [onViewportChange, toolMode]);

  const renderRulerTicks = () => {
    if (!duration) return null;
    const ticks = [];
    const tStart = viewStart * duration;
    const tEnd = viewEnd * duration;
    const tRange = tEnd - tStart;

    let interval = 1.0;
    if (tRange < 0.2) interval = 0.01;
    else if (tRange < 1.0) interval = 0.05;
    else if (tRange < 2.0) interval = 0.1;
    else if (tRange < 5.0) interval = 0.25;
    else if (tRange < 10.0) interval = 0.5;
    else if (tRange < 30.0) interval = 2.0;
    else if (tRange < 60.0) interval = 5.0;
    else interval = 10.0;

    const firstTick = Math.ceil(tStart / interval) * interval;
    for (let t = firstTick; t <= tEnd; t += interval) {
      const xPercent = ((t / duration - viewStart) / (viewEnd - viewStart)) * 100;
      if (xPercent >= 0 && xPercent <= 100) {
        ticks.push(
          <div key={t} style={{
            position: 'absolute', left: `${xPercent}%`, bottom: 0,
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            transform: 'translateX(-50%)', pointerEvents: 'none'
          }}>
            <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: '8px', color: 'rgba(255,255,255,0.4)', marginBottom: '2px' }}>
              {t.toFixed(2)}s
            </span>
            <div style={{ width: '1px', height: '5px', backgroundColor: 'rgba(255,255,255,0.3)' }} />
          </div>
        );
      }
    }
    return ticks;
  };

  const startVal = loopStart ?? 0;
  const endVal = loopEnd ?? duration;

  const getXPercent = useCallback((timeSecs) => {
    if (!duration) return 0;
    const viewWidth = viewEnd - viewStart;
    if (viewWidth <= 0) return 0;
    return ((timeSecs / duration - viewStart) / viewWidth) * 100;
  }, [duration, viewStart, viewEnd]);

  const leftPct = getXPercent(startVal);
  const rightPct = getXPercent(endVal);
  const widthPct = rightPct - leftPct;

  const handleRulerMouseDown = useCallback((e) => {
    if (e.button !== 0 || !duration) return;
    e.preventDefault();
    e.stopPropagation();

    const rect = e.currentTarget.getBoundingClientRect();
    const width = rect.width;
    const clickX = e.clientX - rect.left;
    const clickPercent = clickX / width;
    const clickTime = (viewStart + clickPercent * (viewEnd - viewStart)) * duration;

    // Calculate pixel coordinates of handles
    const startX = (getXPercent(startVal) / 100) * width;
    const endX = (getXPercent(endVal) / 100) * width;

    // Threshold for selecting a handle: 15 pixels
    const handleThreshold = 15;
    let dragType = 'new'; // 'start' | 'end' | 'new'

    if (Math.abs(clickX - startX) <= handleThreshold) {
      dragType = 'start';
    } else if (Math.abs(clickX - endX) <= handleThreshold) {
      dragType = 'end';
    }

    let dragDistance = 0;
    const initialClientX = e.clientX;
    const initialStart = startVal;
    const initialEnd = endVal;

    const handleMouseMove = (moveEvent) => {
      const currentClientX = moveEvent.clientX;
      dragDistance = Math.abs(currentClientX - initialClientX);

      const deltaX = currentClientX - initialClientX;
      const deltaPercent = deltaX / width;
      const deltaTime = deltaPercent * (viewEnd - viewStart) * duration;

      let nextStart = initialStart;
      let nextEnd = initialEnd;

      if (dragType === 'start') {
        nextStart = Math.max(0, Math.min(initialStart + deltaTime, nextEnd - 0.05));
      } else if (dragType === 'end') {
        nextEnd = Math.max(nextStart + 0.05, Math.min(initialEnd + deltaTime, duration));
      } else {
        // Dragging to create a new region
        const currentX = moveEvent.clientX - rect.left;
        const currentPercent = currentX / width;
        const currentTime = (viewStart + currentPercent * (viewEnd - viewStart)) * duration;
        nextStart = Math.max(0, Math.min(clickTime, currentTime));
        nextEnd = Math.max(clickTime, currentTime);
        
        // Ensure minimum loop duration
        if (nextEnd - nextStart < 0.05) {
          nextEnd = nextStart + 0.05;
        }
        nextStart = Math.max(0, nextStart);
        nextEnd = Math.min(duration, nextEnd);
      }

      if (onLoopRangeChange) {
        onLoopRangeChange(nextStart, nextEnd);
      }
    };

    const handleMouseUp = () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);

      if (dragDistance < 5 && onSeek) {
        onSeek(clickTime);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [duration, viewStart, viewEnd, startVal, endVal, getXPercent, onLoopRangeChange, onSeek]);

  return (
    <div 
      ref={containerDivRef}
      style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#000', overflow: 'hidden' }}
    >
      {/* Timeline Ruler */}
      <div 
        onMouseDown={handleRulerMouseDown}
        onDoubleClick={() => onLoopRangeChange && onLoopRangeChange(0, 0)}
        style={{ 
          height: '24px', 
          width: '100%', 
          backgroundColor: '#0a0a0a', 
          borderBottom: '1px solid rgba(255, 255, 255, 0.1)', 
          position: 'relative', 
          cursor: 'col-resize', 
          overflow: 'hidden', 
          userSelect: 'none' 
        }}
      >
        {renderRulerTicks()}

        {/* Highlighted Loop Region in the Ruler */}
        {duration > 0 && widthPct > 0 && (
          <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${leftPct}%`,
            width: `${widthPct}%`,
            backgroundColor: 'rgba(255, 255, 255, 0.15)',
            borderLeft: '1px solid rgba(255, 255, 255, 0.6)',
            borderRight: '1px solid rgba(255, 255, 255, 0.6)',
            pointerEvents: 'none',
            boxShadow: 'inset 0 0 8px rgba(255, 255, 255, 0.2)',
            zIndex: 1
          }} />
        )}

        {/* Botón de Escaneo de Loop */}
        {duration > 0 && widthPct > 8 && (loopEnd - loopStart < duration - 0.001) && (
          <button
            onMouseDown={(e) => {
              e.stopPropagation();
              e.preventDefault();
            }}
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              if (onScanLoop) onScanLoop();
            }}
            style={{
              position: 'absolute',
              top: '3px',
              left: `${leftPct + widthPct / 2}%`,
              transform: 'translateX(-50%)',
              height: '18px',
              padding: '0 8px',
              background: '#010101',
              border: '1px solid #39FF14',
              borderRadius: '3px',
              color: '#39FF14',
              fontSize: '8px',
              fontWeight: 900,
              fontFamily: 'JetBrains Mono, monospace',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              zIndex: 10,
              pointerEvents: 'auto',
              boxShadow: '0 0 8px rgba(57, 255, 20, 0.35)',
              transition: 'all 0.15s ease',
              whiteSpace: 'nowrap'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = '#39FF14';
              e.currentTarget.style.color = '#010101';
              e.currentTarget.style.boxShadow = '0 0 12px #39FF14';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = '#010101';
              e.currentTarget.style.color = '#39FF14';
              e.currentTarget.style.boxShadow = '0 0 8px rgba(57, 255, 20, 0.35)';
            }}
            title="Escanear y detectar anomalías en la región del loop"
          >
            <span style={{ fontSize: '7px' }}>⚡</span> ESCANEAR LOOP
          </button>
        )}

        {/* Left handle in the Ruler */}
        {duration > 0 && widthPct > 0 && leftPct >= 0 && leftPct <= 100 && (
          <div style={{
            position: 'absolute',
            left: `${leftPct}%`,
            top: 0,
            bottom: 0,
            width: '12px',
            marginLeft: '-6px',
            cursor: 'col-resize',
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none'
          }}>
            <div style={{
              width: '4px',
              height: '14px',
              backgroundColor: '#FFFFFF',
              borderRadius: '1px',
              boxShadow: '0 0 5px rgba(0, 245, 255, 0.8)'
            }} />
          </div>
        )}

        {/* Right handle in the Ruler */}
        {duration > 0 && widthPct > 0 && rightPct >= 0 && rightPct <= 100 && (
          <div style={{
            position: 'absolute',
            left: `${rightPct}%`,
            top: 0,
            bottom: 0,
            width: '12px',
            marginLeft: '-6px',
            cursor: 'col-resize',
            zIndex: 2,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none'
          }}>
            <div style={{
              width: '4px',
              height: '14px',
              backgroundColor: '#FFFFFF',
              borderRadius: '1px',
              boxShadow: '0 0 5px rgba(0, 245, 255, 0.8)'
            }} />
          </div>
        )}
      </div>

      {/* Canvas Area */}
      <div 
        ref={canvasAreaRef}
        style={{ 
          position: 'relative', 
          flex: 1, 
          overflow: 'hidden', 
          cursor: toolMode === 'select' ? 'crosshair' : 'pointer' 
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />

        {/* Dimmed Areas (Zones outside the loop region) */}
        {duration > 0 && widthPct > 0 && leftPct > 0 && (
          <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: 0,
            width: `${Math.min(100, leftPct)}%`,
            backgroundColor: 'rgba(1, 1, 1, 0.65)',
            pointerEvents: 'none',
            zIndex: 3
          }} />
        )}
        {duration > 0 && widthPct > 0 && rightPct < 100 && (
          <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${Math.max(0, rightPct)}%`,
            right: 0,
            backgroundColor: 'rgba(1, 1, 1, 0.65)',
            pointerEvents: 'none',
            zIndex: 3
          }} />
        )}

        {/* Boundary vertical lines */}
        {duration > 0 && widthPct > 0 && leftPct > 0 && leftPct < 100 && (
          <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${leftPct}%`,
            width: '1px',
            borderLeft: '1px dashed rgba(57, 255, 20, 0.35)',
            pointerEvents: 'none',
            zIndex: 3
          }} />
        )}
        {duration > 0 && widthPct > 0 && rightPct > 0 && rightPct < 100 && (
          <div style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            left: `${rightPct}%`,
            width: '1px',
            borderLeft: '1px dashed rgba(57, 255, 20, 0.35)',
            pointerEvents: 'none',
            zIndex: 3
          }} />
        )}
        
        {/* Waveform Overlay SVG (con viewBox y preserveAspectRatio="none" para que se estire exactamente con el canvas) */}
        {waveformPaths.fillD && (
          <svg 
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 4 }}
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <defs>
              <linearGradient id="waveformGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#39FF14" stopOpacity="0.16" />
                <stop offset="50%" stopColor="#39FF14" stopOpacity="0.01" />
                <stop offset="100%" stopColor="#39FF14" stopOpacity="0.16" />
              </linearGradient>
            </defs>

            {/* Relleno con degradado vertical holográfico */}
            <path 
              d={waveformPaths.fillD} 
              fill="url(#waveformGrad)" 
              stroke="none"
              vectorEffect="non-scaling-stroke"
              style={{ transition: 'opacity 0.15s ease' }}
              opacity={waveformOpacity}
            />

            {/* Contorno superior con glow holográfico */}
            <path 
              d={waveformPaths.topD} 
              fill="none" 
              stroke="#39FF14" 
              strokeWidth="1.2" 
              vectorEffect="non-scaling-stroke"
              style={{ 
                transition: 'opacity 0.15s ease',
                filter: 'drop-shadow(0 0 3px rgba(57, 255, 20, 0.75))'
              }}
              opacity={waveformOpacity * 0.9}
            />

            {/* Contorno inferior con glow holográfico */}
            <path 
              d={waveformPaths.bottomD} 
              fill="none" 
              stroke="#39FF14" 
              strokeWidth="1.2" 
              vectorEffect="non-scaling-stroke"
              style={{ 
                transition: 'opacity 0.15s ease',
                filter: 'drop-shadow(0 0 3px rgba(57, 255, 20, 0.75))'
              }}
              opacity={waveformOpacity * 0.9}
            />
          </svg>
        )}

        <GlitchLayer
          glitches={filteredGlitches} viewStart={viewStart} viewEnd={viewEnd} duration={duration}
          onGlitchClick={onGlitchClick} onGlitchContextMenu={onGlitchContextMenu} selectedGlitchIdx={selectedGlitchIdx}
          viewYStart={viewYStart} viewYEnd={viewYEnd}
          scaleMode={scaleMode}
          sampleRate={sampleRate}
          isLocalHD={isLocalHD}
        />

        <PlaybackCursor
          playheadTime={playheadTime}
          viewStart={viewStart}
          viewEnd={viewEnd}
          duration={duration}
        />

        {/* SVG de selección spectral manual */}
        {selection && (
          <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 6 }}>
            <rect
              x={`${Math.min(selection.x1, selection.x2) * 100}%`}
              y={`${Math.min(selection.y1, selection.y2) * 100}%`}
              width={`${Math.abs(selection.x2 - selection.x1) * 100}%`}
              height={`${Math.abs(selection.y2 - selection.y1) * 100}%`}
              fill="rgba(57, 255, 20, 0.08)"
              stroke="#39FF14"
              strokeWidth="1.5"
              strokeDasharray="4 3"
              style={{
                filter: 'drop-shadow(0 0 3px rgba(57, 255, 20, 0.5))'
              }}
            />
          </svg>
        )}

        {/* Menú contextual flotante de restauración quirúrgica */}
        {selection && showMenu && (
          <div
            style={{
              position: 'absolute',
              left: `${(Math.min(selection.x1, selection.x2) + Math.max(selection.x1, selection.x2)) / 2 * 100}%`,
              top: Math.min(selection.y1, selection.y2) * 100 > 15 
                ? `calc(${Math.min(selection.y1, selection.y2) * 100}% - 8px)` 
                : `calc(${Math.max(selection.y1, selection.y2) * 100}% + 8px)`,
              transform: Math.min(selection.y1, selection.y2) * 100 > 15
                ? 'translate(-50%, -100%)'
                : 'translate(-50%, 0)',
              zIndex: 100,
              backgroundColor: 'rgba(1, 1, 1, 0.92)',
              backdropFilter: 'blur(10px)',
              border: '1px solid #39FF14',
              boxShadow: '0 0 15px rgba(57, 255, 20, 0.4), 0 4px 20px rgba(0, 0, 0, 0.8)',
              borderRadius: '4px',
              padding: '6px 8px',
              display: 'flex',
              gap: '6px',
              alignItems: 'center',
              pointerEvents: 'auto',
              userSelect: 'none'
            }}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          >
            <span style={{ fontSize: '8px', color: 'rgba(255,255,255,0.4)', fontWeight: 900, marginRight: '4px', letterSpacing: '0.05em' }}>REPARAR:</span>

            {['click', 'pop', 'hum', 'dropout', 'distortion'].map((type) => (
              <button
                key={type}
                onClick={() => handleApplyRepair(type)}
                style={{
                  background: 'rgba(255, 255, 255, 0.04)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  color: '#fff',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '9px',
                  fontWeight: 'bold',
                  padding: '3px 6px',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  transition: 'all 0.1s ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = '#39FF14';
                  e.currentTarget.style.color = '#39FF14';
                  e.currentTarget.style.backgroundColor = 'rgba(57, 255, 20, 0.05)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.1)';
                  e.currentTarget.style.color = '#fff';
                  e.currentTarget.style.backgroundColor = 'rgba(255, 255, 255, 0.04)';
                }}
              >
                {type.toUpperCase() === 'DISTORTION' ? 'CLIP' : type.toUpperCase()}
              </button>
            ))}

            <div style={{ width: '1px', height: '12px', backgroundColor: 'rgba(255,255,255,0.2)', margin: '0 2px' }} />

            <button
              onClick={() => {
                setSelection(null);
                setShowMenu(false);
              }}
              style={{
                background: 'none',
                border: 'none',
                color: 'rgba(255, 255, 255, 0.4)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: '9px',
                fontWeight: 'bold',
                cursor: 'pointer',
                padding: '3px 6px',
              }}
              onMouseEnter={(e) => e.currentTarget.style.color = '#ff4d00'}
              onMouseLeave={(e) => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.4)'}
            >
              ESC
            </button>
          </div>
        )}

        {/* Botón de Ajustes Espectrales */}
        <button
          onMouseDown={(e) => e.stopPropagation()}
          onMouseUp={(e) => e.stopPropagation()}
          onClick={(e) => { e.stopPropagation(); setShowSettings(!showSettings); }}
          style={{
            position: 'absolute',
            top: '8px',
            right: '48px',
            zIndex: 200,
            backgroundColor: showSettings ? 'rgba(57, 255, 20, 0.15)' : 'rgba(1, 1, 1, 0.75)',
            backdropFilter: 'blur(8px)',
            border: showSettings ? '1px solid #39FF14' : '1px solid rgba(57, 255, 20, 0.25)',
            borderRadius: '4px',
            padding: '6px',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: showSettings ? '#39FF14' : '#fff',
            transition: 'all 0.15s ease',
            boxShadow: '0 4px 12px rgba(0,0,0,0.5)'
          }}
          onMouseEnter={(e) => {
            if (!showSettings) {
              e.currentTarget.style.borderColor = '#39FF14';
              e.currentTarget.style.boxShadow = '0 0 8px rgba(57, 255, 20, 0.4)';
            }
          }}
          onMouseLeave={(e) => {
            if (!showSettings) {
              e.currentTarget.style.borderColor = 'rgba(57, 255, 20, 0.25)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.5)';
            }
          }}
          title="Configuración Visual del Espectrograma"
        >
          <SettingsIcon size={14} />
        </button>

        {/* Panel de Ajustes Espectrales (Overlay) */}
        {showSettings && (
          <div
            onMouseDown={(e) => e.stopPropagation()}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            onMouseMove={(e) => e.stopPropagation()}
            style={{
              position: 'absolute',
              top: '42px',
              right: '10px',
              zIndex: 200,
              backgroundColor: 'rgba(1, 1, 1, 0.94)',
              backdropFilter: 'blur(12px)',
              border: '1px solid rgba(57, 255, 20, 0.35)',
              borderRadius: '6px',
              padding: '14px',
              display: 'flex',
              flexDirection: 'column',
              gap: '12px',
              minWidth: '220px',
              boxShadow: '0 6px 24px rgba(0, 0, 0, 0.8), 0 0 15px rgba(57, 255, 20, 0.15)',
              userSelect: 'none'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid rgba(255, 255, 255, 0.08)', paddingBottom: '6px' }}>
              <span style={{ fontSize: '9px', color: '#39FF14', fontWeight: 900, letterSpacing: '0.05em' }}>AJUSTES ESPECTRALES</span>
              <button 
                onClick={() => setShowSettings(false)}
                style={{ background: 'none', border: 'none', color: 'rgba(255, 255, 255, 0.4)', cursor: 'pointer', fontSize: '10px', padding: 0 }}
                onMouseEnter={e => e.currentTarget.style.color = '#39FF14'}
                onMouseLeave={e => e.currentTarget.style.color = 'rgba(255, 255, 255, 0.4)'}
              >
                ✕
              </button>
            </div>

            {/* Escala */}
            {setScaleMode && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <span style={{ fontSize: '8px', color: 'rgba(255, 255, 255, 0.4)', fontWeight: 900, letterSpacing: '0.05em' }}>ESCALA</span>
                <select
                  value={scaleMode}
                  onChange={(e) => setScaleMode(parseInt(e.target.value))}
                  style={{
                    background: '#0a0a0a',
                    border: '1px solid rgba(255, 255, 255, 0.15)',
                    color: '#fff',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: '9px',
                    padding: '3px 6px',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    outline: 'none'
                  }}
                >
                  <option value={1}>Mel</option>
                  <option value={3}>Bark</option>
                  <option value={2}>Logarítmica</option>
                  <option value={0}>Lineal</option>
                </select>
              </div>
            )}

            {/* Paleta */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
              <span style={{ fontSize: '8px', color: 'rgba(255, 255, 255, 0.4)', fontWeight: 900, letterSpacing: '0.05em' }}>PALETA</span>
              <select
                value={colorPalette}
                onChange={(e) => setColorPalette(parseInt(e.target.value))}
                style={{
                  background: '#0a0a0a',
                  border: '1px solid rgba(255, 255, 255, 0.15)',
                  color: '#fff',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: '9px',
                  padding: '3px 6px',
                  borderRadius: '3px',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >
                <option value={0}>Inferno</option>
                <option value={1}>Viridis</option>
                <option value={2}>Hielo</option>
                <option value={3}>Monocromo</option>
              </select>
            </div>

            {/* Opacidad Onda */}
            {setWaveformOpacity && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', fontWeight: 900 }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.4)', letterSpacing: '0.05em' }}>OPACIDAD DE ONDA</span>
                  <span style={{ color: '#39FF14' }}>{(waveformOpacity * 100).toFixed(0)}%</span>
                </div>
                <input
                  type="range"
                  min="0.0"
                  max="1.0"
                  step="0.05"
                  value={waveformOpacity}
                  onChange={(e) => setWaveformOpacity(parseFloat(e.target.value))}
                  style={{
                    accentColor: '#39FF14',
                    height: '3px',
                    cursor: 'pointer',
                    width: '100%',
                    margin: '2px 0'
                  }}
                />
              </div>
            )}

            {/* Piso de Ruido */}
            {setDbFloor && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', fontWeight: 900 }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.4)', letterSpacing: '0.05em' }}>PISO DE RUIDO</span>
                  <span style={{ color: '#39FF14' }}>{dbFloor.toFixed(0)} dB</span>
                </div>
                <input
                  type="range"
                  min="-96.0"
                  max="-20.0"
                  step="1.0"
                  value={dbFloor}
                  onChange={(e) => setDbFloor(parseFloat(e.target.value))}
                  style={{
                    accentColor: '#39FF14',
                    height: '3px',
                    cursor: 'pointer',
                    width: '100%',
                    margin: '2px 0'
                  }}
                />
              </div>
            )}

            {/* Techo de Rango */}
            {setDbCeiling && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '8px', fontWeight: 900 }}>
                  <span style={{ color: 'rgba(255, 255, 255, 0.4)', letterSpacing: '0.05em' }}>TECHO DE RANGO</span>
                  <span style={{ color: '#39FF14' }}>{dbCeiling.toFixed(0)} dB</span>
                </div>
                <input
                  type="range"
                  min="-20.0"
                  max="0.0"
                  step="1.0"
                  value={dbCeiling}
                  onChange={(e) => setDbCeiling(parseFloat(e.target.value))}
                  style={{
                    accentColor: '#39FF14',
                    height: '3px',
                    cursor: 'pointer',
                    width: '100%',
                    margin: '2px 0'
                  }}
                />
              </div>
            )}
          </div>
        )}
      </div>

      {/* dB Scale Legend (Calibración dinámica reactiva SOTA) */}
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: '#050505', borderTop: '1px solid rgba(255, 255, 255, 0.08)', padding: '6px 24px', height: '32px', flexShrink: 0, userSelect: 'none' }}>
        <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <div style={{
            height: '4px', width: '100%', borderRadius: '2px',
            background: (() => {
              switch (colorPalette) {
                case 1: // Viridis
                  return 'linear-gradient(to right, rgb(68, 1, 84) 0%, rgb(59, 82, 139) 25%, rgb(33, 145, 140) 50%, rgb(94, 201, 98) 75%, rgb(253, 231, 37) 100%)';
                case 2: // Hielo
                  return 'linear-gradient(to right, rgb(0, 0, 26) 0%, rgb(0, 51, 153) 20%, rgb(0, 204, 255) 50%, rgb(153, 230, 255) 80%, rgb(255, 255, 255) 100%)';
                case 3: // Monocromo
                  return 'linear-gradient(to right, rgb(0, 0, 0) 0%, rgb(255, 255, 255) 100%)';
                case 0: // Inferno
                default:
                  return 'linear-gradient(to right, rgb(0, 0, 13) 0%, rgb(0, 26, 128) 10%, rgb(153, 0, 153) 30%, rgb(255, 77, 0) 60%, rgb(255, 230, 0) 85%, rgb(255, 255, 255) 100%)';
              }
            })()
          }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'JetBrains Mono, monospace', fontSize: '8px', color: 'rgba(255,255,255,0.4)', fontWeight: 900 }}>
            <span>{dbFloor.toFixed(0)} dB</span>
            <span>{(dbFloor * 0.75 + dbCeiling * 0.25).toFixed(0)} dB</span>
            <span>{(dbFloor * 0.5 + dbCeiling * 0.5).toFixed(0)} dB</span>
            <span>{(dbFloor * 0.25 + dbCeiling * 0.75).toFixed(0)} dB</span>
            <span>{dbCeiling.toFixed(0)} dB</span>
          </div>
        </div>
      </div>
    </div>
  );
});

export default SpectrogramGL;

export const PlaybackCursor = memo(function PlaybackCursor({ playheadTime, viewStart, viewEnd, duration }) {
  const playheadPercent = duration ? (playheadTime - viewStart * duration) / ((viewEnd - viewStart) * duration) : 0;
  const playheadX = playheadPercent >= 0 && playheadPercent <= 1 ? playheadPercent * 100 : null;

  if (playheadX === null) return null;

  return (
    <div style={{ position: 'absolute', top: 0, bottom: 0, left: 0, right: 0, pointerEvents: 'none', zIndex: 10 }}>
      <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${playheadX}%`, width: '2px', backgroundColor: '#FFFFFF', boxShadow: '0 0 8px #00F5FF, 0 0 15px #00F5FF', transition: 'none' }} />
    </div>
  );
});