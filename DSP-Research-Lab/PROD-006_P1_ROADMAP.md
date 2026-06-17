# PROD-006: Roadmap de Optimización y Modularización P1

## 1. Objetivos Generales
La fase P1 se centra en la **Modularidad**, **Escalabilidad** y **Rendimiento Avanzado**. El objetivo es transformar el prototipo funcional actual en una arquitectura de grado profesional capaz de manejar sesiones multicanal y flujos de trabajo de restauración complejos.

---

## 2. Roadmap Detallado

### P1.1: Modularización del Backend (`dsp.rs`)
**Objetivo:** Descomponer el archivo monolítico `dsp.rs` en módulos especializados para mejorar la mantenibilidad y testabilidad.
*   **Archivos afectados:** `src-tauri/src/dsp.rs`, `src-tauri/src/lib.rs`.
*   **Módulos propuestos:**
    *   `vostok_dsp::stft`: Motores FFT y gestión de matrices espectrales.
    *   `vostok_dsp::detectors`: Algoritmos de detección (clicks, hum, etc.).
    *   `vostok_dsp::restoration`: Motores de reparación (Hermite, LSAR).
    *   `vostok_dsp::io`: Decodificación y exportación WAV.
*   **Riesgo de regresión:** Medio (requiere re-mapeo de imports en `lib.rs`).
*   **Complejidad:** Media.
*   **Beneficio:** Facilita la implementación de nuevos algoritmos sin tocar el core.

### P1.2: Modularización del Frontend (`SpectrogramGL.jsx`)
**Objetivo:** Separar el motor de renderizado WebGL puro de la lógica de negocio de la UI.
*   **Archivos afectados:** `src/components/SpectrogramGL.jsx`.
*   **Componentes propuestos:**
    *   `SpectrogramCanvas`: Renderizado crudo de texturas.
    *   `SpectrogramOverlays`: Capas de WebGL para waveforms, glitches y selecciones.
    *   `SpectrogramRulers`: Reglas temporales y de frecuencia sincronizadas.
*   **Riesgo de regresión:** Alto (posible ruptura de sincronización de zooms/scrolls).
*   **Complejidad:** Alta.
*   **Beneficio:** Permite optimizar el loop de renderizado de forma independiente a React.

### P1.3: Arquitectura de Cache Espectral Multicanal
**Objetivo:** Diseñar una estructura que soporte caché de STFT por canal para evitar re-cálculos innecesarios tras reparaciones localizadas.
*   **Archivos afectados:** `src-tauri/src/lib.rs`, `src-tauri/src/dsp.rs`.
*   **Estrategia:**
    *   Cambiar `StftResult` a una estructura multicanal real.
    *   Implementar `matrix_version` por canal.
*   **Riesgo de regresión:** Medio.
*   **Complejidad:** Media.
*   **Beneficio:** Reducción masiva de CPU al reparar un solo canal en archivos estéreo.

### P1.4: Respuesta Incremental de Texturas
**Objetivo:** Permitir que el backend devuelva solo los "tiles" o regiones del espectrograma que han cambiado tras una reparación.
*   **Archivos afectados:** `lib.rs`, `useGlitchManager.js`, `SpectrogramGL.jsx`.
*   **Estrategia:**
    *   Comando `obtener_delta_espectrograma`.
    *   Actualización parcial de textura en GPU vía `texSubImage2D`.
*   **Riesgo de regresión:** Medio.
*   **Complejidad:** Alta.
*   **Beneficio:** Latencia de visualización de reparaciones cercana a 0ms.

---

## 3. Priorización y Estrategia de Implementación

| Tarea | Prioridad | Dependencia | Estrategia Incremental |
| :--- | :--- | :--- | :--- |
| **P1.1** | Crítica | Ninguna | Refactorizar un módulo a la vez, manteniendo `dsp.rs` como façade. |
| **P1.3** | Alta | P1.1 | Implementar la estructura multicanal antes de optimizar el cache. |
| **P1.2** | Media | Ninguna | Extraer primero los Rulers, luego los Overlays. |
| **P1.4** | Baja | P1.2, P1.3 | Prototipar con reparaciones pequeñas primero. |

---
**Plan diseñado por:** Gemini CLI Agent
**Basado en:** INFORME_TECNICO_OPTIMIZACION.md
**Fecha:** 17 de Junio de 2026
