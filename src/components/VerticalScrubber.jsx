import { useState, useEffect, useRef, memo } from 'react';

/**
 * VerticalScrubber.jsx — Componente de navegación vertical interactiva (Eje Y / Frecuencia)
 * Completamente simétrico al TimelineScrubber (Horizontal) en proporciones, colores y comportamiento.
 */

// Conversión de frecuencia física (Hz) a porcentaje vertical (0.0 = top, 1.0 = bottom) según la escala seleccionada
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
  return 1.0 - yView;
};

const VerticalScrubber = memo(function VerticalScrubber({ viewStart, viewEnd, onViewportChange, scaleMode = 1 }) {
  const containerRef = useRef(null);
  const [height, setHeight] = useState(400);

  const dragRef = useRef({
    type: null, // 'pan' | 'zoom_start' | 'zoom_end'
    startY: 0,
    startViewStart: 0,
    startViewEnd: 0,
  });

  // Observar el tamaño del contenedor para prevenir colisiones precisas de texto
  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver((entries) => {
      for (let entry of entries) {
        if (entry.contentRect && entry.contentRect.height) {
          setHeight(entry.contentRect.height);
        }
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const handleMouseDown = (e, type) => {
    e.preventDefault();
    e.stopPropagation();

    dragRef.current = {
      type,
      startY: e.clientY,
      startViewStart: viewStart,
      startViewEnd: viewEnd,
    };

    const handleMouseMove = (moveEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const deltaY = moveEvent.clientY - dragRef.current.startY;
      const deltaPercent = -deltaY / rect.height;

      let nextStart = dragRef.current.startViewStart;
      let nextEnd = dragRef.current.startViewEnd;
      const zoom = dragRef.current.startViewEnd - dragRef.current.startViewStart;

      if (dragRef.current.type === 'pan') {
        nextStart = dragRef.current.startViewStart + deltaPercent;
        nextEnd = dragRef.current.startViewEnd + deltaPercent;

        if (nextStart < 0) {
          nextStart = 0;
          nextEnd = zoom;
        } else if (nextEnd > 1) {
          nextEnd = 1;
          nextStart = 1 - zoom;
        }
      } else if (dragRef.current.type === 'zoom_start') {
        nextStart = Math.max(0, Math.min(dragRef.current.startViewStart + deltaPercent, dragRef.current.startViewEnd - 0.01));
      } else if (dragRef.current.type === 'zoom_end') {
        nextEnd = Math.max(dragRef.current.startViewStart + 0.01, Math.min(dragRef.current.startViewEnd + deltaPercent, 1.0));
      }

      onViewportChange(nextStart, nextEnd);
    };

    const handleMouseUp = () => {
      dragRef.current.type = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const bottomPercent = viewStart * 100;
  const heightPercent = (viewEnd - viewStart) * 100;

  const formatFreq = (f) => {
    if (f >= 1000) return `${(f / 1000).toFixed(0)}k`;
    return `${f}`;
  };

  const referenceFreqs = [20, 60, 100, 250, 500, 1000, 2000, 4000, 6000, 10000, 16000, 20000];

  const labelsToRender = [];
  const sortedFreqs = [...referenceFreqs].sort((a, b) => b - a);
  let lastYPixels = -100;

  for (const freq of sortedFreqs) {
    const pctY = getPercentYFromFreq(freq, 0.0, 1.0, scaleMode);
    const yPixels = pctY * height;

    if (yPixels - lastYPixels >= 14) {
      labelsToRender.push({ freq, pctY });
      lastYPixels = yPixels;
    }
  }

  return (
    <div
      ref={containerRef}
      onDoubleClick={() => onViewportChange(0, 1)}
      style={{
        width: '28px', height: '100%',
        backgroundColor: 'rgba(6, 9, 12, 0.75)',
        backdropFilter: 'var(--blur-glass)',
        WebkitBackdropFilter: 'var(--blur-glass)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '6px', position: 'relative',
        overflow: 'hidden', userSelect: 'none', boxSizing: 'border-box',
        boxShadow: 'inset 0 0 10px rgba(0, 0, 0, 0.5)'
      }}
    >
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'linear-gradient(0deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
        backgroundSize: '100% 10%', pointerEvents: 'none', zIndex: 1
      }} />

      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 2 }}>
        {labelsToRender.map(({ freq, pctY }) => {
          const topPercent = pctY * 100;
          return (
            <div 
              key={freq} 
              style={{ 
                position: 'absolute', 
                top: `${topPercent}%`, 
                left: '2px', 
                right: '4px', 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center', 
                transform: 'translateY(-50%)',
                transition: 'top 0.2s ease-out'
              }}
            >
              <div style={{ width: '4px', height: '1px', backgroundColor: 'rgba(255,255,255,0.3)' }} />
              <span style={{ fontSize: '7.5px', color: 'rgba(255,255,255,0.45)', fontFamily: 'JetBrains Mono, monospace', fontWeight: 500 }}>
                {formatFreq(freq)}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{
        position: 'absolute', top: 0, left: 0, width: '100%',
        height: `${100 - bottomPercent - heightPercent}%`,
        backgroundColor: 'rgba(0, 0, 0, 0.55)', pointerEvents: 'none', zIndex: 3
      }} />
      <div style={{
        position: 'absolute', bottom: 0, left: 0, width: '100%',
        height: `${bottomPercent}%`,
        backgroundColor: 'rgba(0, 0, 0, 0.55)', pointerEvents: 'none', zIndex: 3
      }} />

      <div
        onMouseDown={(e) => handleMouseDown(e, 'pan')}
        style={{
          position: 'absolute', bottom: `${bottomPercent}%`, height: `${heightPercent}%`, width: '100%',
          backgroundColor: 'rgba(0, 245, 255, 0.03)',
          borderTop: '2px solid var(--vostok-cyan)', borderBottom: '2px solid var(--vostok-cyan)',
          cursor: 'grab', boxSizing: 'border-box',
          boxShadow: '0 0 10px rgba(0, 245, 255, 0.25), inset 0 0 12px rgba(0, 245, 255, 0.08)',
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          zIndex: 4
        }}
      >
        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_end')}
          style={{
            height: '8px', width: '100%', cursor: 'row-resize',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0, 245, 255, 0.08)', borderBottom: '1px solid rgba(0, 245, 255, 0.25)'
          }}
          title="Zoom Agudos (Arrastrar)"
        >
          <div style={{ height: '1.5px', width: '10px', backgroundColor: 'var(--vostok-cyan)', opacity: 0.8 }} />
        </div>

        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_start')}
          style={{
            height: '8px', width: '100%', cursor: 'row-resize',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(0, 245, 255, 0.08)', borderTop: '1px solid rgba(0, 245, 255, 0.25)'
          }}
          title="Zoom Graves (Arrastrar)"
        >
          <div style={{ height: '1.5px', width: '10px', backgroundColor: 'var(--vostok-cyan)', opacity: 0.8 }} />
        </div>
      </div>
    </div>
  );
});

export default VerticalScrubber;