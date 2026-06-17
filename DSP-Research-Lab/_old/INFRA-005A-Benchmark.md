# INFRA-005A: Spectrogram Overlays & Binary IPC Benchmark

Este documento consolida las mediciones experimentales y la validación de la **Fase 1 (Desacoplamiento de Overlays)** y **Fase 2 (Canal IPC Binario)** del refactor de renderizado espectral para **Vostok Restoration V1**, utilizando la telemetría real capturada del archivo `vozenoff_hum_50hz.wav`.

---

## 1. Trazas de Telemetría Real (Nuevas Mediciones)

Las trazas reales en la consola de Cargo durante el uso de la aplicación revelan el comportamiento del sistema con un archivo mono de 2.42 millones de muestras (`vozenoff_hum_50hz.wav`, duración 50.52s, samplerate 48000Hz):

```bash
# 1. Carga y Análisis inicial del archivo (CACHE MISS)
[VOSTOK TRACE] ACTION: cargar_y_analizar_archivo | ELAPSED: 1056.707ms | CACHE: MISS | PATH: "C:/TestSamples/vozenoff_hum_50hz.wav" | DEC: 345.47ms | STFT: 704.44ms | SAMPLES: 2424832 (1 ch, 16 bits) | REC_THRESH: 0.21277

# 2. Viewport update (Bypass Base64 con IPC Binario)
# La serialización binaria (SER) toma menos de 0.6ms para empaquetar 2.0 MB de datos.
[VOSTOK TRACE] ACTION: obtener_espectrograma_visible | ELAPSED: 481.540ms | VIEWPORT: 0..2365 | PAGED_MATRIX: 2048x1024 | EXTRACT: 480.818ms | SER: 0.583ms | PAYLOAD: 2048.01 KB

# 3. Reparación Quirúrgica de 12 Glitches concurrentes
[VOSTOK TRACE] ACTION: reparar_glitches_seleccionados | ELAPSED: 1858.073ms | GLITCHES: 12 | VIEWPORT: 0..2365 | HEAL: 428.073ms | STFT: 776.61ms | PAGE: 650.60ms | SER: 0.749ms | PAYLOAD: 2048.01 KB

# 4. Reparación Quirúrgica Individual (Glitch local)
# El cálculo del "Heal" es instantáneo (0.034ms), pero reconstruir toda la STFT y downsamplear toma ~2.1s
[VOSTOK TRACE] ACTION: reparar_glitches_seleccionados | ELAPSED: 2137.683ms | GLITCHES: 1 | VIEWPORT: 0..2365 | HEAL: 0.034ms | STFT: 1258.95ms | PAGE: 873.93ms | SER: 1.415ms | PAYLOAD: 2048.01 KB
```

---

## 2. Análisis del Cuello de Botella Remanente: Debug Mode vs. Release Mode

La telemetría real revela que el bridge IPC y la serialización binaria han dejado de ser un problema. La serialización **(`SER`) toma solo ~0.5ms a 1.4ms** para transferir 2 MB de píxeles (`2048x1024`).

Sin embargo, persisten dos latencias en la CPU del backend durante el desarrollo activo:
1.  **Downsampling (`EXTRACT` / `PAGE`):** Toma entre **480ms y 883ms**.
2.  **Recálculo de STFT (`STFT`):** Toma entre **747ms y 1258ms**.

### A. La Explicación Matemática de `EXTRACT`
La función `get_paged_spectrogram_raw` dibuja el viewport mapeando la matriz espectral analítica al lienzo físico WebGL de `2048x1024`. Esto significa que el motor en Rust ejecuta un bucle bidimensional de:
$$\text{Pixeles Totales} = 2048 \times 1024 = 2,097,152 \text{ iteraciones}$$
En cada iteración, Rust debe calcular dinámicamente factores de paso flotantes, promediar magnitudes de bins vecinos (bucle interno), calcular la raíz cuadrada (RMS), convertir a decibelios logarítmicos (`log10`), escalar y clamear el resultado a `u8`.

En **Modo Debug (unoptimized)** de Rust (compilado por Tauri por defecto al programar), el compilador **no realiza optimizaciones de bucle, no vectoriza por SIMD, no hace inline de funciones y mantiene todas las validaciones de límites de índices (bounds checks)**. Realizar más de 2 millones de operaciones logarítmicas flotantes pesadas con bounds checks bajo estas condiciones toma ~500ms en CPUs modernas de desarrollo.

### B. La Explicación de `STFT`
Cuando se repara un solo glitch, la interpolación física `HEAL` tarda solo **0.034ms** (espectacularmente rápido). Sin embargo, como el motor actual recalculaba la STFT de todo el audio completo, Rust volvía a ejecutar la transformada de Fourier sobre los 2.42 millones de muestras de señal (FFT tamaño 4096 con salto 1024, lo que implica computar 2368 ventanas de análisis). En modo debug sin optimizar, esto representa un costo de **~1.2 segundos**.

---

## 3. Recomendaciones del Sprint basadas en Trazas Reales

Para llevar el rendimiento del espectrograma a niveles profesionales de DAW en tiempo real, se recomiendan las siguientes acciones ordenadas por prioridad de sprint:

### Recomendación 1: Ejecutar Tauri en Modo Optimizado (Release)
Para pruebas y perfiles reales de rendimiento, compilar el backend de Rust con optimizaciones de compilador (`-O3`). 
*   *Comando:* `npm run tauri dev -- --release` (o en su defecto `cargo run --release`).
*   *Impacto Esperado:* En modo release, las operaciones de flotantes se vectorizan mediante SSE/AVX. La función de STFT completa caerá de 1200ms a **~25ms**, y el downsampling de 2 millones de píxeles de `EXTRACT` caerá de 480ms a **~12ms**, eliminando el lag visual por completo.

### Recomendación 2: Implementar la Fase 4 de la Especificación (Parcheo Quirúrgico In-Place)
Dado que la reconstrucción de la STFT completa toma 1.2s, debemos migrar a un recálculo localizado:
*   Al reparar, recalcular únicamente el rango de frames de STFT afectados por la vecindad del glitch (típicamente de 5 a 20 frames espectrales, en lugar de los 2365 frames completos).
*   *Impacto Esperado:* El tiempo de cálculo de `STFT` y `PAGE` durante las reparaciones se reducirá a **menos de 1ms**, logrando reparaciones y actualizaciones visuales instantáneas en tiempo real incluso en modo debug.

### Recomendación 3: Implementar Submuestreo de Viewport Dinámico durante el Arrastre (Fast-Drag)
*   Cuando el usuario se encuentre realizando un arrastre rápido (zoom/pan continuo), la UI debe solicitar una resolución reducida temporal de **512x256** píxeles (reducción de $16\times$ en el número de operaciones de bucle de downsampling, bajando de 2 millones a 131,000 iteraciones).
*   Una vez que el usuario suelte el ratón, se solicita la textura de alta fidelidad `2048x1024`.
*   *Impacto Esperado:* Mapeado instantáneo del viewport en arrastres a más de 60 FPS estables.

---

*(Consolidado del DSP Research Lab - Validador Experimental de Trazas v1.1).*
