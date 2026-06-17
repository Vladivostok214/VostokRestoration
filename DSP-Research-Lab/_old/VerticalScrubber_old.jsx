import { useRef } from 'react';

/**
 * VerticalScrubber.jsx — Componente de navegación vertical interactiva (Eje Y / Frecuencia)
 *
 * Permite desplazar la ventana de frecuencias (Pan Y) arrastrando la zona central
 * y ajustar el zoom vertical arrastrando los extremos superior e inferior.
 */
export default function VerticalScrubber({ viewStart, viewEnd, onViewportChange }) {
  const containerRef = useRef(null);
  const dragRef = useRef({
    type: null, // 'pan' | 'zoom_start' | 'zoom_end'
    startY: 0,
    startViewStart: 0,
    startViewEnd: 0,
  });

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
      // En pantalla Y va hacia abajo, en el espectrograma Y va hacia arriba (frecuencia)
      const deltaY = moveEvent.clientY - dragRef.current.startY;
      const deltaPercent = -deltaY / rect.height;

      let nextStart = dragRef.current.startViewStart;
      let nextEnd = dragRef.current.startViewEnd;
      const zoom = dragRef.current.startViewEnd - dragRef.current.startViewStart;

      if (dragRef.current.type === 'pan') {
        nextStart = dragRef.current.startViewStart + deltaPercent;
        nextEnd = dragRef.current.startViewEnd + deltaPercent;

        // Mantener dentro del rango de frecuencias [0, 1]
        if (nextStart < 0) {
          nextStart = 0;
          nextEnd = zoom;
        } else if (nextEnd > 1) {
          nextEnd = 1;
          nextStart = 1 - zoom;
        }
      } else if (dragRef.current.type === 'zoom_start') {
        // zoom_start es el borde inferior (frecuencias bajas)
        nextStart = Math.max(0, Math.min(dragRef.current.startViewStart + deltaPercent, dragRef.current.startViewEnd - 0.01));
      } else if (dragRef.current.type === 'zoom_end') {
        // zoom_end es el borde superior (frecuencias altas)
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

  // Posicionamiento vertical: Y=0 en el fondo (graves), Y=1 en el tope (agudos)
  const bottomPercent = viewStart * 100;
  const heightPercent = (viewEnd - viewStart) * 100;

  return (
    <div
      ref={containerRef}
      style={{
        width: '24px',
        height: '100%',
        backgroundColor: '#050505',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '4px',
        position: 'relative',
        overflow: 'hidden',
        userSelect: 'none',
        boxSizing: 'border-box'
      }}
    >
      {/* Grid sutil de fondo vertical */}
      <div style={{
        position: 'absolute',
        inset: 0,
        backgroundImage: 'linear-gradient(0deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: '100% 10%',
        pointerEvents: 'none'
      }} />

      {/* Zona activa del Viewport (Manija de PAN Y) */}
      <div
        onMouseDown={(e) => handleMouseDown(e, 'pan')}
        style={{
          position: 'absolute',
          bottom: `${bottomPercent}%`,
          height: `${heightPercent}%`,
          width: '100%',
          backgroundColor: 'rgba(57, 255, 20, 0.20)',
          borderTop: '2px solid #39FF14',
          borderBottom: '2px solid #39FF14',
          cursor: 'grab',
          boxSizing: 'border-box',
          boxShadow: 'inset 0 0 8px rgba(57, 255, 20, 0.15)',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between'
        }}
      >
        {/* Handle de Zoom Superior (Altas frecuencias) */}
        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_end')}
          style={{
            height: '6px',
            width: '100%',
            cursor: 'row-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(57, 255, 20, 0.1)',
            borderBottom: '1px solid rgba(57, 255, 20, 0.3)'
          }}
          title="Zoom Agudos (Arrastrar)"
        >
          <div style={{ height: '1px', width: '10px', backgroundColor: '#39FF14', opacity: 0.6 }} />
        </div>

        {/* Handle de Zoom Inferior (Bajas frecuencias) */}
        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_start')}
          style={{
            height: '6px',
            width: '100%',
            cursor: 'row-resize',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(57, 255, 20, 0.1)',
            borderTop: '1px solid rgba(57, 255, 20, 0.3)'
          }}
          title="Zoom Graves (Arrastrar)"
        >
          <div style={{ height: '1px', width: '10px', backgroundColor: '#39FF14', opacity: 0.6 }} />
        </div>
      </div>
    </div>
  );
}
