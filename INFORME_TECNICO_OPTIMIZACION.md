# Informe Tecnico de Arquitectura y Optimizacion

Lei `AGENTE_CONTEXTO.md` y analice el repositorio sin modificar archivos. No ejecute comandos destructivos ni builds/tests.

## 1. Arquitectura Actual

La app activa es una desktop app Tauri v2 con frontend React/Vite y backend Rust. El runtime real esta concentrado en `src/` y `src-tauri/src/`; `DSP-Research-Lab/_old` funciona como archivo historico/laboratorio.

Backend:
- Estado global en Rust: audio PCM, STFT, playback, undo/redo en `AppState` con `Mutex<Option<...>>` y stacks nativos. Ver `src-tauri/src/lib.rs`.
- Carga inicial: `cargar_y_analizar_archivo` decodifica con Symphonia, calcula STFT 4096/1024, genera envolvente y guarda audio/STFT en memoria Rust.
- DSP principal en `src-tauri/src/dsp.rs`: extraccion de features, detectores, STFT RealFFT/Rayon, reparaciones Hermite/LSAR/notch/shelf, export WAV.
- Analisis avanzado: `ejecutar_analisis_avanzado` toma locks de audio/STFT y ejecuta `ejecutar_analisis_dsp`.
- Reparacion: `reparar_glitches_seleccionados` muta el audio, actualiza STFT parcial y devuelve espectrograma + envolvente + glitches.

Frontend:
- `App.jsx` orquesta landing/workspace y versiona la matriz con `matrixVersion`.
- `LandingView.jsx` carga audio, pide espectrograma visible y deposita el `Uint8Array` en `SPECTROGRAM_STORAGE`.
- `VostokRestoration.jsx` concentra viewport, transporte, reportes, export, controles y layout; es el componente mas grande del frontend.
- `SpectrogramGL.jsx` renderiza textura WebGL, overlays SVG, seleccion 2D, loop region y settings.
- `useGlitchManager.js` centraliza IPC de scan/heal/undo/redo.

## 2. Cuellos de Botella Potenciales

- Re-calculo STFT por canal en cada analisis estereo: `ejecutar_analisis_dsp` de-interleavea cada canal y vuelve a calcular STFT por canal aunque ya existe una STFT global combinada. Es correcto para precision por canal, pero caro.
- De-interleave repetido y copias grandes: `compute_stft_multichannel`, analisis estereo y reparacion crean `Vec<f32>` por canal.
- Playback clona todo el audio en cada play/seek cuando crea `SamplesBuffer`. En loop o seeks frecuentes sobre archivos largos puede ser el cuello mas visible.
- `get_paged_spectrogram` copia o downsamplea matrices completas antes de serializar.
- Reparacion devuelve siempre espectrograma paginado completo hasta 2048 frames, incluso si solo cambio una region.
- Modulos grandes: `dsp.rs` 2560 lineas, `SpectrogramGL.jsx` 1620, `VostokRestoration.jsx` 1434, `lib.rs` 946. Esto aumenta costo cognitivo y riesgo de regresiones.

## 3. Riesgos de Concurrencia o Bloqueo UI

- Locks prolongados: `ejecutar_analisis_avanzado` mantiene `audio_lock` y `stft_lock` durante todo el analisis DSP. Esto bloquea otros comandos que necesiten audio/STFT.
- Reparacion mantiene locks de audio y STFT mientras repara, actualiza STFT, genera espectrograma binario y envolvente. Riesgo: playback/export/HD render esperan.
- `obtener_espectrograma_dinamico` mantiene `audio_lock` mientras calcula STFT local. Si el usuario dispara enfoque HD sobre una ventana grande, puede bloquear comandos relacionados.
- `unwrap()` sobre locks/FFT/sort puede panicar ante poisoned mutex, NaN en `time_secs` o error de FFT.
- Frontend: `setPlayheadTime` ocurre en `requestAnimationFrame`, por lo que React sigue recibiendo estado a 60 FPS durante reproduccion. Esta mitigado por refs y page-scroll, pero sigue siendo presion de render.
- Muchos overlays SVG por glitch en React. Para cientos/miles de anomalias, `GlitchLayer` puede degradar por DOM/SVG aunque el espectrograma base sea WebGL.

## 4. Oportunidades de Optimizacion DSP

- Cachear STFT por canal o almacenar `StftResult` multicanal real, no solo matriz combinada. Evitaria recalcular STFT por canal en cada scan estereo.
- Cambiar extraccion de canal a vistas/iteradores especializados o buffers persistentes reutilizables para reducir allocations por analisis/reparacion.
- Optimizar `stft_to_binary`: hoy convierte cada magnitud a dB y `u8` en bucle escalar. Puede paralelizarse por chunks o usar LUT/approx para `log10` si la precision visual lo permite.
- Devolver parches de textura tras reparacion en vez de espectrograma paginado completo. Ya existe `update_stft_range_multichannel`; falta que el IPC preserve esa granularidad hasta WebGL.
- Reutilizar planes FFT y ventanas por `(fft_size, window_type)` en backend. Ahora se crean planificador/ventana en cada STFT local y actualizacion parcial.
- Para playback, evitar clonar todo el audio por seek. Alternativas: fuente custom sobre `Arc<[f32]>`, slicing por offset, o buffer compartido versionado.
- Paralelizar `get_paged_spectrogram` en el downsample por columnas destino; ahora es triple loop secuencial.

## 5. Deuda Tecnica Priorizada

P0:
- Reducir duracion de locks en comandos Tauri. Tomar snapshots/Arc/versiones y soltar locks antes de DSP pesado; bloquear escritura solo al consolidar resultados.
- Eliminar clone completo de audio en playback/seek. Este es un riesgo directo de latencia y memoria.
- Sustituir `unwrap()` criticos por errores controlados en paths DSP/Tauri.

P1:
- Separar `dsp.rs` por dominios: STFT, detectores, reparacion, features, export, tests.
- Separar `SpectrogramGL.jsx`: shader/canvas, ruler loop, overlays, seleccion, settings.
- Introducir cache STFT por canal o estructura espectral multicanal.
- Cambiar reparacion IPC a respuesta incremental de textura cuando sea posible.

P2:
- Reducir logs de produccion (`console.log`/`println!`) o gatearlos por debug flag.
- Anadir tests DSP mas amplios: clicks/pops/hum/hiss/dropouts, bordes de buffer, NaN safety, undo/redo.
- Alinear comentarios desactualizados: `App.jsx` menciona Web Workers simulando backend, pero la implementacion real usa Tauri/Rust.
- Revisar comandos/structs no usados o redundantes como `aplicar_reparacion_quirurgica` y `RepairResponse`.

Conclusion: la arquitectura coincide bastante con `AGENTE_CONTEXTO.md`: Rust conserva el audio pesado, React evita PCM masivo y WebGL renderiza la matriz. El mayor riesgo actual no esta en el shader, sino en copias y locks del backend durante analisis/reparacion/playback.
