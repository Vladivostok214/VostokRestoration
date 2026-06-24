# Vostok Labs: Manual de Lineamientos Gráficos y Sistema de Diseño (Noir-Tech Standard)

Este documento actúa como la **Fuente de la Verdad (Source of Truth)** del sistema de diseño gráfico y de experiencia de usuario (UX/UI) de **Vostok Labs**. Está diseñado para servir como contexto maestro inyectable en cualquier agente o desarrollador que necesite expandir o crear nuevas aplicaciones y herramientas dentro del ecosistema de audio digital de alta fidelidad de Vostok Labs.

---

## 1. Fundamentos del Estilo Noir-Tech

El estilo **Noir-Tech** de Vostok Labs no es decorativo; es una representación de la precisión de grado estudio, la soberanía tecnológica y el procesamiento local-first. Se inspira en la estética industrial militar retro, los analizadores de espectro analógicos mecánicos (estilo estroboscópico de neón) y las consolas de diagnóstico cibernéticas.

### Pilares Clave:
1.  **Negro Absoluto como Lienzo:** Todo surge del fondo más oscuro posible para maximizar el contraste con la telemetría brillante.
2.  **Esqueumorfismo Lumínico:** Interfaces oscuras con relieves invisibles en reposo que se revelan mediante destellos radiantes (glows) y transiciones de aceleración de hardware.
3.  **Híper-Legibilidad Estructural:** Grillas milimétricas de precisión matemática para la alineación del layout, eliminando cualquier margen aleatorio.

---

## 2. Paleta Cromática y Tokens de Color

La paleta se divide en tres niveles: fondo de absorción de luz, telemetría activa (foco táctil) y alertas de estado del sistema.

### Colores de Núcleo (Core Colors)
*   **Deep Black (Fondo Absoluto):** `#010101`
    *   *Uso:* Color de fondo general del cuerpo y de las vistas principales. Absorbe la luz ambiental digital.
*   **Card Black (Bloques de Interfaz):** `#0A0A0A`
    *   *Uso:* Tarjetas contenedoras, modales, consolas y capas activas flotantes.
*   **Vostok Green (Foco e Instrumentación):** `#39FF14` (`rgb(57, 255, 20)`)
    *   *Uso:* Símbolos de estado óptimo (DSP_STABLE), agujas de medición analógica de afinación, frecuencias estables y estados activos principales.

### Colores Secundarios y Acentos
*   **Vostok Cyan (Telemetría e Historia):** `#06B6D4` (Acento cian estándar)
    *   *Uso:* Archivo histórico, indicadores de salud técnica del sistema, elementos interactivos de navegación secundaria y relieves dinámicos.
*   **Glow Purple (Líneas de Compilación):** `#A855F7` / `#9333EA`
    *   *Uso:* Destellos ambientales profundos, áreas alfa o experimentales.

---

## 3. Tipografía y Jerarquía de Telemetría

Se importan y manejan de forma exclusiva dos familias tipográficas desde Google Fonts para mantener un balance entre la legibilidad estética y los datos crudos.

```html
<!-- Enlace de Importación Global -->
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;700;900&display=swap');
```

### A. Tipografía Sans (Inter)
*   **Uso:** Encabezados de interfaces, descripciones, contenido de modales, botones principales y cuerpos de texto legibles.
*   **Clase en Tailwind v4:** `font-sans`

### B. Tipografía Mono (JetBrains Mono)
*   **Uso:** Lecturas de datos duros, telemetría dinámica (`Buffer_Size`, `Latency: 2.4ms`, `dBFS`), estampas de compilación, identificadores de estado y consola de diagnóstico.
*   **Clase en Tailwind v4:** `font-mono`

#### Jerarquía Tipográfica Estándar (Clases de Tailwind v4)
*   **Título Hero (h1):** `text-4xl md:text-5xl font-light tracking-tighter text-white uppercase`
*   **Subtítulo de Sección (h2):** `text-2xl font-bold tracking-tight text-white uppercase`
*   **Etiqueta de Telemetría Secundaria:** `text-[10px] font-mono tracking-[0.3em] font-black uppercase text-cyan-500`
*   **Lectura de Datos Críticos:** `text-lg font-mono font-bold text-slate-300`

---

## 4. Efectos Especiales de Interfaz (Noir-Tech FX)

Los efectos de atmósfera analógica y resplandor están definidos como clases reutilizables en `index.css`:

### A. El Filtro CRT (`.crt-scanlines`)
Inyecta un patrón sutil de líneas horizontales fijas al 25% de opacidad para emular el renderizado analógico de tubos de rayos catódicos sin bloquear la interacción del usuario.
```css
.crt-scanlines::before {
  content: " ";
  display: block;
  position: fixed;
  top: 0; left: 0; bottom: 0; right: 0;
  background: linear-gradient(
    to bottom,
    rgba(18, 16, 16, 0) 50%,
    rgba(0, 0, 0, 0.25) 50%
  );
  background-size: 100% 4px;
  z-index: 5;
  pointer-events: none;
}
```

### B. Grilla Milimétrica de 40px (`.grid-bg`)
Establece una cuadrícula matemática que simula el papel de calibración acústico de laboratorio.
```css
:root {
  --grid-color: rgba(57, 255, 20, 0.08); /* 8% de opacidad de Verde Vostok */
}

.grid-bg {
  background-image: linear-gradient(var(--grid-color) 1px, transparent 1px), 
                    linear-gradient(90deg, var(--grid-color) 1px, transparent 1px);
  background-size: 40px 40px;
}
```

### C. Resplandores Radiales de Atmósfera (Glows)
Se inyectan capas de fondo con opacidades degradadas para dar profundidad a áreas específicas del layout.
```css
.glow-green {
  background: radial-gradient(circle at center, rgba(57, 255, 20, 0.35) 0%, rgba(57, 255, 20, 0) 60%);
}
.glow-cyan {
  background: radial-gradient(circle at center, rgba(6, 182, 212, 0.4) 0%, rgba(6, 182, 212, 0) 60%);
}
```

---

## 5. Patrones de Diseño de Componentes (Component Specs)

### A. Tarjetas de Herramientas del Catálogo
Para emular la profundidad 3D sin usar sombras pesadas, las tarjetas se apilan con capas falsas traseras que cambian su escala y traslación vertical al interactuar (`hover`).

```jsx
// Estructura React Reutilizable para Tarjetas Interactiva
<div className="relative group cursor-pointer">
  {/* Capa Trasera 2 (Efecto de Profundidad) */}
  <div className="absolute top-0 left-0 w-full h-full bg-[#050505] border border-white/5 rounded-[2.5rem] transform translate-y-8 scale-[0.90] -z-20 transition-transform duration-500 group-hover:translate-y-10 group-hover:scale-[0.88]" />
  {/* Capa Trasera 1 */}
  <div className="absolute top-0 left-0 w-full h-full bg-[#080808] border border-white/5 rounded-[2.5rem] transform translate-y-4 scale-[0.95] -z-10 transition-transform duration-500 group-hover:translate-y-5 group-hover:scale-[0.94]" />

  {/* Capa Frontal Activa */}
  <div className="relative z-20 bg-[#0A0A0A] border border-white/5 rounded-[2.5rem] p-8 md:p-12 shadow-2xl overflow-hidden transition-all duration-500 group-hover:border-cyan-500/30">
    <div className="relative z-10">
      {/* Contenido de la Tarjeta */}
    </div>
    {/* Efecto de Brillo Interno en Hover */}
    <div className="absolute inset-0 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ background: `radial-gradient(circle at center, #00f5ff05 0%, transparent 70%)` }} />
  </div>
</div>
```

### B. Etiquetas de Estado (Badges)
Tienen un borde semi-translúcido para fundirse con el fondo oscuro e integran tipografías monoespaciadas de trazo grueso.
```html
<span className="inline-block px-4 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/20 text-[10px] font-black text-cyan-400 uppercase tracking-widest">
  NUEVO
</span>
```

### C. Botones Principales de Llamada a la Acción (Glass CTAs)
Son completamente elípticos (`rounded-full`), con fondos de baja opacidad y bordes finos que se iluminan al posicionarse encima.
```html
<button className="px-10 py-4 bg-white/5 border border-cyan-500/20 rounded-full flex items-center gap-4 group transition-all hover:bg-cyan-500/10 hover:border-cyan-500/40">
  <Activity className="w-5 h-5 text-cyan-400 group-hover:animate-pulse" />
  <span className="text-xs font-bold text-white uppercase tracking-widest">ABRIR DISPOSITIVO</span>
</button>
```

---

## 6. Integración Técnica en Nuevas Aplicaciones

Para heredar la estética de Vostok Labs de manera inmediata al iniciar un nuevo módulo o aplicación:

1.  **Layout General:** El contenedor maestro debe encapsular la vista con las clases de atmósfera del CRT y la rejilla.
    ```html
    <div className="min-h-screen bg-[#010101] crt-scanlines text-white font-sans overflow-x-hidden grid-bg">
       <!-- Componente de Audio o Instrumento -->
    </div>
    ```
2.  **Soporte de Altura Segura (Mobile/Capacitor):** Usa clases de inserción segura de área superior e inferior para evitar solapamiento de la barra de estado de dispositivos móviles.
    ```html
    <header className="safe-pt"> ... </header>
    <footer className="safe-pb"> ... </footer>
    ```
3.  **Cierre de Procesos (VHRP Compliance):** Toda interfaz táctil interactiva que invoque APIs del dispositivo (Web Audio, micrófono, wake locks) debe ser revocada al desmontar el componente usando el protocolo estricto de limpieza.
