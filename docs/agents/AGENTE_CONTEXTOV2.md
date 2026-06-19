# VOSTOK RESTORATION V1 — AGENTE_CONTEXTO_V2

> Estado de referencia: Cierre de P1.4
>
> Commit estable: 27a639e (base) + EXP-HUM-01 + EXP-HUM-02
>
> Estado: Producción funcional validada
>
> Última actualización: Post P1.4 Calibración Detector Hum

---

# 1. RESUMEN EJECUTIVO

Vostok Restoration V1 es una aplicación nativa de restauración forense de audio construida sobre Tauri + Rust + React.

El sistema detecta y repara:

* Clicks
* Pops
* Dropouts
* Hum (50/60Hz)
* Hiss
* Clipping

sobre buffers PCM cargados completamente en memoria.

La aplicación se considera actualmente estable y funcional.

---

# 2. ESTADO ACTUAL DEL ROADMAP

## P0 — COMPLETADO

Optimizaciones críticas de estabilidad y rendimiento.

Implementado:

* Locks cortos en Tauri.
* Eliminación de bloqueos innecesarios.
* Mejoras de sincronización backend/frontend.

Estado:

COMPLETADO.

---

## P0.2 — COMPLETADO

Sistema de versionado de audio.

Implementado:

* audio_version en AppState.
* Sincronización backend/frontend.
* Validación de consistencia de espectrogramas.
* Descarte automático de respuestas obsoletas.

Estado:

COMPLETADO.

---

## P1.1 — COMPLETADO

Modularización completa del motor DSP.

Estado anterior:

src-tauri/src/dsp.rs
≈ 2563 líneas

Estado actual:

src-tauri/src/vostok_dsp/

* types.rs
* utils.rs
* io.rs
* stft.rs
* detectors.rs
* restoration.rs

dsp.rs es ahora únicamente una fachada de re-exportación.

Validación:

* cargo check OK
* npm run build OK
* npm run tauri build OK
* QA manual OK

---

## P1.2 — POSPUESTO

Objetivo:

Modularización de SpectrogramGL y desacoplamiento WebGL.

Resultado:

Se validó experimentalmente un SpectrogramRenderer desacoplado.

Conclusión:

La integración fue demasiado invasiva.

Beneficio inmediato insuficiente frente al riesgo.

Estado:

POSPUESTADO.

No continuar P1.2 salvo instrucción explícita.

---

## P1.3 — SIGUIENTE PRIORIDAD (RENDIMIENTO)

Objetivo:

Optimización de rendimiento real.

Pendientes:

1. STFT estéreo duplicada.
2. Copias multicanal innecesarias.
3. Playback clonando buffers completos.
4. Optimización de get_paged_spectrogram.
5. Actualizaciones parciales del espectrograma tras reparaciones.

---

## P1.4 — COMPLETADO

Calibración del detector de Hum electromagnético.

Contexto:

Auditoría estática (AUDITORIA_DETECTAR_HUM.md) identificó 9 debilidades.
Se ejecutaron 2 intervenciones experimentales aisladas, validadas por QA.

Implementado:

### EXP-HUM-01 — gap_tolerance

Archivo: vostok_dsp/detectors.rs · detectar_hum()

Antes:

```rust
let gap_tolerance = 120; // ~2.78 segundos
```

Después:

```rust
let gap_tolerance = 15; // ~348 ms
```

Resultado QA:

El evento único de duración total del archivo se fragmentó en 7 eventos independientes.
El evento real (~26.6s) fue detectado correctamente, coincidente con Ground Truth (26.94s → 36.88s).
Hipótesis #1 de la auditoría: VALIDADA.

### EXP-HUM-02 — peak_threshold

Archivo: vostok_dsp/detectors.rs · detectar_hum()

Antes:

```rust
let peak_threshold = 2.0 - (sensitivity * 0.8);
// Rango: [1.2x – 2.0x] sobre vecinos
```

Después:

```rust
let peak_threshold = 6.0 - (sensitivity * 3.0);
// Rango: [3.0x – 6.0x] sobre vecinos
```

Justificación:

Un hum electromagnético real (sinusoide pura, ventana Hann) supera 8x–20x a sus
vecinos espectrales. El contenido musical en bajos raramente supera 3x–4x.
El umbral anterior (mín 1.2x = +1.6 dB) era indistinguible del ruido musical.

Resultado QA:

Los 6 falsos positivos residuales de EXP-HUM-01 fueron eliminados.
El evento real de hum se mantuvo detectado correctamente.
Hipótesis #2 de la auditoría: VALIDADA.

Estado:

COMPLETADO.

Hallazgos #3–#9 de la auditoría: pendientes de evaluación futura si se detectan
nuevos falsos positivos en otros materiales.

---

# 3. ARQUITECTURA ACTUAL

## Backend

src-tauri/src/

### lib.rs

Responsabilidades:

* Comandos Tauri.
* AppState.
* Mutexes.
* audio_version.
* IPC.

No contiene algoritmos DSP complejos.

---

### vostok_dsp/types.rs

Tipos compartidos:

* AudioBuffer
* StftResult
* GlitchEvent
* ScanParams
* ViewportConfig

---

### vostok_dsp/utils.rs

Utilidades matemáticas:

* LPC
* Sistemas lineales
* Helpers DSP

---

### vostok_dsp/io.rs

Entrada y salida:

* decode_audio_file
* export_repaired_wav
* stft_to_binary

---

### vostok_dsp/stft.rs

Motor espectral:

* compute_stft
* compute_stft_multichannel
* update_stft_range_multichannel
* get_paged_spectrogram

---

### vostok_dsp/detectors.rs

Detectores:

* Clicks
* Pops
* Hum
* Hiss
* Clipping
* Dropouts

---

### vostok_dsp/restoration.rs

Motores de reparación:

* Hermite
* LSAR
* Notch
* High Shelf

Incluye:

AudioHistoryState

para Undo / Redo.

---

# 4. INVARIANTES CRÍTICOS

Nunca romper:

## IPC binario

Header actual:

[frames:u32]
[bins:u32]
[audio_version:u64]

16 bytes exactos.

---

## audio_version

Debe incrementarse en:

* carga de audio
* reparación
* undo
* redo

Toda respuesta visual debe corresponder a la versión vigente.

---

## QA obligatorio

Antes de cerrar una fase:

* cargar archivo
* playback
* zoom
* selección manual
* análisis avanzado
* reparación
* undo
* redo
* export WAV

---

# 5. DOCUMENTOS DE REFERENCIA

Lectura recomendada para nuevos agentes:

1. PROD-007_P1.1_COMPLETION_REPORT.md
2. INFORME_TECNICO_OPTIMIZACION.md
3. AUDITORIA_DETECTAR_HUM.md (auditoría y estado de correcciones del detector Hum)
4. AGENTE_CONTEXTO.md (solo referencia histórica)
5. Código actual de vostok_dsp
6. src-tauri/src/lib.rs

---

# 6. DIRECTRIZ PARA NUEVOS AGENTES

Antes de proponer cambios:

1. Leer primero el código actual.
2. Verificar que la información documental coincide con el repositorio.
3. No asumir que documentos históricos representan el estado actual.
4. Priorizar mejoras medibles de CPU, RAM, IPC y UX.
5. Evitar refactorizaciones frontend masivas salvo necesidad justificada.

La prioridad actual es P1.3 (optimización de rendimiento), no P1.2.
