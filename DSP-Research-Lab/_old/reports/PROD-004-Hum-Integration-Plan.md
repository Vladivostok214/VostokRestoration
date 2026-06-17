# PROD-004: Reporte de Cambios y Reversión (Hum Detection)

Este documento detalla los cambios introducidos en la base de código de **Vostok Restoration V1** durante la implementación técnica del detector de Hum y registra el proceso de reversión para retornar al estado original del repositorio.

---

## 1. Inventario y Descripción de Cambios

### 1.1 Archivos Modificados
* **[dsp.rs](file:///C:/Users/WLADI/Vostok%20Plugins/vostok-apps-web/Vostok%20Restoration%20V1/src-tauri/src/dsp.rs)**: Único archivo de producción modificado.

### 1.2 Funciones Añadidas
* **`detect_hum_dynamic`**: 
  ```rust
  pub fn detect_hum_dynamic(
      _samples: &[f32],
      stft: &AnalyticalSpectrogram,
      fft_size: usize,
      hop_size: usize,
      sample_rate: u32,
      start_secs: f64,
      end_secs: f64,
      thresholds: &DetectorThresholds,
  ) -> Vec<GlitchEvent>
  ```
  Implementación híbrida-contextual que calcula candidatos en las fundamentales de red de 50/60 Hz, mide estabilidad por Coeficiente de Variación ($CV < 0.1$), persistencia local ($> 500$ ms) y determina la confianza a través del decaimiento armónico ($< 0.8$) y el ratio de persistencia global sobre el archivo completo.

### 1.3 Funciones Eliminadas
* **Ninguna**. El detector de Hum legado consistía en un bloque de código condicional *inline* dentro de `detect_artifacts_dynamic`, por lo que no se removió ninguna firma de función.

### 1.4 Estructuras Modificadas
* **Ninguna**. La estructura unificada `GlitchEvent` y sus propiedades asociadas no requirieron modificaciones.

### 1.5 Parámetros Introducidos
* En la firma de `detect_hum_dynamic`, se introdujeron parámetros estándar de contexto de procesamiento espectral: buffer de muestras (`_samples`), espectrograma analítico (`stft`), tamaño de FFT (`fft_size`), hop de STFT (`hop_size`), frecuencia de muestreo (`sample_rate`), límites del viewport (`start_secs`, `end_secs`), y el struct de configuración de umbrales (`thresholds`).

### 1.6 Cambios en `detect_artifacts_dynamic`
Se reemplazó el bucle de detección legado:
```rust
// CODIGO LEGADO REMOVIDO
if active_filters.get("hum").copied().unwrap_or(false) {
    let target_freqs = [50.0, 60.0, 100.0, 120.0, ...];
    ...
    if active_ratio > thresholds.hum_active_ratio {
        events.push(GlitchEvent { ... });
    }
}
```
Por el llamado modular al nuevo motor híbrido:
```rust
// CODIGO NUEVO INTRODUCIDO
if active_filters.get("hum").copied().unwrap_or(false) {
    let mut hum_events = detect_hum_dynamic(
        samples,
        stft,
        fft_size,
        hop_size,
        sample_rate,
        start_secs,
        end_secs,
        thresholds,
    );
    events.append(&mut hum_events);
}
```

### 1.7 Cambios en `AppState` e IPC
* **Ninguno**. La firma de los comandos de Tauri (`ejecutar_deteccion_glitches`) y el estado compartido en la RAM del backend (`AppState`) se mantuvieron 100% inalterados, preservando las garantías de estabilidad de la aplicación.

### 1.8 Cambios en Frontend
* **Ninguno**. La lógica UI de React en [VostokRestoration.jsx](file:///C:/Users/WLADI/Vostok%20Plugins/vostok-apps-web/Vostok%20Restoration%20V1/src/components/VostokRestoration.jsx) y el listado de telemetría de [GlitchPanel.jsx](file:///C:/Users/WLADI/Vostok%20Plugins/vostok-apps-web/Vostok%20Restoration%20V1/src/components/GlitchPanel.jsx) ya soportaban el tipo `"HUM"` y su representación visual en color verde neón (`#39FF14`).

---

## 2. Registro de Reversión y Restauración

Para revertir el proyecto al estado original de inicio de esta tarea, se ejecutó:
```bash
git restore src-tauri/src/dsp.rs
```

### 2.1 Archivos Revertidos
* `src-tauri/src/dsp.rs`

### 2.2 Confirmación de Estabilidad
La reversión se validó mediante:
```bash
cargo check --lib
```
Confirmando que el núcleo DSP y el bridge de Tauri volvieron exactamente a su estado de compilación base sin warnings ni errores adicionales en producción.

---
*(Reporte de Auditoría y Reversión de Cambios de Hum para Vostok Restoration V1).*
