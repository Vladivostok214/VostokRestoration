# PROD-002: Hybrid Detector UX Integration (Propuesta UX)

Esta es la propuesta de diseño para integrar las capacidades del Hybrid Click Detector en la interfaz, sin alterar la infraestructura DSP subyacente.

## 1. Control Bar (Settings Globales)

Actualmente tenemos un control numérico/slider para `SENSITIVITY`. 

**Toggle de Modo:**
Se añadirá un interruptor minimalista (estilo Noir-Tech) al lado de los filtros activos:
- `[ ] LEGACY` (Gris, opacidad 0.5)
- `[X] HYBRID` (Glow Vostok Green `#39FF14`)

**Comportamiento Dinámico del Slider:**
Dependiendo del modo seleccionado, el slider de `SENSITIVITY` adaptará su rango dinámicamente:
- **Modo Legacy**: Mantiene su comportamiento actual (basado en thresholds de amplitud/bandwidth).
- **Modo Hybrid**: El slider muta a `Spectral Sensitivity`, ajustando automáticamente sus límites a `[min: 0.05, max: 0.20, step: 0.01]` con un valor por defecto de `0.12`. Un tooltip indicará "Menor valor = Mayor sensibilidad".

## 2. Telemetría y Confianza (GlitchPanel.jsx)

Se añadirá la exposición del `Confidence Score` en el panel lateral de eventos:
- **Nueva Columna**: Se integrará la columna `CONF` (Confidence) junto a `ΔV`.
- **Representación Visual**: 
  - En lugar de números crudos, se usará un porcentaje (`85%`) acompañado de un micro-indicador visual (ej. una barra horizontal minúscula o puntos de intensidad).
  - Se habilitará la opción de ordenar la tabla por confianza, permitiendo al usuario revisar primero los eventos "dudosos".

## 3. Overlay System (Espectrograma y Forma de Onda)

Actualmente los eventos se dibujan sobre el WebGL y el Canvas. Evolucionaremos este overlay para que comunique la incertidumbre del detector:

- **Alta Confianza (> 80%)**: 
  - Marcador sólido en Vostok Green (`#39FF14`).
  - Línea vertical continua y clara.
- **Confianza Media (50% - 79%)**: 
  - Marcador punteado (dashed) o con opacidad al 50%.
- **Baja Confianza (< 50%)**: 
  - Marcador punteado espaciado (dotted) en un tono Cyan o Ámbar, indicando que el algoritmo detectó una discontinuidad LPC pero el HFER fue marginal. Invita a revisión manual.
- **Micro-Tooltips**: Al pasar el ratón (hover) sobre un marcador en el *TimelineScrubber* o en la visualización, un tooltip estilo glassmorphism oscuro revelará: `[CLICK] Confianza: 92% | ΔV: 0.45`

## 4. Reglas de Implementación

- **Cero Mutaciones DSP**: Toda la lógica de colores, opacidades y rangos de sliders se calculará en la capa React. No se tocará `dsp.rs`.
- **Cero Mutaciones al Analytical Spectrogram**: El pipeline WebGL seguirá renderizando la matriz sin enterarse de las confianzas; los overlays se superponen en la capa de UI.
- **Rendimiento**: Se usarán ciclos `requestAnimationFrame` o CSS puro (variables `--confidence-color`) para evitar renderizados excesivos en React al arrastrar el slider.

---
*Si apruebas esta propuesta, procederé a implementarla en los componentes React.*
