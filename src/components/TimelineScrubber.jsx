import { useEffect, useRef, memo } from 'react';

/**
 * TimelineScrubber.jsx — Componente de navegación interactiva estilo DAW
 * Optimizado con React.memo para evitar recálculos masivos de reconciliación DOM.
 */
const TimelineScrubber = memo(function TimelineScrubber({ 
  viewStart, viewEnd, onViewportChange, onSeek, playheadTime = 0, duration = 0, envelope = [] 
}) {
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const dragRef = useRef({
    type: null, // 'pan' | 'zoom_start' | 'zoom_end'
    startX: 0,
    startViewStart: 0,
    startViewEnd: 0,
  });

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

    // 1. Relleno con degradado vertical holográfico HSL (acento Vostok Green)
    ctx.beginPath();
    ctx.moveTo(0, centerY);

    for (let i = 0; i < points; i++) {
      const val = envelope[i] * (centerY - 2); // Dejar un pequeño margen para el outline
      ctx.lineTo(i * step, centerY - val);
    }
    
    for (let i = points - 1; i >= 0; i--) {
      const val = envelope[i] * (centerY - 2);
      ctx.lineTo(i * step, centerY + val);
    }

    ctx.closePath();

    const grad = ctx.createLinearGradient(0, 0, 0, height);
    grad.addColorStop(0, 'rgba(57, 255, 20, 0.16)');
    grad.addColorStop(0.5, 'rgba(57, 255, 20, 0.01)');
    grad.addColorStop(1, 'rgba(57, 255, 20, 0.16)');
    ctx.fillStyle = grad;
    ctx.fill();

    // 2. Contorno superior con glow sutil
    ctx.shadowColor = 'rgba(57, 255, 20, 0.6)';
    ctx.shadowBlur = 3;
    ctx.strokeStyle = '#39FF14';
    ctx.lineWidth = 1.0;

    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const val = envelope[i] * (centerY - 2);
      if (i === 0) ctx.moveTo(0, centerY - val);
      else ctx.lineTo(i * step, centerY - val);
    }
    ctx.stroke();

    // 3. Contorno inferior con glow sutil
    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const val = envelope[i] * (centerY - 2);
      if (i === 0) ctx.moveTo(0, centerY + val);
      else ctx.lineTo(i * step, centerY + val);
    }
    ctx.stroke();

    // Limpiar sombras para que no afecten a otros dibujos de canvas
    ctx.shadowBlur = 0;
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
        
        const nextRange = Math.max(0.005, (anchorTime - nextStart) / playheadRel);
        nextEnd = Math.max(nextStart + 0.01, Math.min(nextStart + nextRange, 1.0));
        
        if (nextEnd === 1.0) {
          nextStart = Math.max(0.0, 1.0 - nextRange);
        }
      } else if (dragRef.current.type === 'zoom_end') {
        const rawEnd = dragRef.current.startViewEnd + deltaPercent;
        nextEnd = Math.max(dragRef.current.startViewStart + 0.01, Math.min(rawEnd, 1.0));
        
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
  
  const handleClick = (e) => {
    // Si el clic se originó en los manejadores de drag/zoom, no hacemos nada.
    // El stopPropagation en onMouseDown debería prevenir esto, pero es una doble seguridad.
    if (e.defaultPrevented) {
      return;
    }

    if (!containerRef.current || !onSeek) return;
    
    const rect = containerRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, clickX / rect.width));
    
    onSeek(percent);
  };

  const leftPercent = viewStart * 100;
  const widthPercent = (viewEnd - viewStart) * 100;

  return (
    <div
      ref={containerRef}
      onClick={handleClick}
      onDoubleClick={() => onViewportChange(0, 1)}
      style={{
        width: '100%', height: '24px',
        backgroundColor: 'rgba(6, 9, 12, 0.75)',
        backdropFilter: 'var(--blur-glass)',
        WebkitBackdropFilter: 'var(--blur-glass)',
        border: '1px solid rgba(255, 255, 255, 0.08)',
        borderRadius: '6px', position: 'relative', overflow: 'hidden',
        userSelect: 'none', boxSizing: 'border-box',
        cursor: 'pointer',
        boxShadow: 'inset 0 0 10px rgba(0, 0, 0, 0.5)'
      }}
    >
      <div style={{
        position: 'absolute', inset: 0,
        backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px)',
        backgroundSize: '10% 100%', pointerEvents: 'none', zIndex: 1
      }} />

      <canvas 
        ref={canvasRef} width={1000} height={24}
        style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 2 }}
      />

      <div style={{ position: 'absolute', top: 0, left: 0, width: `${leftPercent}%`, height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.55)', pointerEvents: 'none', zIndex: 3 }} />
      <div style={{ position: 'absolute', top: 0, right: 0, width: `${100 - leftPercent - widthPercent}%`, height: '100%', backgroundColor: 'rgba(0, 0, 0, 0.55)', pointerEvents: 'none', zIndex: 3 }} />

      {/* Aguja del Playhead en el Scrubber Horizontal */}
      {duration > 0 && (
        <div style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: `${(playheadTime / duration) * 100}%`,
          width: '1.5px',
          backgroundColor: '#FFFFFF',
          boxShadow: '0 0 6px rgba(0, 245, 255, 0.8)',
          pointerEvents: 'none',
          zIndex: 5
        }} />
      )}

      <div
        onMouseDown={(e) => handleMouseDown(e, 'pan')}
        style={{
          position: 'absolute', left: `${leftPercent}%`, width: `${widthPercent}%`, height: '100%',
          backgroundColor: 'rgba(82, 255, 60, 0.03)',
          borderLeft: '2px solid var(--vostok-green)', borderRight: '2px solid var(--vostok-green)',
          cursor: 'grab', boxSizing: 'border-box',
          boxShadow: '0 0 10px rgba(82, 255, 60, 0.25), inset 0 0 12px rgba(82, 255, 60, 0.08)',
          display: 'flex', justifyContent: 'space-between', zIndex: 4
        }}
      >
        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_start')}
          style={{
            width: '8px', height: '100%', cursor: 'col-resize',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(82, 255, 60, 0.08)', borderRight: '1px solid rgba(82, 255, 60, 0.25)'
          }}
          title="Zoom Inicio (Arrastrar)"
        >
          <div style={{ width: '1.5px', height: '10px', backgroundColor: 'var(--vostok-green)', opacity: 0.8 }} />
        </div>

        <div
          onMouseDown={(e) => handleMouseDown(e, 'zoom_end')}
          style={{
            width: '8px', height: '100%', cursor: 'col-resize',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            backgroundColor: 'rgba(82, 255, 60, 0.08)', borderLeft: '1px solid rgba(82, 255, 60, 0.25)'
          }}
          title="Zoom Fin (Arrastrar)"
        >
          <div style={{ width: '1.5px', height: '10px', backgroundColor: 'var(--vostok-green)', opacity: 0.8 }} />
        </div>
      </div>
    </div>
  );
});

export default TimelineScrubber;