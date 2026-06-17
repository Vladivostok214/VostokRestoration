import { useEffect, useRef } from 'react';

/**
 * TimelineScrubber.jsx — Componente de navegación interactiva estilo DAW
 *
 * Permite desplazar la ventana temporal (Pan) arrastrando la zona central
 * y ajustar el rango dinámicamente (Zoom) arrastrando los extremos laterales.
 */
export default function TimelineScrubber({ viewStart, viewEnd, onViewportChange, playheadTime = 0, duration = 0, envelope = [] }) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef({
    type: null, // 'pan' | 'zoom_start' | 'zoom_end'
    startX: 0,
    startViewStart: 0,
    startViewEnd: 0,
  });

  // Renderizar la envolvente de forma de onda
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !envelope || envelope.length === 0) return;

    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;

    ctx.clearRect(0, 0, width, height);

    const points = envelope.length;
    const step = width / points;
    const centerY = height / 2;

    ctx.beginPath();
    ctx.moveTo(0, centerY);

    // Dibujar mitad superior
    for (let i = 0; i < points; i++) {
      const val = envelope[i] * centerY;
      ctx.lineTo(i * step, centerY - val);
    }
    
    // Dibujar mitad inferior
    for (let i = points - 1; i >= 0; i--) {
      const val = envelope[i] * centerY;
      ctx.lineTo(i * step, centerY + val);
    }

    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.fill();
  }, [envelope]);

  const handleMouseDown = (e, type) => {
    e.preventDefault();
    e.stopPropagation();

    dragRef.current = {
      type,
      startX: e.clientX,
      startViewStart: viewStart,
      startViewEnd: viewEnd,
    };

    const playheadPercent = duration > 0 ? (playheadTime / duration) : 0.0;
    const currentRange = dragRef.current.startViewEnd - dragRef.current.startViewStart;

    // Si el playhead está fuera del viewport visible, pivotamos sobre el centro del viewport
    const isPlayheadVisible = playheadPercent >= dragRef.current.startViewStart && playheadPercent <= dragRef.current.startViewEnd;
    const anchorTime = isPlayheadVisible 
      ? playheadPercent 
      : (dragRef.current.startViewStart + dragRef.current.startViewEnd) / 2;

    const playheadRel = currentRange > 0.0
      ? Math.max(0.05, Math.min(0.95, (anchorTime - dragRef.current.startViewStart) / currentRange))
      : 0.5;

    const handleMouseMove = (moveEvent) => {
      const container = containerRef.current;
      if (!container) return;

      const rect = container.getBoundingClientRect();
      const deltaX = moveEvent.clientX - dragRef.current.startX;
      const deltaPercent = deltaX / rect.width;

      let nextStart = dragRef.current.startViewStart;
      let nextEnd = dragRef.current.startViewEnd;
      const zoom = dragRef.current.startViewEnd - dragRef.current.startViewStart;

      if (dragRef.current.type === 'pan') {
        nextStart = dragRef.current.startViewStart + deltaPercent;
        nextEnd = dragRef.current.startViewEnd + deltaPercent;

        // Mantener dentro del rango de audio [0, 1]
        if (nextStart < 0) {
          nextStart = 0;
          nextEnd = zoom;
        } else if (nextEnd > 1) {
          nextEnd = 1;
          nextStart = 1 - zoom;
        }
      } else if (dragRef.current.type === 'zoom_start') {
        const rawStart = dragRef.current.startViewStart + deltaPercent;
        nextStart = Math.max(0.0, Math.min(rawStart, dragRef.current.startViewEnd - 0.01));
        
        // Mantener anclado el punto de reproducción
        const nextRange = Math.max(0.005, (anchorTime - nextStart) / playheadRel);
        nextEnd = Math.max(nextStart + 0.01, Math.min(nextStart + nextRange, 1.0));
        
        if (nextEnd === 1.0) {
          nextStart = Math.max(0.0, 1.0 - nextRange);
        }
      } else if (dragRef.current.type === 'zoom_end') {
        const rawEnd = dragRef.current.startViewEnd + deltaPercent;
        nextEnd = Math.max(dragRef.current.startViewStart + 0.01, Math.min(rawEnd, 1.0));
        
        // Mantener anclado el punto de reproducción
        const nextRange = Math.max(0.005, (nextEnd - anchorTime) / (1.0 - playheadRel));
        nextStart = Math.max(0.0, Math.min(nextEnd - nextRange, nextEnd - 0.01));
        
        if (nextStart === 0.0) {
          nextEnd = Math.min(1.0, nextRange);
        }
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

  // Porcentaje de inicio y ancho de la ventana
  const leftPercent = viewStart * 100;
  const widthPercent = (viewEnd - viewStart) * 100;

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '24px',
        backgroundColor: '#050505',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '4px',
        position: 'relative',
        overflow: 'hidden',
        userSelect: 'none',
        boxSizing: 'border-box'
      }}
    >
      {/* Grid sutil de fondo de la línea de tiempo */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: '10% 100%',
        pointerEvents: 'none',
        zIndex: 1
      }} />

      {/* Canvas de forma de onda (Global Navigator) */}
      <canvas 
        ref={canvasRef}
        width={1000}
        height={24}
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          zIndex: 2
        }}
      />

      {/* Capa de oscurecimiento para áreas fuera del viewport */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: `${leftPercent}%`,
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        pointerEvents: 'none',
        zIndex: 3
      }} />
      <div style={{
        position: 'absolute',
        top: 0,
        right: 0,
        width: `${100 - leftPercent - widthPercent}%`,
        height: '100%',
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        pointerEvents: 'none',
        zIndex: 3
      }} />

      {/* Zona activa del Viewport (Manija de PAN) */}
      <div
        onMouseDown={(e) => handleMouseDown(e, 'pan')}
        style={{
          position: 'absolute',
          left: `${leftPercent}%`,
          width: `${widthPercent}%`,
          height: '100%',
          backgroundColor: 'transparent',
          borderLeft: '2px solid #39FF14',
          borderRight: '2px solid #39FF14',
          cursor: 'grab',
          boxSizing: 'border-box',
          boxShadow: 'inset 0 0 8px rgba(57, 255, 20, 0.15)',
          display: 'flex',
          justifyContent: 'space-between',
          zIndex: 4
        }}
      >
        {/* Handle de Zoom Izquierdo */}
        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_start')}
          style={{
            width: '6px',
            height: '100%',
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(57, 255, 20, 0.1)',
            borderRight: '1px solid rgba(57, 255, 20, 0.3)'
          }}
          title="Zoom Inicio (Arrastrar)"
        >
          <div style={{ width: '1px', height: '10px', backgroundColor: '#39FF14', opacity: 0.6 }} />
        </div>

        {/* Handle de Zoom Derecho */}
        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_end')}
          style={{
            width: '6px',
            height: '100%',
            cursor: 'col-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(57, 255, 20, 0.1)',
            borderLeft: '1px solid rgba(57, 255, 20, 0.3)'
          }}
          title="Zoom Fin (Arrastrar)"
        >
          <div style={{ width: '1px', height: '10px', backgroundColor: '#39FF14', opacity: 0.6 }} />
        </div>
      </div>
    </div>
  );
}
