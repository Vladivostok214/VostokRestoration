# Contexto Técnico de Optimizaciones UI/UX
**Proyecto:** Vostok Restoration V1 (Tauri + React + Rust DSP)  
**Fecha:** 22 de Junio, 2026  
**Objetivo:** Consolidación estética y funcional del lenguaje visual *Noir-Tech* (Glassmorphism, minimalismo de alta legibilidad, alineaciones de precisión y optimización de flujos de interacción).

---

## 1. Alineación Horaria del Botón de Ajustes Espectrales
* **Archivo afectado:** `src/components/SpectrogramGL.jsx` (Líneas ~1386-1430)
* **Problema previo:** El botón de configuración visual del espectrograma (`SettingsIcon`) y su panel flotante de ajustes asociados (`showSettings`) estaban contenidos dentro del área de renderizado relativo del Canvas. Esto introducía un desfase en el sistema de coordenadas verticales (offset de `24px` provocado por la altura fija de la regla de tiempo o *timeline ruler*), rompiendo la baseline horizontal respecto al botón de maximización/pantalla completa.
* **Solución técnica:**
  1. Se extrajeron el botón `<button>` y el contenedor condicional `{showSettings && (...)}` fuera de la jerarquía del Canvas de renderizado.
  2. Se reubicaron como hijos directos del contenedor raíz del componente `SpectrogramGL` (con posicionamiento `relative`).
  3. Se parametrizó un posicionamiento absoluto idéntico en el eje vertical: `top: '10px'`.
  4. Se estableció un desfase horizontal relativo al extremo derecho: el botón se posiciona en `right: '46px'` (mientras que el botón de maximizar ocupa `right: '10px'`), garantizando una separación horizontal constante de `8px` entre ambos botones de control (asumiendo un ancho de botón de `28px`).
  5. Se implementaron manejadores de eventos explícitos `onMouseDown={(e) => e.stopPropagation()}` y `onMouseUp={(e) => e.stopPropagation()}` en el botón de ajustes para evitar que la interacción del usuario interfiera con el arrastre o selección de regiones de audio en el canvas del espectrograma subyacente.

---

## 2. Rediseño del Botón "ESCANEAR LOOP"
* **Archivo afectado:** `src/components/SpectrogramGL.jsx` (Línea ~1085)
* **Problema previo:** El botón translúcido permitía la superposición visual de las marcas de graduación de tiempo (*timeline ticks*) situadas debajo de él, generando un artefacto visual desprolijo y disminuyendo el contraste del texto. Adicionalmente, contenía un emoji de rayo (`⚡`) que discrepaba de la sobriedad del sistema Noir-Tech.
* **Solución técnica:**
  1. **Remoción de elemento JSX:** Se eliminó el emoji `⚡` de los elementos hijos del botón para conservar únicamente la cadena de texto literal `"ESCANEAR LOOP"` en mayúsculas sostenidas, alineada con las convenciones tipográficas del sistema.
  2. **Enmascaramiento de Ticks:** Se sustituyó el fondo translúcido por un color de fondo sólido y opaco matching con la paleta base del espectrograma: `#070c08`. Esto actúa como una máscara de recorte visual que oculta cualquier elemento vectorial o línea de regla de tiempo renderizada en capas inferiores (`z-index`).
  3. **Estilos y Hover:** Se preservó una transición suave de opacidad y borde con brillo de fósforo verde (`var(--vostok-green)`) en estado `:hover` para retener la interactividad táctil sin añadir ruido visual.

---

## 3. Popover de Sensibilidad Avanzada (`showAdvanced`)
* **Archivo afectado:** `src/components/VostokRestoration.jsx` (Líneas ~1235-1320)
* **Problema previo:** El panel flotante que aloja el slider de sensibilidad y el selector de dominio espectral carecía de la sofisticación visual de la interfaz bento-grid principal y no presentaba una relación visual directa con el botón disparador.
* **Solución técnica:**
  1. **Efecto Vidrio Premium (Glassmorphism):** Se implementó una base de color `rgba(6, 9, 12, 0.96)` combinada con un filtro de desenfoque de fondo dinámico de `backdrop-filter: var(--blur-glass)` (equivalente a `blur(12px)`).
  2. **Indicador de Anclaje Geométrico:** Se añadió un nodo `div` absoluto con rotación simulando una flecha física (`transform: 'rotate(45deg)'`, `width: '8px'`, `height: '8px'`) posicionada matemáticamente en `right: '-5px'` y `top: '17px'` para coincidir de forma simétrica con el centro del icono de engranaje (`Settings`).
  3. **Bordes Reactivos de Alerta:** El contorno del popover y su indicador cambian de color dinámicamente según el estado del DSP:
     * Si el modo es voz y la sensibilidad es superior al 75%, el borde se renderiza en cian fosforescente (`1px solid rgba(0, 245, 255, 0.25)`) con un brillo exterior difuso (`box-shadow: 0 0 15px rgba(0, 245, 255, 0.12)`).
     * En caso contrario, utiliza la firma verde de Vostok (`rgba(82, 255, 60, 0.25)` y `rgba(82, 255, 60, 0.12)`).
  4. **Tipografía y Subopciones:** Se aplicó la fuente de sistema de ancho fijo `var(--font-mono)` (JetBrains Mono) en etiquetas y valores. Los botones de modo ("MÚSICA", "VOZ") fueron rediseñados con micro-animaciones en hover que modifican el borde a `rgba(82, 255, 60, 0.4)` y el fondo a `rgba(82, 255, 60, 0.05)` mediante transiciones CSS de `0.15s`.

---

## 4. Refactorización de Cabeceras Bento y Flat-Panel Sidebar (Detector e Inspector)
* **Archivo afectado:** `src/components/VostokRestoration.jsx` (Líneas ~62-65, ~1188-1215, ~1423-1449)
* **Problema previo:** Los paneles del lateral derecho ("Detector de Impulsos" e "Inspector Quirúrgico") se mostraban contenidos en tarjetas flotantes independientes (`glass-panel glass-panel--interactive`), lo que creaba una sobrecarga visual de bordes, capas translúcidas acumuladas y sombras que restaban espacio útil y rompían la fluidez de un diseño integrado de panel único (estética plana moderna). Al colapsar los paneles, la acumulación de tarjetas competía estéticamente con el espectrograma.
* **Solución técnica:**
  1. **Aplanado Completo de Contenedores:** Se eliminó la clase CSS `glass-panel glass-panel--interactive` de los contenedores exteriores de ambos paneles. Ahora flotan de manera limpia, transparente, sin fondos acumulativos, bordes laterales/inferiores o sombras externas flotantes.
  2. **Estructura de Barra de Título en Cabeceras:** Se aislaron y enmarcaron únicamente los encabezados interactivos de los títulos:
     * **Detector de Impulsos:** Se añadió una línea de borde superior sólida de color verde (`1px solid var(--vostok-border-g)`) y una línea de borde inferior sutil (`1px solid rgba(255, 255, 255, 0.08)`) para formar una barra de título limpia y horizontal.
     * **Inspector Quirúrgico:** Se añadió una línea de borde superior sólida de color cian (`1px solid var(--vostok-border-c)`) y una línea de borde inferior sutil (`1px solid rgba(255, 255, 255, 0.08)`).
---

## 5. Micro-Optimización Estética Premium (Luz LED, Rotación y Transparencia)
* **Archivos afectados:** `src/index.css` (Líneas ~964-980) | `src/components/SpectrogramGL.jsx` (Líneas ~1058-1065) | `src/components/VostokRestoration.jsx` (Líneas ~1245-1251, ~1465-1478)
* **Problemas previos:** 
  1. La regla de tiempo (*timeline ruler*) del espectrograma tenía una franja gris translúcida fija (`#0a0a0a`) que cortaba la fluidez infinita del espectrograma en los extremos.
  2. El engranaje de configuración avanzada no reaccionaba al hover ni daba indicios dinámicos de su estado de apertura.
  3. Las tarjetas de telemetría eran estáticas, careciendo del dinamismo táctil de los componentes de hardware analógicos de laboratorio.
* **Soluciones técnicas:**
  1. **Transparencia del Timeline:** Se cambió el color de fondo de la regla de tiempo en `SpectrogramGL.jsx` a `transparent`. Las marcas numéricas y líneas flotan directamente sobre el fondo del lienzo, logrando una integración visual fluida y sin interrupciones.
  2. **Micro-animación y Hover del Engranaje:**
     * Se agregaron escuchas `onMouseEnter` y `onMouseLeave` al botón de engranaje de Ajustes Avanzados para cambiar su opacidad a verde brillante (`var(--vostok-green)`) de forma suave.
     * Se implementó una animación reactiva al estado: cuando el menú avanzado está abierto, el icono del engranaje rota suavemente 45 grados (`transform: 'rotate(45deg)'`) con una transición de `0.3s ease`.
  3. **Leds Pulsantes Activos en Telemetría:**
     * Se declaró un set de fotogramas clave `@keyframes led-pulse` en `index.css` que simula la oscilación orgánica de un diodo LED real (`opacity` del `35%` al `100%`, `scale` del `0.9` al `1.1` y un resplandor `box-shadow` difuso).
     * Se crearon elementos `<span className="vostok-led">` dentro de las tarjetas de `"DETECTADOS"` (verde fósforo) y `"PENDIENTES"` (cian dinámico reactivo al conteo). Estos LEDs parpadean constantemente simulando un monitoreo activo por DSP del motor de audio en segundo plano.

---

## 6. Alineación de Precisión de Controles de Transporte y Telemetría
* **Archivo afectado:** `src/index.css` (Líneas ~294-305, clase `.transport-container`)
* **Problema previo:** Mientras que la regla de tiempo y la línea de tiempo (`TimelineScrubber`) estaban desplazadas por `40px` en su margen izquierdo para alinearse milimétricamente con el inicio del espectrograma WebGL, la fila de botones de controles e indicadores comenzaba desde el extremo izquierdo de la tarjeta, rompiendo la simetría y las líneas del bento box.
* **Solución técnica:**
  1. Se añadió un relleno interno izquierdo exacto a la clase `.transport-container`: `padding-left: 40px;`.
  2. Se configuró `box-sizing: border-box;` y `width: 100%;` para asegurar que el contenedor calcule su ancho total de manera correcta sin desbordamientos en resoluciones móviles o compactas.
  3. Esto logra que el grupo inicial de reproducción (`REPRODUCIR`) se alinee de manera idéntica con el origen del audio en el espectrograma y que la telemetría derecha se alinee con el borde derecho del visualizador.

---

## 7. Sustitución de Badge "CONTROLS" por Cabecera Integrada Grid
* **Archivo afectado:** `src/components/VostokRestoration.jsx` (Líneas ~1287-1322)
* **Problema previo:** El badge azul redondeado flotante que decía "CONTROLS" utilizaba un estilo de píldora con sombra de alta opacidad que contrastaba agresivamente con la estética sobria, plana y técnica de los costados laterales y cabeceras del sistema.
* **Solución técnica:**
  1. Se removió por completo el nodo `div` absoluto con la clase de fondo azul.
  2. En su lugar, se insertó un encabezado plano y sofisticado que actúa como rótulo de control debajo del `TimelineScrubber`: `VOSTOK // SYSTEM_TRANSPORT` en tipografía monospace (`var(--font-mono)`), de tamaño `9px`, peso extremo `900` y con espaciado amplio de `0.15em`.
  3. Para acentuar su naturaleza de monitoreo activo, se le añadió un **micro-LED cian pulsante interactivo (`.vostok-led`)** que simula un sensor de rack en tiempo real, sintonizado perfectamente con las animaciones de baja CPU del sistema.

---

## 8. Reducción y Compensación Simétrica de Márgenes (Top/Bottom)
* **Archivo afectado:** `src/components/VostokRestoration.jsx` (Líneas ~1047-1052, ~1284-1288)
* **Problema previo:** El espectrograma sufría un desbalanceo de márgenes verticales severo. Tenía un padding de `16px` del contenedor general de bento, más un `paddingTop` interno de `16px` en el contenedor del visualizador core (total de `32px` arriba), empujando el espectrograma hacia abajo y desalineando su tope con el panel lateral derecho. Abajo, el margen al fondo de pantalla era de tan solo `16px`, dejando los botones amontonados contra el pie de página.
* **Solución técnica:**
  1. **Remoción de Relleno Redundante:** Se redujo el `paddingTop` del contenedor de visualización core (`paddingTop: isMaximized ? '0px' : '16px'`) a exactamente `0px`.
  2. **Compensación de Base:** Se redujo el relleno superior del contenedor de controles bento de `20px` a exactamente `4px`.
  3. Esto encaja perfectamente el `TimelineScrubber` contra la base del espectrograma, de manera idéntica a la distancia milimétrica del `VerticalScrubber` izquierdo, y estandariza los márgenes externos a un contorno de exactamente **`16px`** simétrico en las cuatro direcciones del espacio.

---

## 9. Unificación Estética de Botones con LandingView
* **Archivo afectado:** `src/index.css` (Líneas ~321-360, clase `.vostok-btn-transport`)
* **Problema previo:** Los botones de transporte tenían textos en tipografía sans-serif (`var(--font-ui)`), sin iluminación y en un gris opaco de baja legibilidad, haciéndolos lucir inactivos o desactivados por completo en su estado por defecto.
* **Solución técnica:**
  1. **Sincronización de Identidad:** Se rediseñó el estado base de la clase `.vostok-btn-transport` para igualarlo visualmente al botón primario de carga de archivo (`.btn-primary`): se aplicó **`font-family: var(--font-mono)`**, tamaño de `10px`, peso pesado de **`900`** y espaciado de letras de **`0.15em`**.
  2. **Bordes y Radio:** Se configuró **`border-radius: var(--radius-md)`** y un contorno refinado de `1px solid rgba(255, 255, 255, 0.12)`.
  3. **Brillo Posterior de Standby (Fósforo Blanco):** Se asignó color blanco puro al texto e iconos (`#ffffff`) y se dotó a los botones de un sutil halo trasero blanco en reposo (`box-shadow: 0 0 12px rgba(255, 255, 255, 0.03)`).
  4. **Interactividad Reactiva:** En hover, se incrementa la retroiluminación a un brillo trasero expansivo de **`16px`** (`rgba(255, 255, 255, 0.08)`) y borde más de doble densidad (`rgba(255, 255, 255, 0.25)`). Al activarse, los estados toggle sobreescriben la iluminación por completo a verde o cian con un fondo y borde de alta intensidad cromática.


