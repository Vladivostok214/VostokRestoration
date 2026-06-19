# AUDITORÍA GLOBAL DE DETECTORES — Vostok Restoration V1
> **Archivo auditado:** `src-tauri/src/vostok_dsp/detectors.rs` (1196 líneas)
> **Modo:** Solo lectura. Sin modificaciones. Sin propuestas de implementación.
> **Fecha:** 2026-06-19
> **Referencia previa:** `AUDITORIA_DETECTAR_HUM.md` (hallazgos #1 y #2 ya resueltos)

---

## FASE 1 — INVENTARIO DE DETECTORES

| # | Función | Líneas | Anomalía | Método Principal | Dominio |
|---|---|---|---|---|---|
| 1 | `detectar_clicks()` | 131–444 | Clicks e impulsos | Residuo LPC + HFER + Score de confianza | Híbrido |
| 2 | `detectar_pops()` | 447–515 | Pops y Low Thumps | Dominancia de energía baja + crest factor | Espectral |
| 3 | `detectar_clipping()` | 518–557 | Saturación digital | Detección de muestras en límite ±0.99 | Temporal |
| 4 | `detectar_dropouts()` | 560–641 | Caídas de señal | RMS local vs. promedio móvil | Temporal |
| 5 | `detectar_hum()` | 644–762 | Hum 50/60 Hz + armónicos | Picos espectrales + agrupación temporal | Espectral |
| 6 | `detectar_hiss()` | 765–886 | Siseo de alta frecuencia | Planitud espectral en zona >5 kHz | Espectral |

**Funciones auxiliares (no detectores directos):**
- `extract_features()` L7–127: extractor de características multidominio (RMS, ZCR, crest factor, centroide espectral, flatness, flux)
- `consolidar_y_correlacionar_contextualmente()` L979–1043: post-filtro cross-detector (elimina clicks en flancos de dropouts y dentro de zonas de clipping)
- `consolidar_canales_glitches()` L1046–1107: deduplicación estéreo L+R → "Ambos"
- `ejecutar_analisis_dsp_mono()` L889–973: orquestador mono con Rayon
- `ejecutar_analisis_dsp()` L1110–1140: orquestador estéreo con de-interleave por canal

---

## FASE 2 & 3 — ANÁLISIS INDIVIDUAL Y HALLAZGOS

---

### DETECTOR 1 — `detectar_clicks()`

**Método:** Predicción Lineal Autorregresiva (LPC) → residuo → detección de picos estadísticos. Pipeline de 6 filtros en cascada: compuerta de energía, aislamiento Dirac, discriminación musical, HFER espectral, coherencia de fase, pureza espectral (whiteness), score de confianza probabilístico.

**Supuestos DSP:**
- El audio en segmentos normales es modelable por un predictor AR de orden 16
- Los clicks son discontinuidades estadísticamente anómalas en el residuo
- Los glitches digitales tienen espectro de banda ancha (ruido blanco)

**Umbrales críticos:**
```
std_multiplier     = 14.0 - (sensitivity × 10.0)  → [4.0 – 14.0]
min_absolute_delta = 0.04 - (sensitivity × 0.03)   → [0.01 – 0.04]
min_physical_delta = 0.03 - (sensitivity × 0.025)  → [0.005 – 0.03]
ratio_threshold    = 4.0 - (sensitivity × 2.5)     → [1.5 – 4.0]
next2_threshold    = 0.3 + (sensitivity × 0.5)     → [0.3 – 0.8]
transient_duration_max = 12 muestras
confidence_score_min   = 0.7
```

#### 🟡 HALLAZGO C-1 — Score de confianza con distribución desequilibrada

**Descripción:**
El score se construye con tres componentes: LPC (0.4), whiteness (0.3), fase (0.3). El umbral mínimo es 0.7. Esto significa que para activar un evento se requiere una combinación de al menos dos evidencias. Sin embargo, la ponderación de LPC (0.4) es la más alta, por lo que un error LPC masivo + cualquier otra evidencia siempre activa el detector, incluso si la fase es coherente (musical) y el espectro no es blanco (percusión coloreada).

**Severidad:** 🟡 BAJA-MEDIA
**Probabilidad de impacto real:** BAJA en audio limpio. MEDIA en percusión con ataques fuertes en archivos de alta sensibilidad.
**Síntoma esperado:** Falsos positivos aislados en ataques de percusión o platillos con alta energía de residuo LPC.

---

#### 🟡 HALLAZGO C-2 — `block_size = 2048` con `hop_size = 1024`: Resolución temporal asimétrica

**Descripción:**
Los bloques de 2048 muestras (~46ms a 44.1kHz) con solapamiento de 1024 (~23ms) son adecuados para clicks cortos. Sin embargo, si un click ocurre cerca del final de un bloque, puede ser modelado parcialmente por el predictor LPC del bloque siguiente, reduciendo la amplitud del residuo y generando un **falso negativo** (click no detectado).

**Severidad:** 🟡 BAJA-MEDIA
**Probabilidad de impacto real:** BAJA (el solapamiento de 50% mitiga la mayoría de casos).
**Síntoma esperado:** Clicks en la frontera exacta entre bloques pueden pasar desapercibidos.

---

#### 🟢 EVALUACIÓN GENERAL — `detectar_clicks()`

El detector de clicks es el más sofisticado del archivo. El pipeline de 6 filtros en cascada, el score de confianza probabilístico y la gestión de modos Voz/Música son ejemplos de diseño maduro. Los dos hallazgos identificados son de baja severidad y baja probabilidad de impacto en uso normal.

**Veredicto: SÓLIDO**

---

### DETECTOR 2 — `detectar_pops()`

**Método:** Por cada frame STFT, verifica si la energía en bajos (<150 Hz) domina el total (>80%), si hay crest factor alto (>5.0) y si el RMS es 3x el global. Agrupa frames consecutivos en eventos.

**Supuestos DSP:**
- Un pop de baja frecuencia tiene energía concentrada bajo 150 Hz
- El crest factor de un transitorio de baja frecuencia supera 5.0
- El RMS local supera en 3x el RMS global del archivo

**Umbrales críticos:**
```
k_150            = bin en 150 Hz (~14 bins a 44.1kHz con FFT 4096)
low_energy_ratio = >0.80 (80% de energía bajo 150 Hz)
crest_factor     = >5.0
rms_multiplier   = >3.0 × global_rms
```

#### 🔴 HALLAZGO P-1 — Sin parámetro de sensibilidad: umbral fijo e inamovible

**Descripción:**
`detectar_pops()` es el único detector del archivo que **no recibe `sensitivity`** como parámetro. Los tres umbrales (`low_energy_ratio > 0.80`, `crest_factor > 5.0`, `rms_multiplier > 3.0`) son fijos e invariables. El usuario no puede calibrar la sensibilidad del detector de pops desde la UI.

**Severidad:** 🔴 ALTA
**Probabilidad de impacto real:** ALTA — en material con bajos muy prominentes (música electrónica con sub-bass, doble bombo), el RMS local puede superar fácilmente 3x el RMS global.
**Síntoma esperado:** Falsos positivos frecuentes en música con sub-bajos prominentes. Imposibilidad de ajustar sin tocar el código.

---

#### 🟠 HALLAZGO P-2 — `low_energy_ratio > 0.80`: umbral de dominancia excesivamente permisivo para música electrónica

**Descripción:**
El 80% de energía bajo 150 Hz es un criterio que puede cumplirse fácilmente en frames de kick drum o bass drop de música electrónica. Un kick con fuerte sub-bass puede tener 85-90% de su energía bajo 150 Hz durante el ataque, siendo completamente legítimo.

**Severidad:** 🟠 MEDIA
**Probabilidad de impacto real:** ALTA en música electrónica, BAJA en voz y música acústica.
**Síntoma esperado:** Pops reportados en kicks y sub-bass de música electrónica.

---

#### 🟠 HALLAZGO P-3 — Frecuencia hardcodeada a `75.0 Hz`

**Descripción:**
Todo pop detectado reporta `frequency: Some(75.0)` independientemente de dónde esté realmente la energía máxima del transitorio. Si el motor de reparación usa esta frecuencia para algo (ej: notch o referencia), podría ser impreciso.

**Severidad:** 🟠 MEDIA
**Probabilidad de impacto real:** BAJA (el motor de reparación de pops usa interpolación Hermite, no el campo `frequency`).
**Síntoma esperado:** Información de frecuencia incorrecta en el reporte forense.

---

#### 🟡 HALLAZGO P-4 — Sin `gap_tolerance`: cada frame no detectado rompe el segmento

**Descripción:**
A diferencia de `detectar_hum()` y `detectar_hiss()`, el detector de pops no implementa `gap_tolerance`. Un único frame en que la energía baja no domina interrumpe inmediatamente el segmento. Esto puede fragmentar un pop real con una micro-pausa interna en múltiples eventos.

**Severidad:** 🟡 BAJA
**Probabilidad de impacto real:** BAJA (los pops son transitorios cortos; la fragmentación sería de pocos frames).
**Síntoma esperado:** Un pop largo puede reportarse como 2-3 eventos cortos consecutivos en lugar de uno.

---

### DETECTOR 3 — `detectar_clipping()`

**Método:** Barrido muestra a muestra buscando valores `|sample| >= 0.99`. Agrupa muestras consecutivas con tolerancia de `1e-4`. Filtra eventos de 3 o menos muestras.

**Supuestos DSP:**
- El clipping digital se manifiesta como saturación en ±0.99 (límite de float normalizado)
- Secuencias de muestras "planas" en el límite indican saturación real
- Eventos de ≤3 muestras son ruido de cuantificación

**Umbrales críticos:**
```
limit     = 0.99
tolerance = 1e-4 (diferencia máxima entre muestras consecutivas para considerarlas "planas")
min_count = 4 muestras (>3)
```

#### 🟡 HALLAZGO CL-1 — `tolerance = 1e-4` puede perder clipping con oscilación mínima

**Descripción:**
La tolerancia `1e-4` es muy estricta para agrupar muestras contiguas de clipping. Algunos convertidores ADC con clipping real producen secuencias que oscilan ligeramente alrededor del límite (ej: alternando 0.9999 y 0.9998), con diferencias de ~0.0001. Estas secuencias se fragmentarían en eventos individuales de 1-2 muestras, todos filtrados por el `min_count = 4`.

**Severidad:** 🟡 BAJA
**Probabilidad de impacto real:** BAJA-MEDIA en archivos con conversión analógico-digital de hardware que exhibe oscilación en saturación.
**Síntoma esperado:** Eventos de clipping real reportados como 0 eventos (falso negativo).

---

#### 🟡 HALLAZGO CL-2 — Sin parámetro de sensibilidad

**Descripción:**
Al igual que `detectar_pops()`, `detectar_clipping()` no recibe `sensitivity`. El umbral `0.99` es fijo. Para archivos normalizados al 100%, cualquier sample que alcance 0.99 activa el detector, sin forma de ajustar la tolerancia.

**Severidad:** 🟡 BAJA
**Probabilidad de impacto real:** BAJA (el límite 0.99 es físicamente correcto para detectar clipping digital real).
**Síntoma esperado:** No hay falsos positivos esperados. Posibles falsos negativos si el clipping está suavemente limitado a 0.95-0.98.

---

#### 🟢 EVALUACIÓN GENERAL — `detectar_clipping()`

El diseño es simple, directo y físicamente correcto. El clipping digital es un fenómeno bien definido y el detector lo trata adecuadamente. Los hallazgos son de baja severidad. Es el detector con menor riesgo del archivo.

**Veredicto: SÓLIDO**

---

### DETECTOR 4 — `detectar_dropouts()`

**Método:** Promedio móvil de RMS sobre ventana de 10 frames (~210ms). Activa un evento cuando el RMS del frame cae bajo un umbral triple: (1) zona activa, (2) nivel -90dBFS, (3) ratio vs. promedio móvil. Filtra eventos fuera de rango 20ms–250ms.

**Supuestos DSP:**
- Un dropout es una caída abrupta de señal que se recupera (no un fade-out)
- La caída es detectable como anomalía respecto al promedio móvil local
- Duración válida: 20ms a 250ms (más corto = no audible, más largo = silencio legítimo)

**Umbrales críticos:**
```
window_frames        = 10 frames (~210ms de ventana de promedio)
drop_ratio_threshold = 0.15 + (sensitivity × 0.35)  → [0.15 – 0.50]
threshold_90db       = 10^(-90/20) ≈ 3.16e-5
zero_crossing_rate   < 0.20
duration_range       = [20ms – 250ms]
```

#### 🔴 HALLAZGO D-1 — `threshold_90db` (~-90 dBFS): condición prácticamente imposible

**Descripción:**
El detector exige que el frame tenga `rms < threshold_90db` (≈3.16e-5, equivalente a -90 dBFS) **además** de estar por debajo del ratio móvil. En la práctica, -90 dBFS es el piso de ruido de un archivo de 16-bit. En archivos de 24-bit, el ruido de fondo es aún menor. Esto significa que para detectar un dropout, la señal debe caer **literalmente a silencio digital absoluto**, no solo "muy por debajo del promedio".

Este criterio demasiado estricto convierte al detector de dropouts en un detector de silencios totales, no de caídas de señal audibles (que pueden ocurrir a -40 o -50 dBFS respecto al material circundante).

**Severidad:** 🔴 ALTA
**Probabilidad de impacto real:** ALTA — la mayoría de dropouts reales de hardware (cabezal de grabadora, degradación de cinta, errores de buffer) no llegan a -90 dBFS. El detector subdetecta casi cualquier dropout real que no sea un silencio absoluto.
**Síntoma esperado:** Dropouts reales no detectados (falsos negativos masivos). El detector casi nunca reporta eventos.

---

#### 🟠 HALLAZGO D-2 — Ventana de promedio móvil de 10 frames (~210ms): demasiado corta para audio lento

**Descripción:**
Con 10 frames de ventana a 23.2ms/frame, el promedio móvil representa ~210ms de historia. En música muy lenta (un pad de sintetizador que decae gradualmente) o en una voz con frase muy larga, el promedio móvil puede descender junto con la señal legítima, haciendo que una caída suave no sea detectada como anomalía estadística.

**Severidad:** 🟠 MEDIA
**Probabilidad de impacto real:** MEDIA en música ambiental con decaimientos lentos.
**Síntoma esperado:** Dropouts en pasajes de fade-out lento no detectados.

---

#### 🟡 HALLAZGO D-3 — `zero_crossing_rate < 0.20`: puede excluir dropouts en señales de alta frecuencia

**Descripción:**
La condición `zcr < 0.20` fue diseñada para excluir silencios aparentes que en realidad son señal de alta frecuencia pura (que tiene ZCR alto). Sin embargo, algunos dropouts ocurren en momentos donde el audio circundante tiene componentes de alta frecuencia naturales. Si el dropout aterriza en un frame donde el ZCR histórico es alto, puede no ser detectado.

**Severidad:** 🟡 BAJA-MEDIA
**Probabilidad de impacto real:** BAJA en la mayoría de materiales. MEDIA en audio con mucho contenido de alta frecuencia.
**Síntoma esperado:** Falsos negativos en dropouts de material rico en frecuencias altas.

---

### DETECTOR 5 — `detectar_hum()` *(POST CORRECCIÓN)*

> **Estado:** Hallazgos #1 y #2 resueltos por EXP-HUM-01 y EXP-HUM-02.
> Referencia completa: `AUDITORIA_DETECTAR_HUM.md`.

**Parámetros actuales tras correcciones:**
```rust
let gap_tolerance  = 15;                        // ~348ms (antes: 120 → ~2.78s)
let peak_threshold = 6.0 - (sensitivity * 3.0); // [3.0x – 6.0x] (antes: [1.2x – 2.0x])
```

#### ⏳ HALLAZGO H-3 — Vecinos espectrales: solo ±2/±3 bins (pendiente de evaluación)

Ver `AUDITORIA_DETECTAR_HUM.md` hallazgo #3. No se han observado síntomas tras EXP-HUM-02. Monitorear en materiales con voz masculina grave o cuerdas bajas.

#### ⏳ HALLAZGOS H-4 a H-9 — Pendientes

Ver `AUDITORIA_DETECTAR_HUM.md` hallazgos #4–#9. Sin evidencia empírica de impacto aún.

**Veredicto actual: FUNCIONAL CON RESTRICCIONES CONOCIDAS**

---

### DETECTOR 6 — `detectar_hiss()`

**Método:** Para cada frame STFT, calcula la planitud espectral (Wiener entropy) globalmente y en la zona >5kHz. Activa si ambas planitudes superan el umbral. Agrupa frames con `gap_tolerance = 150`.

**Supuestos DSP:**
- El hiss es ruido espectralmente plano (flatness alta) en altas frecuencias
- La planitud global y local deben ser simultáneamente altas
- Debe ser energéticamente audible (`rms > 0.01`)

**Umbrales críticos:**
```
flatness_threshold = 0.45 - (sensitivity × 0.15)  → [0.30 – 0.45]
high_freq_start    = 5000 Hz (bin ~465 con FFT 4096 a 44.1kHz)
rms_threshold      = 0.01 (fijo, ~-40 dBFS)
gap_tolerance      = 150 frames (~3.48 segundos)
duration_min       = 90 frames (~2.09 segundos)
```

#### 🔴 HALLAZGO HS-1 — `gap_tolerance = 150` frames: mismo problema estructural que el Hum original

**Descripción:**
`gap_tolerance = 150` equivale a **~3.48 segundos** de tolerancia al silencio espectral. Esto es incluso peor que el Hum original (120 frames). Cualquier material musical con contenido de alta frecuencia moderadamente plano (hi-hats, platillos, síntesis) que aparezca cada ~3 segundos mantendrá el segmento abierto indefinidamente.

```
150 frames × 23.2 ms/frame = 3.48 segundos de tolerancia
```

**Severidad:** 🔴 ALTA
**Probabilidad de impacto real:** MUY ALTA — por analogía directa con EXP-HUM-01. Cualquier material musical con platillos, shakers o síntesis de alta frecuencia generará un evento de duración total del archivo.
**Síntoma esperado:** 1 evento Hiss = duración total del archivo en casi cualquier material musical.

---

#### 🔴 HALLAZGO HS-2 — `flatness_threshold` mínimo de 0.30: demasiado permisivo

**Descripción:**
Con `sensitivity = 1.0`: `flatness_threshold = 0.30`. Una planitud de 0.30 es moderada y puede alcanzarse fácilmente en:
- Platillos de batería (espectro relativamente plano en altas frecuencias)
- Síntesis de pad con contenido de alta frecuencia
- Reverb con mucho brillo
- Audio masterizado con realce de presencia

El hiss de cinta real tiene planitud típicamente >0.60–0.80 (casi ruido blanco). Una planitud de 0.30 no discrimina hiss de platillos.

**Severidad:** 🔴 ALTA
**Probabilidad de impacto real:** ALTA en música con platillos, MEDIA en voz con sibilancias.
**Síntoma esperado:** Falsos positivos en platillos, hi-hats, síntesis brillante y audio con realce de presencia.

---

#### 🟠 HALLAZGO HS-3 — `feat.spectral_flatness` (global) usado como criterio primario

**Descripción:**
La condición `feat.spectral_flatness > flatness_threshold` evalúa la planitud **de todo el espectro**, no solo de la zona de alta frecuencia. Esto puede activar la detección incluso cuando el espectro de alta frecuencia no es particularmente plano, si el espectro global tiene alta planitud (ej: audio sin DC con distribución espectral uniforme).

El criterio correcto debería ser: planitud alta **exclusivamente en la zona >5kHz**. La condición `local_flatness > flatness_threshold` ya hace esto, pero requiere que **ambas** condiciones sean verdaderas. Sin embargo, la flatness global puede ser alta por razones completamente ajenas al hiss.

**Severidad:** 🟠 MEDIA
**Probabilidad de impacto real:** MEDIA en material con distribución espectral uniforme.
**Síntoma esperado:** Activaciones en audio sin hiss real donde el espectro global es plano.

---

#### 🟠 HALLAZGO HS-4 — Frecuencia hardcodeada a `8000.0 Hz`

**Descripción:**
Todo evento Hiss reporta `frequency: Some(8000.0)` independientemente del perfil espectral real. El hiss de cinta puede tener su energía dominante en 6kHz, 10kHz o 16kHz según el tipo de cinta y la velocidad. Si el motor de reparación usa esta frecuencia para configurar el High-Shelf, aplicará siempre a 8kHz aunque el hiss real esté concentrado en otra frecuencia.

**Severidad:** 🟠 MEDIA
**Probabilidad de impacto real:** MEDIA — afecta la precisión de la reparación, no la detección.
**Síntoma esperado:** High-Shelf aplicado en frecuencia incorrecta. Puede sobre-atenuar o sub-atenuar según el caso.

---

#### 🟡 HALLAZGO HS-5 — `rms > 0.01`: umbral fijo de ~-40 dBFS

**Descripción:**
El filtro `feat.rms > 0.01` evita activaciones en silencio. Sin embargo, -40 dBFS es un valor conservador que podría excluir hiss de muy baja amplitud (hiss sutil en archivos de alta dinámica) o en momentos de señal débil.

**Severidad:** 🟡 BAJA
**Probabilidad de impacto real:** BAJA.
**Síntoma esperado:** Hiss muy sutil no detectado en pasajes suaves.

---

## FASE 4 — PRIORIZACIÓN GLOBAL (RANKING DE RIESGO)

---

### 🥇 TOP 1 — `detectar_hiss()`: RIESGO MUY ALTO

**Razón:** Presenta **exactamente los mismos dos problemas estructurales** que el Hum antes de EXP-HUM-01 y EXP-HUM-02, pero agravados:

- `gap_tolerance = 150` (vs. 120 del Hum original) → ~3.48s de fusión (más que el Hum)
- `flatness_threshold` mínimo de 0.30 → más permisivo que el `peak_threshold` original del Hum

La probabilidad de que `detectar_hiss()` esté generando **un único evento de duración total del archivo** en cualquier material musical con contenido de alta frecuencia es **IDÉNTICA** a la del Hum antes de las correcciones. La metodología experimental validada (EXP-HUM-01 → EXP-HUM-02) puede aplicarse directamente con alta confianza de éxito.

---

### 🥈 TOP 2 — `detectar_dropouts()`: RIESGO ALTO (por sub-detección)

**Razón:** El hallazgo D-1 es crítico pero en la dirección opuesta al Hiss: mientras que el Hiss sobre-detecta, el detector de dropouts **sub-detecta**. El umbral de -90 dBFS para el RMS convierte el detector en un identificador de silencios totales, no de caídas de señal audibles. La mayoría de dropouts reales de hardware (cinta, disco, buffer overflow) no llegan a -90 dBFS. El detector tiene utilidad limitada en el mundo real.

---

### 🥉 TOP 3 — `detectar_pops()`: RIESGO MEDIO-ALTO

**Razón:** La ausencia de parámetro `sensitivity` y el umbral de dominancia de bajos del 80% combinados hacen al detector propenso a falsos positivos en música electrónica. El riesgo es real pero localizado en un tipo de material específico.

---

## FASE 5 — PUNTUACIÓN DE MADUREZ

| Detector | Diseño | Robustez | Complejidad | Riesgo FP | Riesgo FN | Madurez |
|---|---|---|---|---|---|---|
| `detectar_clicks()` | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Alta | Baja | Baja | **8.5 / 10** |
| `detectar_clipping()` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐⭐ | Baja | Muy Baja | Baja | **8.0 / 10** |
| `detectar_hum()` | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | Media | Baja* | Baja | **7.5 / 10** |
| `detectar_dropouts()` | ⭐⭐⭐ | ⭐⭐ | Media | Muy Baja | **Muy Alta** | **4.5 / 10** |
| `detectar_pops()` | ⭐⭐⭐ | ⭐⭐⭐ | Baja | Media | Media | **5.0 / 10** |
| `detectar_hiss()` | ⭐⭐ | ⭐ | Media | **Muy Alta** | Media | **3.0 / 10** |

*`detectar_hum()` tras correcciones EXP-HUM-01 y EXP-HUM-02. Puntuación previa: ~3.5/10.

---

## TABLA GLOBAL DE HALLAZGOS

| ID | Detector | Descripción | Severidad | Prob. de impacto |
|---|---|---|---|---|
| HS-1 | Hiss | `gap_tolerance = 150` (~3.48s de fusión) | 🔴 ALTA | MUY ALTA |
| HS-2 | Hiss | `flatness_threshold` mín. 0.30 (demasiado permisivo) | 🔴 ALTA | ALTA |
| D-1 | Dropout | `threshold_90db` prácticamente imposible de cumplir | 🔴 ALTA | ALTA |
| P-1 | Pops | Sin parámetro `sensitivity`: umbrales fijos e inamovibles | 🔴 ALTA | ALTA |
| P-2 | Pops | `low_energy_ratio > 0.80` activa en kicks de música electrónica | 🟠 MEDIA | ALTA |
| HS-3 | Hiss | Flatness global usada como criterio primario en lugar de solo HF | 🟠 MEDIA | MEDIA |
| HS-4 | Hiss | Frecuencia hardcodeada a 8000 Hz (afecta reparación) | 🟠 MEDIA | MEDIA |
| D-2 | Dropout | Ventana de promedio móvil de 10 frames (~210ms) | 🟠 MEDIA | MEDIA |
| P-3 | Pops | Frecuencia hardcodeada a 75.0 Hz | 🟠 MEDIA | BAJA |
| D-3 | Dropout | `zcr < 0.20` puede excluir dropouts en material de alta frecuencia | 🟡 BAJA-MEDIA | BAJA |
| P-4 | Pops | Sin `gap_tolerance`: fragmenta pops largos | 🟡 BAJA | BAJA |
| CL-1 | Clipping | `tolerance = 1e-4` fragmenta clipping con oscilación ADC | 🟡 BAJA | BAJA-MEDIA |
| CL-2 | Clipping | Sin parámetro `sensitivity` | 🟡 BAJA | BAJA |
| C-1 | Clicks | Score de confianza con distribución desequilibrada | 🟡 BAJA-MEDIA | BAJA |
| C-2 | Clicks | Clicks en frontera de bloque pueden perderse | 🟡 BAJA-MEDIA | BAJA |
| HS-5 | Hiss | `rms > 0.01` excluye hiss muy sutil | 🟡 BAJA | BAJA |

---

## RECOMENDACIÓN DE SIGUIENTE ITERACIÓN

Aplicar a `detectar_hiss()` la misma metodología experimental validada en P1.4:

**Paso A:** `gap_tolerance: 150 → N` (por determinar, sugerido ~15 por analogía con Hum)
**Paso B:** `flatness_threshold`: elevar el mínimo desde 0.30 hacia un valor más restrictivo

Investigar `detectar_dropouts()` por separado, ya que el problema es de sub-detección (no de sobre-detección), y requiere una estrategia diferente al abordaje del Hum/Hiss.

---

> Informe generado por auditoría estática. Sin modificaciones al código.
> Próximo paso: priorización de intervenciones bajo aprobación explícita.
