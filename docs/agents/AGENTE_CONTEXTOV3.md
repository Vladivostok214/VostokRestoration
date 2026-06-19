# VOSTOK RESTORATION V1 — AGENTE_CONTEXTO_V3
## Fuente de Verdad para Auditorías y Desarrollo DSP

> **Estado de referencia**: Cierre de LAB-CLEANUP-001 (Post LAB-CLASSIFICATION-002 y LAB-CLICK-005)
> **Estado**: Producción funcional certificada por benchmark
> **Última actualización**: Junio 2026

---

# 1. RESUMEN EJECUTIVO

Vostok Restoration V1 es una aplicación nativa de restauración forense de audio construida sobre Tauri + Rust + React. La aplicación está diseñada para identificar y reparar discontinuidades temporales, ruidos estacionarios, soplidos y sub-graves en buffers PCM almacenados en memoria RAM.

Tras finalizar las series de laboratorios de optimización de detectores, el motor DSP ha alcanzado niveles de madurez elevados, logrando un **100% de F1-Score** en anomalías continuas (Hum, Hiss y Dropouts) y un **100% de Recall** en Pops. La investigación actual se enfoca en resolver los conflictos de clasificación Click-Pop y superar la oclusión de clicks de baja amplitud en pasajes de voz activos.

---

# 2. ESTADO ACTUAL DEL PROYECTO (BENCHMARK V2)

Los resultados medidos mediante el script de validación `evaluar_vostok_v2.py` frente al archivo de referencia `vozenoff_DEGRADADO` son los siguientes:

| Detector | TP | FP | FN | Precision | Recall | F1-Score | Estado |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :--- |
| **Hum** | 1 | 0 | 0 | 100.0% | 100.0% | **100.0%** | **Estable** |
| **Hiss** | 1 | 0 | 0 | 100.0% | 100.0% | **100.0%** | **Estable** |
| **Dropout** | 2 | 0 | 0 | 100.0% | 100.0% | **100.0%** | **Estable** |
| **Pop** | 3 | 9 | 0 | 25.0% | 100.0% | **40.0%** | **Funcional (mejorable)** |
| **Click** | 5 | 14 | 9 | 26.3% | 35.7% | **30.3%** | **Funcional con limitaciones** |
| **Clipping**| 0 | 0 | 0 | 0.0% | 0.0% | **0.0%** | **Pendiente de Investigación** |

---

# 3. DETALLE DE DETECTORES Y LABS ASOCIADOS

### A. Hum Electromagnético (LAB-HISS-001)
* **Algoritmo**: Escaneo espectral de frecuencias fijas (50/60 Hz y armónicos) con filtros de comparación local de bins vecinos.
* **Calibraciones Clave**:
  * `gap_tolerance` reducida de 120 a 15 frames (~348ms) para evitar eventos de hum falsamente inflados de larga duración.
  * `peak_threshold` elevado a `6.0 - (sensitivity * 3.0)` (+9.5dB a +15.6dB sobre vecinos) para discriminar armónicos del bajo musical.
* **Limitaciones**: Ninguna detectada en el benchmark actual.

### B. Hiss / Soplido de Alta Frecuencia (LAB-HISS-001)
* **Algoritmo**: Análisis de pureza espectral y planitud espectral local en bandas superiores a 5.0 kHz.
* **Calibraciones Clave**:
  * `gap_tolerance` ajustada a 30 frames para consolidar siseos constantes y tolerar enmascaramientos temporales suaves.
  * Duración mínima elevada a 90 frames (2.0s) para evitar falsos positivos con platillos o sibilancias del habla.
* **Limitaciones**: Ninguna detectada en el benchmark.

### C. Dropouts / Caídas de Señal (LAB-DROPOUT-001 & LAB-DROPOUT-002)
* **Algoritmo**: Migrado del dominio de la frecuencia (STFT) al **dominio temporal**. Utiliza una ventana móvil muy corta de **2.5 ms** y un acumulador de suma de cuadrados de complejidad $O(1)$ para evaluar la caída del RMS respecto al contexto precedente (150 ms).
* **Fortalezas**: Captura caídas micro-temporales profundas de hasta 4.0 ms de duración con precisión de muestra.
* **Limitaciones**: Requiere que el contexto precedente sea una región activa de audio (RMS > 0.0025) para evitar disparar dropouts en silencios de pista legítimos.

### D. Pops / Thumps Sub-graves (LAB-POP-001)
* **Algoritmo**: Evaluado mediante el **Spectral Flux sub-120Hz relativo** contra una ventana de contexto precedente de 8 frames (~185 ms).
* **Fortalezas**: Consigue un Recall perfecto del 100% en eventos de impacto de baja frecuencia.
* **Limitaciones**: Sufre de **falsos positivos** (9 FPs) provocados por dos causas:
  1. Clicks fuertes de banda ancha cuya energía subsónica dispara el detector de Pop.
  2. Transitorios de inicio de voz (plosivas) y entradas súbitas de Hum que simulan la firma física de un thump.

### E. Clicks e Impulsos Rápidos (LAB-CLICK-001 a LAB-CLICK-005)
* **Algoritmo**: Estimación robusta del error de predicción lineal (LPC Autoregresivo de orden 16) utilizando **MAD (Median Absolute Deviation)** como estimador de escala inmune a ráfagas de impulsos.
* **Checkpoints de Validación**:
  1. Filtro dinámico de delta absoluto y relativo (`avg_delta`).
  2. Firma de Dirac (Pico local aislado) con decaimiento estricto de vecinos y límite de duración en modo Voz ($transient\_duration < 6$).
  3. Coherencia de fase direccional (evita falsos positivos en transitorios de percusión armónica).
  4. Relajación dinámica de HFER en modo Voz cuando el error LPC es contundente (`val_err > local_threshold * 2.5`).
* **Limitaciones**: Recall de Click subestimado (35.7%). El principal cuello de botella es la compuerta estadística LPC inicial (MAD): las formantes de la voz de alta energía elevan el MAD local de fondo, ocluyendo clicks de baja amplitud que no logran superar el umbral.

---

# 4. CONCLUSIONES ARQUITECTÓNICAS PERMANENTES

### 1. Consolidación Estéreo por Intervalos
Las anomalías continuas (Hum, Hiss y Dropouts) deben consolidarse en el motor estéreo cruzando la superposición e intersección física de sus intervalos temporales de inicio/fin, en lugar de tolerancias basadas únicamente en distancias puntuales.

### 2. Retardo de Ventana STFT en Pops
Dado que la STFT opera con ventanas de $92.8\text{ ms}$ (`fft_size = 4096`), cualquier detector en bajas frecuencias sufrirá de un retardo grupal inherente de $40-80\text{ ms}$. La tolerancia de cruce en los benchmarks puntuales de Pop debe ser configurada a un margen superior (`POP_TOLERANCE = 0.10s`).

### 3. Conflicto Espectral Click-Pop
Un click es un impulso de banda ancha infinita y, por lo tanto, contiene energía en bajas frecuencias. Los clicks de alta magnitud provocan disparos inevitables en `detectar_pops()`. LAB-CLASSIFICATION-002 demostró la existencia de conflictos duplicados y de reclasificaciones incorrectas.

### 4. Oclusión LPC por Voz
La predicción autoregresiva lineal (LPC) asume estacionariedad en tramas cortas. La señal del habla humana (cuasi-periódica y con fuerte modulación de formantes) produce un error residual natural elevado que infla el umbral MAD, ocluyendo el 88.9% de los clicks no detectados en pasajes de voz activos (confirmado en LAB-CLICK-005).

---

# 5. HERRAMIENTAS DE LABORATORIO

* **`tools/degradar_audio_v2.py`**:
  * *Propósito*: Inyectar de manera controlada y matemática anomalías sintéticas (hiss, pops thumps de 40Hz, hum de 50Hz, dropouts micro-temporales, y clicks de Dirac de magnitudes variables) sobre archivos de voz limpios para construir bases de datos de prueba sintéticas.
* **`tools/evaluar_vostok_v2.py`**:
  * *Propósito*: Script de validación cuantitativa que cruza los reportes generados por la app en formato TXT contra el Ground Truth (CSV). Evalúa eventos puntuales mediante ventanas de coincidencia (50ms para clicks, 100ms para pops) y eventos continuos utilizando métricas de IoU de solapamiento de rangos temporales.

---

# 6. DIRECTRICES ESTRICTAS: NO REINVESTIGAR

Para evitar la regresión y la repetición de esfuerzos, se establecen las siguientes decisiones como definitivas y cerradas:

> [!CAUTION]
> **NO REVERTIR LAS SIGUIENTES TECNOLOGÍAS:**
>
> 1. **No volver al cálculo de Desviación Estándar clásica en LPC**: La estimación robusta por MAD (Median Absolute Deviation) ha demostrado ser el único método que evita el auto-enmascaramiento por agrupamiento de clicks.
> 2. **No utilizar STFT para detectar Dropouts**: El análisis de Fourier es ineficiente y borroso en el dominio temporal. La suma acumulada de cuadrados en ventana temporal de 2.5 ms es la arquitectura permanente para dropouts.
> 3. **No eliminar el filtro HFER en Clicks**: El bypass absoluto de HFER destruye la precisión provocando decenas de falsos positivos en sibilancias (/s/) y fricativas. HFER debe conservarse con su modelo de relajación exponencial adaptativa.
> 4. **No usar dominancia subsónica absoluta en Pops**: El criterio espectral absoluto confunde bombo y voces graves. La detección relativa basada en Spectral Flux con contexto precedente de 8 frames es la regla establecida.
> 5. **No aumentar el gap_tolerance de Hum ni Hiss**: Tolerar más de 15 frames en Hum o 30 frames en Hiss provoca que eventos locales se fusionen incorrectamente, inflando las métricas de duración en el reporte.
