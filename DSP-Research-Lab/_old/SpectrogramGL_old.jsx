import { useEffect, useRef, useCallback, memo, useMemo } from 'react';

const FRAG_SHADER = `
  precision highp float;
  varying vec2 v_texCoord;

  uniform sampler2D u_stft;
  uniform vec2      u_resolution;
  uniform float     u_sampleRate;
  uniform float     u_viewStart;
  uniform float     u_viewEnd;
  uniform float     u_viewYStart;
  uniform float     u_viewYEnd;

  void main() {
    vec2 uv = v_texCoord;

    // Mapeo temporal (Eje X)
    float tCoord = u_viewStart + uv.x * (u_viewEnd - u_viewStart);

    // Mapeo Mel (Eje Y: 20Hz - 20kHz) con zoom vertical
    float yCoord = u_viewYStart + uv.y * (u_viewYEnd - u_viewYStart);
    float fmin = 20.0;
    float fmax = 20000.0;
    float log10Val = log(10.0);
    float melMin = 2595.0 * (log(1.0 + fmin / 700.0) / log10Val);
    float melMax = 2595.0 * (log(1.0 + fmax / 700.0) / log10Val);
    float mel = melMin + yCoord * (melMax - melMin);
    float freq = 700.0 * (pow(10.0, mel / 2595.0) - 1.0);
    float binNorm = 2.0 * freq / u_sampleRate;

    // Lectura de amplitud
    float amp = texture2D(u_stft, vec2(binNorm, tCoord)).r;

    // Curva de Gamma para resaltar detalles térmicos
    amp = clamp(pow(amp, 2.5), 0.0, 1.0);

    // Paleta Térmica "Inferno"
    vec3 color;
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

    // Grid Logarítmico sutil
    float grid = 0.0;
    if (mod(log(freq/fmin)/log(2.0), 1.0) < 0.01) grid = 0.05;

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

// CAPA DE GLITCHES AISLADA Y MEMOIZADA
const GlitchLayer = memo(function GlitchLayer({ 
  glitches, viewStart, viewEnd, duration, onGlitchClick, selectedGlitchIdx 
}) {
  if (!glitches || !duration) return null;

  return (
    <svg style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 5 }}>
      {glitches.map((glitch, idx) => {
        if (glitch.repaired) return null;
        const timePercent = glitch.time_secs / duration;
        if (timePercent < viewStart || timePercent > viewEnd) return null;

        const x = ((timePercent - viewStart) / (viewEnd - viewStart)) * 100;
        const actualIdx = glitch.originalIdx !== undefined ? glitch.originalIdx : idx;
        const isSelected = selectedGlitchIdx === actualIdx;
        
        const conf = glitch.confidence !== undefined ? glitch.confidence : 1.0;
        let baseColor = "#39FF14";
        let dashArray = "none";
        let opac = 1.0;

        if (conf < 0.5) {
          baseColor = "#FFB000"; // Amber
          dashArray = "2 4";
          opac = 0.8;
        } else if (conf < 0.8) {
          baseColor = "#39FF14";
          dashArray = "6 4";
          opac = 0.6;
        }

        if (isSelected) {
          opac = 1.0;
          baseColor = "#39FF14";
          dashArray = "none";
        }

        return (
          <g 
            key={actualIdx} 
            style={{ pointerEvents: 'auto', cursor: 'pointer', opacity: opac }} 
            onClick={(e) => { e.stopPropagation(); onGlitchClick && onGlitchClick(glitch, actualIdx); }}
          >
            <title>[{glitch.artifact_type}] Confianza: {Math.round(conf * 100)}% | ΔV: {glitch.amplitude_delta.toFixed(3)}</title>
            <line x1={`${x}%`} y1="0" x2={`${x}%`} y2="100%" stroke="transparent" strokeWidth="20" />
            <line 
              x1={`${x}%`} y1="0" x2={`${x}%`} y2="100%" 
              stroke={baseColor} 
              strokeWidth={isSelected ? "3" : "1"} 
              strokeDasharray={dashArray}
            />
            <circle cx={`${x}%`} cy="10" r="4" fill={baseColor} />
          </g>
        );
      })}
    </svg>
  );
});

const SpectrogramGL = memo(function SpectrogramGL({ 
  matrix, frames, bins, sampleRate, glitches, 
  viewStart, viewEnd, viewYStart, viewYEnd, duration, onGlitchClick, selectedGlitchIdx,
  onTimelineClick, onRenderComplete, matrixVersion
}) {
  const canvasRef = useRef(null);
  const glRef     = useRef(null);
  const texRef    = useRef(null);
  const progRef   = useRef(null);

  // VIRTUALIZACIÓN DE MARCADORES (MEM-001): 
  // Filtramos los glitches antes de enviarlos a la capa SVG para que React solo procese los visibles.
  const filteredGlitches = useMemo(() => {
    if (!glitches || !duration) return [];
    // Un pequeño margen de seguridad (1% extra) a los lados para scroll fluido
    const margin = (viewEnd - viewStart) * 0.01;
    const startBound = viewStart - margin;
    const endBound = viewEnd + margin;

    return glitches.filter(g => {
      const t = g.time_secs / duration;
      return t >= startBound && t <= endBound;
    });
  }, [glitches, viewStart, viewEnd, duration]);

  // PERF-002: Lifecycle Tracking
  useEffect(() => {
    console.log('[VOSTOK PROFILE] SPECTROGRAM_MOUNT');
    return () => {
      console.log('[VOSTOK PROFILE] SPECTROGRAM_UNMOUNT');
    };
  }, []);

  const initGL = useCallback(() => {
    const tStart = performance.now();
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

    // PERF-003: TEXTURE Lifecycle
    if (texRef.current) {
      console.log('[VOSTOK PROFILE] TEXTURE_REUSE');
    } else {
      console.log('[VOSTOK PROFILE] TEXTURE_CREATE');
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      texRef.current = tex;
    }

    gl.uSampleRate = gl.getUniformLocation(prog, 'u_sampleRate');
    gl.uViewStart  = gl.getUniformLocation(prog, 'u_viewStart');
    gl.uViewEnd    = gl.getUniformLocation(prog, 'u_viewEnd');
    gl.uViewYStart = gl.getUniformLocation(prog, 'u_viewYStart');
    gl.uViewYEnd   = gl.getUniformLocation(prog, 'u_viewYEnd');
    
    // PERF-002/003: TEXTURE_CREATE (Total init phase)
    console.log('[VOSTOK PROFILE] TEXTURE_INIT_PHASE | ELAPSED:', (performance.now() - tStart).toFixed(3), 'ms');
  }, []);

  const draw = useCallback(() => {
    const gl = glRef.current;
    if (!gl) return;
    gl.uniform1f(gl.uSampleRate, sampleRate || 48000);
    gl.uniform1f(gl.uViewStart, viewStart);
    gl.uniform1f(gl.uViewEnd, viewEnd);
    gl.uniform1f(gl.uViewYStart, viewYStart);
    gl.uniform1f(gl.uViewYEnd, viewYEnd);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [sampleRate, viewStart, viewEnd, viewYStart, viewYEnd]);

  // Upload texture only when matrix version or dimensions change
  useEffect(() => {
    if (!matrix || !glRef.current || !texRef.current) return;
    
    // GUARDA DE CONSISTENCIA: Silenciosa. Simplemente espera a que los datos coincidan.
    if (matrix.length !== frames * bins || frames === 0 || bins === 0) {
      return;
    }

    const tStart = performance.now();
    const gl = glRef.current;
    gl.bindTexture(gl.TEXTURE_2D, texRef.current);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    
    // ZERO-COPY: Pasamos el Uint8Array directamente sin re-alocación
    // PERF-002: TEXTURE_UPLOAD (texImage2D)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, bins, frames, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, matrix);
    draw();

    const tEnd = performance.now();
    console.log('[VOSTOK PROFILE] TEXTURE_UPLOAD | ELAPSED:', (tEnd - tStart).toFixed(3), 'ms | TYPE: texImage2D');

    // Notificar al padre que el renderizado de la textura ha terminado
    if (onRenderComplete) {
      requestAnimationFrame(() => {
        onRenderComplete();
        // PERF-002: RENDER_COMPLETE
        console.log('[VOSTOK PROFILE] RENDER_COMPLETE | ELAPSED:', (performance.now() - tEnd).toFixed(3), 'ms (post-upload)');
      });
    }
  }, [matrix, matrixVersion, frames, bins, onRenderComplete, draw]);

  // Redraw when view start, end, or sample rate changes
  useEffect(() => {
    draw();
  }, [draw]);

  const drawRef = useRef();
  drawRef.current = draw;

  // Handle initialization and resize listeners (stable hook)
  useEffect(() => {
    initGL();
    const resize = () => {
      const tStart = performance.now();
      const c = canvasRef.current;
      if (!c) return;
      c.width = c.offsetWidth * window.devicePixelRatio;
      c.height = c.offsetHeight * window.devicePixelRatio;
      if (glRef.current) {
        glRef.current.viewport(0, 0, c.width, c.height);
      }
      if (drawRef.current) {
        drawRef.current();
      }
      // PERF-002: CANVAS_RESIZE
      console.log('[VOSTOK PROFILE] CANVAS_RESIZE | ELAPSED:', (performance.now() - tStart).toFixed(3), 'ms | WIDTH:', c.width, 'HEIGHT:', c.height);
    };
    window.addEventListener('resize', resize);
    resize();
    return () => window.removeEventListener('resize', resize);
  }, [initGL]);

  const handleRulerClick = (e) => {
    if (!duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = clickX / rect.width;
    const timeSecs = (viewStart + percent * (viewEnd - viewStart)) * duration;
    if (onTimelineClick) {
      onTimelineClick(Math.max(0.0, Math.min(duration, timeSecs)));
    }
  };

  const renderRulerTicks = () => {
    if (!duration) return null;
    const ticks = [];
    const tStart = viewStart * duration;
    const tEnd = viewEnd * duration;
    const tRange = tEnd - tStart;

    // Determinar intervalo dinámicamente basado en el zoom
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
            position: 'absolute',
            left: `${xPercent}%`,
            bottom: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            transform: 'translateX(-50%)',
            pointerEvents: 'none'
          }}>
            <span style={{ 
              fontFamily: 'JetBrains Mono, monospace', 
              fontSize: '8px', 
              color: 'rgba(255,255,255,0.4)',
              marginBottom: '2px'
            }}>
              {t.toFixed(2)}s
            </span>
            <div style={{ 
              width: '1px', 
              height: '5px', 
              backgroundColor: 'rgba(255,255,255,0.3)' 
            }} />
          </div>
        );
      }
    }
    return ticks;
  };

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#000', overflow: 'hidden' }}>
      {/* Timeline Ruler */}
      <div 
        onMouseDown={handleRulerClick}
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
      </div>

      {/* Canvas + GlitchLayer Container */}
      <div 
        onMouseDown={handleRulerClick}
        style={{ position: 'relative', flex: 1, overflow: 'hidden', cursor: 'pointer' }}
      >
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        
        {/* CAPA DE GLITCHES AISLADA Y MEMOIZADA */}
        <GlitchLayer
          glitches={filteredGlitches}
          viewStart={viewStart}
          viewEnd={viewEnd}
          duration={duration}
          onGlitchClick={onGlitchClick}
          selectedGlitchIdx={selectedGlitchIdx}
        />
      </div>

      {/* dB Scale Legend */}
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#050505',
        borderTop: '1px solid rgba(255, 255, 255, 0.08)',
        padding: '6px 24px',
        height: '32px',
        flexShrink: 0,
        userSelect: 'none'
      }}>
        <div style={{ width: '100%', maxWidth: '400px', display: 'flex', flexDirection: 'column', gap: '2px' }}>
          <div style={{
            height: '4px',
            width: '100%',
            borderRadius: '2px',
            background: 'linear-gradient(to right, rgb(0, 0, 13) 0%, rgb(0, 26, 128) 10%, rgb(153, 0, 153) 30%, rgb(255, 77, 0) 60%, rgb(255, 230, 0) 85%, rgb(255, 255, 255) 100%)'
          }} />
          <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'JetBrains Mono, monospace', fontSize: '8px', color: 'rgba(255,255,255,0.4)', fontWeight: 900 }}>
            <span>-120 dB</span>
            <span>-90 dB</span>
            <span>-60 dB</span>
            <span>-30 dB</span>
            <span>0 dB</span>
          </div>
        </div>
      </div>
    </div>
  );
})

export default SpectrogramGL;

export const PlaybackCursor = memo(function PlaybackCursor({ playheadTime, viewStart, viewEnd, duration }) {
  const playheadPercent = duration ? (playheadTime - viewStart * duration) / ((viewEnd - viewStart) * duration) : 0;
  const playheadX = playheadPercent >= 0 && playheadPercent <= 1 ? playheadPercent * 100 : null;

  if (playheadX === null) return null;

  return (
    <div style={{
      position: 'absolute',
      top: '24px', // Ruler height offset
      bottom: '32px', // Legend height offset
      left: 0,
      right: 0,
      pointerEvents: 'none',
      zIndex: 10
    }}>
      <div style={{
        position: 'absolute',
        top: 0,
        bottom: 0,
        left: `${playheadX}%`,
        width: '2px',
        backgroundColor: '#39FF14',
        boxShadow: '0 0 8px #39FF14, 0 0 15px #39FF14',
        transition: 'none'
      }} />
    </div>
  );
});