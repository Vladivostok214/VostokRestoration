# AUDITORÍA TÉCNICA ESTÁTICA — `detectar_hum()`
> **Archivo:** `src-tauri/src/vostok_dsp/detectors.rs` · Líneas 643–762
> **Modo:** Auditoría estática completada. Correcciones EXP-HUM-01 y EXP-HUM-02 aplicadas y validadas por QA.
> **Evidencia empírica original:**
> - Ground Truth: `26.94s → 36.88s` (~9.9 segundos)
> - Reporte Vostok (antes): `00.043s → 50.453s` (~50.4 segundos)
> - Reporte Vostok (después): Evento real detectado correctamente ~26.6s
> - Reproducible en: música electrónica y voz en off

---

## RESUMEN EJECUTIVO

El detector presenta **tres familias de problemas estructurales** que actúan en cadena:

1. Un umbral de pico demasiado bajo que activa el detector con señal musical normal
2. Una `gap_tolerance` de 120 frames que fusiona segmentos separados hasta 2.78 segundos
3. Ausencia de contexto espectral global: el detector mide el pico relativo a 4 vecinos cercanos, sin compararlo contra el nivel de energía del resto del espectro

El resultado observado (`0.043s → 50.453s`) es consistente con que el detector se activa en el primer frame del archivo, **nunca cierra el segmento** durante más de 120 frames consecutivos, y cierra solo al final del archivo.

---

## HALLAZGOS PRIORIZADOS (Mayor → Menor probabilidad de causar los síntomas)

---

### 🔴 #1 — `gap_tolerance = 120` frames: FUSIÓN MASIVA DE SEGMENTOS

**Línea:** 700

```rust
let gap_tolerance = 120; // Tolerar hasta ~2.5 segundos de silencio/enmascaramiento
```

**Descripción:**
Con `hop_size = 1024` y `sample_rate` típico de 44100 Hz:

```
1 frame = 1024 / 44100 ≈ 23.2 ms
120 frames = 120 × 23.2 ms ≈ 2.78 segundos de tolerancia al silencio
```

Si el hum detectado a `t=2` deja de detectarse en `t=3`, el contador `gap_counter` se incrementa, pero el segmento no se cierra hasta que pasen **120 frames ininterrumpidos sin detección**. En práctica, cualquier reaparición esporádica del pico —causada por contenido musical en 50/60/100 Hz— reinicia el contador a cero y extiende el segmento indefinidamente.

**Impacto esperado:**
Un único frame activo cada ~2.5 segundos mantiene el segmento abierto eternamente. En música electrónica con sub-bajos o kicks en 50/60 Hz, esto garantiza que el segmento nunca se cierra hasta el final del archivo.

**Severidad:** 🔴 ALTA
**Probabilidad de explicar el resultado observado:** MUY ALTA (explica directamente `0.043s → 50.453s`)

> ✅ **RESUELTO — EXP-HUM-01** `gap_tolerance: 120 → 15` (~348 ms)
> **Resultado QA:** El evento único se fragmentó en 7 eventos independientes. El evento real (~26.6s) fue detectado correctamente. Hipótesis #1 confirmada.

---

### 🔴 #2 — `peak_threshold` mínimo de 1.2x: UMBRAL EXCESIVAMENTE BAJO

**Línea:** 669

```rust
let peak_threshold = 2.0 - (sensitivity * 0.8);
```

**Descripción:**
- Con `sensitivity = 1.0` (máxima): `peak_threshold = 1.2`
- Con `sensitivity = 0.0` (mínima): `peak_threshold = 2.0`

Un umbral de **1.2x** significa que el bin de hum solo necesita ser 20% más alto que el promedio de sus 4 vecinos espectrales para activar la detección. En música electrónica y voz:

- Los bajos instrumentales (bajo eléctrico, kick, resonancias de sala) generan energía concentrada en 50–120 Hz de forma completamente natural
- La voz tiene componentes fundamentales y formantes en 100–200 Hz
- Una nota musical en 60 Hz crea un pico **mucho** mayor a 1.2x sobre sus vecinos

Un hum real de red eléctrica tiene típicamente un SNR de 20–40 dB sobre el ruido de fondo. En presencia de contenido musical, un umbral de 1.2x es prácticamente indistinguible del contenido legítimo.

**Impacto esperado:**
Activa el detector en casi cualquier frame con contenido musical en las frecuencias objetivo.

**Severidad:** 🔴 ALTA
**Probabilidad de explicar el resultado observado:** MUY ALTA

> ✅ **RESUELTO — EXP-HUM-02** `peak_threshold: [1.2x–2.0x] → [3.0x–6.0x]`
> `let peak_threshold = 6.0 - (sensitivity * 3.0);`
> **Resultado QA:** Los 6 falsos positivos residuales de EXP-HUM-01 fueron eliminados. El hum real se mantuvo detectado. Hipótesis #2 confirmada.

---

### 🔴 #3 — VECINOS ESPECTRALES INADECUADOS: Solo ±2/±3 bins sin contexto global

**Línea:** 684

```rust
let neighbors_avg = (mags[bin - 3] + mags[bin - 2] + mags[bin + 2] + mags[bin + 3]) * 0.25;
```

**Descripción:**
El contexto espectral usado para calcular el umbral local son solo **4 bins**, a ±2 y ±3 posiciones del bin objetivo.

```
resolución de bin = 44100 / 4096 ≈ 10.77 Hz por bin
bins ±3 = ±32 Hz de contexto total
```

Esto presenta dos problemas simultáneos:

1. **Bin leakage espectral:** Los bins ±1 se excluyen correctamente (energía de fuga del mismo pico). Pero los bins ±2 y ±3 pueden contener energía de fuga de un pico musical ancho. En frames donde los vecinos son casi cero (silencio espectral local), cualquier señal en 50/60 Hz supera el umbral fácilmente.

2. **Sin contexto global:** El detector no sabe si el pico en 60 Hz representa el 90% de la energía total del frame (hum real) o el 5% (presencia incidental en música con graves fuertes). Ambos casos pueden activar la detección si superan 1.2x a sus 4 vecinos cercanos.

**Impacto esperado:**
En frames con poca energía espectral local adyacente, cualquier contenido en 50/60 Hz activa el detector aunque sea energía legítima del material.

**Severidad:** 🔴 ALTA
**Probabilidad de explicar el resultado observado:** ALTA

---

### 🟠 #4 — `val > 0.001`: UMBRAL ABSOLUTO CASI NULO

**Línea:** 686

```rust
if val > neighbors_avg * peak_threshold && val > 0.001 {
```

**Descripción:**
El umbral absoluto de `0.001` corresponde a **-60 dBFS**. Es prácticamente el piso de ruido de cuantificación de un archivo de 16-bit. Este filtro fue concebido para evitar activaciones en silencio digital total, pero en cualquier grabación con contenido audible, prácticamente todo frame supera `0.001`.

La condición `val > 0.001` nunca actúa como filtro efectivo en el 99% de materiales reales.

**Severidad:** 🟠 MEDIA
**Probabilidad de explicar el resultado observado:** BAJA-MEDIA (agravante, no causa raíz)

---

### 🟠 #5 — `duration_frames >= 70`: UMBRAL DE DURACIÓN MÍNIMA INEFECTIVO

**Línea:** 720

```rust
if duration_frames >= 70 {
```

```
70 frames × 23.2 ms/frame ≈ 1.624 segundos mínimos
```

**Descripción:**
El umbral de 1.5 segundos fue diseñado para filtrar notas musicales de paso. Sin embargo, dado que `gap_tolerance = 120` actúa *antes* de este filtro, los segmentos que llegan a esta comprobación ya están inflados por la fusión de huecos. Un segmento de activación real de 0.2 segundos que tiene activaciones esporádicas cada 2 segundos puede superar los 70 frames fácilmente por las razones descritas en #1.

En música electrónica con loops repetitivos (kicks cada 0.5–1 segundo), el patrón de activación/silencio generado coincide exactamente con lo que `gap_tolerance` está diseñado a ignorar, haciendo que `duration_frames >= 70` no discrimine nada.

**Severidad:** 🟠 MEDIA
**Probabilidad de explicar el resultado observado:** MEDIA (consecuencia de #1)

---

### 🟡 #6 — `break` PREMATURO: ARMÓNICOS ACTIVAN SIN FUNDAMENTAL

**Líneas:** 677–691

```rust
for &(freq, bin) in &hum_bins {
    if ... {
        freq_found = Some(freq);
        break;  // detiene en la primera frecuencia que supera el umbral
    }
}
```

**Descripción:**
El array `target_frequencies = [50.0, 60.0, 100.0, 120.0, 150.0, 180.0]` se itera en orden ascendente y se rompe en el primer hit. Esto significa:

1. Un frame donde solo el bin de 100 Hz está activo (armónico de nota musical en 50 Hz) se registra como hum aunque el fundamental en 50 Hz no esté presente.
2. Los armónicos 100/120/150/180 Hz son especialmente problemáticos en voz masculina, viola y cello, donde estos son componentes fundamentales del material, no armónicos de hum.

**Severidad:** 🟡 BAJA-MEDIA
**Probabilidad de explicar el resultado observado:** MEDIA (agravante secundario)

---

### 🟡 #7 — AUSENCIA DE NORMALIZACIÓN ESPECTRAL GLOBAL

**Descripción:**
El detector no calcula ni usa la energía total del frame como referencia. No existe ninguna comprobación de tipo:

```
energía_en_50Hz / energía_total_frame > umbral_relativo_global
```

Un hum electromagnético real tiene energía concentrada en frecuencias muy específicas mientras el resto del espectro es relativamente plano. Música o voz tiene distribución espectral compleja y densa. Sin normalización global, el detector es estructuralmente ciego a esta diferencia.

**Severidad:** 🟡 MEDIA
**Probabilidad de explicar el resultado observado:** MEDIA (causa estructural independiente)

---

### 🟡 #8 — `frame_hum_freq` NO PERSISTE LA FRECUENCIA DURANTE HUECOS

**Líneas:** 711–735

**Descripción:**
Durante los frames de `gap_counter`, la variable `current_freq` no se actualiza. Si la frecuencia dominante cambia entre sub-segmentos fusionados (ej: 50 Hz en el primero, 100 Hz en el segundo), el evento reporta la frecuencia del inicio del segmento original. Esto afecta la calidad de la reparación posterior: el notch IIR se aplica en la frecuencia equivocada.

**Severidad:** 🟡 BAJA (calidad de reparación, no de detección)
**Probabilidad de explicar el resultado observado:** NULA para la extensión temporal

---

### 🟢 #9 — ARITMÉTICA DE `duration_frames` EN EDGE CASE DE GAP

**Línea:** 717

```rust
let duration_frames = (t - gap_counter) - start_frame + 1;
```

**Descripción:**
Si `gap_counter` acumuló frames que reiniciaron el contador a cero en el medio del segmento, la aritmética puede producir un `duration_frames` ligeramente incorrecto. Es un edge case de precisión menor, no una causa del problema principal.

**Severidad:** 🟢 BAJA
**Probabilidad de explicar el resultado observado:** NULA

---

## TABLA RESUMEN

| # | Componente | Severidad | Prob. de causar síntoma | Estado |
|---|---|---|---|---|
| 1 | `gap_tolerance = 120` frames (~2.78s de fusión) | 🔴 ALTA | MUY ALTA | ✅ RESUELTO (EXP-HUM-01) |
| 2 | `peak_threshold` mín. 1.2x (demasiado permisivo) | 🔴 ALTA | MUY ALTA | ✅ RESUELTO (EXP-HUM-02) |
| 3 | Solo 4 vecinos ±2/±3 bins sin contexto espectral global | 🔴 ALTA | ALTA | ⏳ Pendiente |
| 4 | `val > 0.001` floor guard inefectivo (-60 dBFS) | 🟠 MEDIA | BAJA-MEDIA | ⏳ Pendiente |
| 5 | `duration_frames >= 70` no filtra por inflación de huecos | 🟠 MEDIA | MEDIA | ⏳ Pendiente |
| 6 | `break` prematuro: armónicos activan sin fundamental | 🟡 BAJA-MEDIA | MEDIA | ⏳ Pendiente |
| 7 | Sin normalización espectral global del frame | 🟡 MEDIA | MEDIA | ⏳ Pendiente |
| 8 | Frecuencia no persiste durante huecos tolerados | 🟡 BAJA | NULA | ⏳ Pendiente |
| 9 | Aritmética `duration_frames` en edge case de gap | 🟢 BAJA | NULA | ⏳ Pendiente |

---

## HIPÓTESIS DE CADENA CAUSAL (caso observado)

El resultado `00.043s → 50.453s` se explica por la siguiente cadena determinista:

```
1. peak_threshold = 1.2x activa en el primer frame del archivo
   (primer kick o sub-bajo de música electrónica en 50/60/100Hz)

2. inside_hum = true, start_frame = ~2 (~0.043s)

3. Contenido musical genera activaciones esporádicas en 50/60/100Hz
   pero nunca durante 120 frames consecutivos (2.78s) sin activación alguna

4. gap_counter nunca alcanza 120 → el segmento NUNCA cierra

5. Al final del archivo: inside_hum = true → cierre por bloque final
   start_sample ≈ frame 2 × 1024 / 44100 ≈ 0.046s
   duration = (num_frames - 2) × 1024 ≈ duración total del archivo

6. Se reporta UN ÚNICO EVENTO: 00.043s → 50.453s
```

---

> Auditoría estática completada. Correcciones EXP-HUM-01 y EXP-HUM-02 implementadas y validadas por QA 2026-06-19.
> Hallazgos #3–#9 permanecen pendientes de evaluación futura.
> Si aparecen nuevos falsos positivos en otros materiales, investigar en orden de prioridad: #3, #7, #6.
