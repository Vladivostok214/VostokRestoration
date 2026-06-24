# Plan P0.1: Finalización de la Iniciativa P0

## 1. Contexto y Estado Actual

La iniciativa `P0` se creó para resolver los bloqueos de UI causados por un manejo de concurrencia subóptimo en el backend. Se implementó una primera fase de mitigación que consistió en 3 modificaciones a los comandos `ejecutar_analisis_avanzado`, `obtener_espectrograma_dinamico` y `reparar_glitches_seleccionados` para acortar la duración de los `Mutex`.

Esta primera fase fue exitosa en su objetivo principal, pero introdujo una deuda técnica: el uso de `clone()` para crear snapshots, lo cual impacta el rendimiento y el uso de memoria en archivos grandes.

Este documento, `Plan P0.1`, detalla las tareas restantes para **completar la iniciativa P0**, abordando tanto la deuda introducida como los pasos de robustez definidos en el plan original.

---

## 2. Tareas para la Finalización de P0

### Tarea 1: Mitigar Riesgo de Memoria (Migración a `Arc<T>`)

*   **Objetivo:** Reemplazar la estrategia de `clone()` por snapshots `Arc<T>` (Atomic Reference Counter) de coste cero, eliminando la sobrecarga de memoria y latencia de la solución inicial.
*   **Fuente:** "Mejor siguiente paso" y "Riesgo: Memoria temporal mayor" del documento `Plan P0 Locks Cortos En Tauri.txt`.
*   **Refactorización Detallada:**
    1.  **Actualizar `AppState`:** En `src-tauri/src/lib.rs`, envolver los tipos `Option<AudioBuffer>` y `Option<StftResult>` con `Arc`.
        ```rust
        use std::sync::Arc;
        pub audio: Mutex<Option<Arc<AudioBuffer>>>,
        pub stft: Mutex<Option<Arc<StftResult>>>,
        ```
    2.  **Snapshots de Lectura:** En los comandos, reemplazar `.cloned()` por `.as_ref().map(Arc::clone)`. Esto solo copia un puntero, siendo una operación casi instantánea.
    3.  **Gestión de Mutación (Copy-on-Write):** Para escrituras, usar `Arc::make_mut` dentro del `lock`. Esto creará una copia de los datos solo si es estrictamente necesario (es decir, si existen otras referencias al `Arc`), optimizando el rendimiento y garantizando la seguridad.

### Tarea 2: Añadir Versionado de Estado (Paso 4 del Plan P0)

*   **Objetivo:** Implementar un sistema de versionado para prevenir condiciones de carrera y asegurar que el frontend siempre opere sobre el estado más reciente.
*   **Fuente:** "Paso 4. Añadir `audio_version`" del documento `Plan P0 Locks Cortos En Tauri.txt`.
*   **Refactorización Detallada:**
    1.  **Añadir a `AppState`:** Incorporar `pub audio_version: Mutex<u64>` en la struct `AppState`.
    2.  **Incrementar en Mutaciones:** Incrementar `audio_version` dentro del `lock` en todos los comandos que alteren el estado (`cargar_y_analizar_archivo`, `reparar_glitches_seleccionados`, `deshacer_accion`, `rehacer_accion`).
    3.  **Propagar Versión al Frontend:** Incluir el `audio_version` en las structs de respuesta a la UI (`InitialAnalysis`, `UndoRedoResponse`).
    4.  **Validar en Frontend:** La lógica de la UI (ej. `useGlitchManager.js`) deberá comparar la versión de las respuestas entrantes con la versión actual que posee, descartando cualquier dato obsoleto.

### Tarea 3: Refactorizar `reparación / undo / redo` (Paso 5 del Plan P0)

*   **Objetivo:** Refactorizar el flujo de mutación de estado más complejo y riesgoso para que opere de forma segura y consistente con la nueva arquitectura basada en `Arc` y versionado.
*   **Fuente:** "Paso 5. Refactorizar reparación / undo / redo" del documento `Plan P0 Locks Cortos En Tauri.txt`.
*   **Refactorización Detallada:**
    1.  **Revisar Lógica de Pilas:** Asegurar que las pilas `undo_stack` y `redo_stack` almacenen y restauren correctamente los `Arc<AudioBuffer>` y `Arc<StftResult>`.
    2.  **Transiciones Atómicas:** Garantizar que cada operación de `undo`/`redo` sea atómica. Al deshacer, no se muta el `Arc` actual, sino que se reemplaza por el `Arc` del estado anterior, y se incrementa la `audio_version`.
    3.  **Consistencia de Estado:** Validar que la lógica de `Arc::make_mut` en el comando de reparación principal (`reparar_glitches_seleccionados`) coexista correctamente con el historial de `undo`/`redo`. El estado previo que se guarde en el historial debe ser una clonación del `Arc` justo antes de la mutación.

---

## 3. Optimizaciones Recomendadas (Post-P0 / P1)

Las siguientes optimizaciones fueron identificadas durante el análisis pero quedan fuera del alcance de la finalización de P0. Se recomienda abordarlas en una futura iniciativa (P1).

*   **Optimización de Playback:** Reemplazar el `clone()` del búfer de audio en `toggle_playback` con una fuente de Rodio personalizada (`ArcSource`) para eliminar la latencia en la reproducción.
*   **Robustez General:** Reemplazar progresivamente el uso de `.unwrap()` por un manejo de errores explícito (`map_err` y propagación con `?`) para evitar `panics`.
