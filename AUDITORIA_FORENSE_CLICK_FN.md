# Auditoría Forense de Falsos Negativos (Clicks Omitidos)
## Vostok Restoration DSP Engine — Investigación LAB-CLICK-005

---

### Resumen Ejecutivo

Esta investigación forense rastrea la ejecución de `detectar_clicks()` para determinar con precisión de muestra individual en qué línea y por qué causa exacta se omiten los 9 Falsos Negativos (FNs) persistentes en el benchmark `vozenoff_DEGRADADO`.

El análisis de la telemetría instrumentada revela una conclusión contundente:
* **8 de los 9 FNs (88.9%)** mueren en la **compuerta LPC / MAD local**. El error residual de predicción lineal (`val_err`) es inferior al umbral adaptativo local (`local_threshold`), el cual se infla de forma natural debido a la energía de las formantes de la voz.
* **1 de los 9 FNs (11.1%)** supera todas las compuertas estadísticas pero es descartado en la validación de la **firma física de Dirac y decaimiento de pico**.
* **HFER y Anti-Sibilancia** no representan el cuello de botella actual para estos eventos ya que mueren de forma mucho más temprana en el pipeline.

No se ha modificado ningún umbral ni lógica de procesamiento en esta fase.

---

### 2. Telemetría y Trazabilidad Individual

A continuación se detalla la traza estadística y física de cada evento omitido en el Ground Truth:

#### GT-001 (4.910s) — CLICK (Magnitud: 1.34)
* **Candidato más cercano**: `time = 4.910s`, `sample_index = 235658`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 4.910s
sample_index = 235658
val_err = 0.009822
local_threshold = 0.192033
val_err/local_threshold = 0.05
spectral_whiteness = 0.460
hfer = 0.9651
min_hfer = 0.0500
avg_delta = 0.020104
delta_ratio = 1.38
transient_duration = 14
confidence_score = 0.30
anti_sibilance_triggered = true

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. FAIL
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: La energía fundamental de la voz a los 4.91s infla el umbral local a un valor masivo de `0.192`. El error del click real es de apenas `0.0098`, por lo que es invisibilizado por el modelo AR.

#### GT-003 (4.974s) — CLICK (Magnitud: 0.91)
* **Candidato más cercano**: `time = 4.974s`, `sample_index = 238730`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 4.974s
sample_index = 238730
val_err = 0.007318
local_threshold = 0.078465
val_err/local_threshold = 0.09
spectral_whiteness = 0.402
hfer = 0.8485
min_hfer = 0.0500
avg_delta = 0.017959
delta_ratio = 0.19
transient_duration = 22
confidence_score = 0.30
anti_sibilance_triggered = true

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. FAIL
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: El error LPC del click (`0.0073`) queda sepultado bajo el umbral de voz local de `0.078`.

#### GT-004 (5.112s) — CLICK (Magnitud: 1.04)
* **Candidato más cercano**: `time = 5.112s`, `sample_index = 245353`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 5.112s
sample_index = 245353
val_err = 0.031066
local_threshold = 0.133896
val_err/local_threshold = 0.23
spectral_whiteness = 0.129
hfer = 0.1658
min_hfer = 0.0500
avg_delta = 0.028229
delta_ratio = 3.59
transient_duration = 60
confidence_score = 0.00
anti_sibilance_triggered = false

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. PASS
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: Oclusión por umbral LPC inflado por la voz en $5.11\text{s}$.

#### GT-005 (5.237s) — CLICK (Magnitud: 0.50)
* **Candidato más cercano**: `time = 5.237s`, `sample_index = 251353`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 5.237s
sample_index = 251353
val_err = 0.026728
local_threshold = 0.183206
val_err/local_threshold = 0.15
spectral_whiteness = 0.276
hfer = 0.4122
min_hfer = 0.0500
avg_delta = 0.038914
delta_ratio = 0.81
transient_duration = 2
confidence_score = 0.00
anti_sibilance_triggered = true

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. FAIL
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: Magnitud física del click muy baja (`0.50`), incapaz de superar un umbral de voz local de `0.183`.

#### GT-008 (12.757s) — CLICK (Magnitud: 1.32)
* **Candidato más cercano**: `time = 12.757s`, `sample_index = 612314`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 12.757s
sample_index = 612314
val_err = 1.321460
local_threshold = 0.080205
val_err/local_threshold = 16.48
spectral_whiteness = 0.243
hfer = 0.4000
min_hfer = 0.0100
avg_delta = 0.012978
delta_ratio = 103.96
transient_duration = 3
confidence_score = 0.70
anti_sibilance_triggered = false

LPC ........ PASS
MAD ........ PASS
DELTA ...... PASS
HFER ....... PASS
SIBILANCE .. PASS
CONFIDENCE . PASS

DECISION FINAL: DESCARTADO: Falla firma de Dirac / Decaimiento de pico
```
* **Diagnóstico**: Este click es masivo (`val_err = 1.32`). Supera todas las compuertas estadísticas y de energía con creces, pero es descartado en la firma de Dirac. El decaimiento o la fase de la forma de onda fue clasificado como "rampa o transitorio coherente" por el detector de envolvente temporal.

#### GT-011 (19.920s) — CLICK (Magnitud: 1.10)
* **Candidato más cercano**: `time = 19.920s`, `sample_index = 956138`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 19.920s
sample_index = 956138
val_err = 0.071633
local_threshold = 0.178025
val_err/local_threshold = 0.40
spectral_whiteness = 0.823
hfer = 8.5348
min_hfer = 0.0500
avg_delta = 0.026006
delta_ratio = 5.33
transient_duration = 10
confidence_score = 0.30
anti_sibilance_triggered = true

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... PASS
HFER ....... PASS
SIBILANCE .. FAIL
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: Oclusión LPC. El click genera un error significativo de `0.071`, pero el umbral de voz está en `0.178`.

#### GT-012 (20.027s) — CLICK (Magnitud: 1.00)
* **Candidato más cercano**: `time = 20.027s`, `sample_index = 961287`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 20.027s
sample_index = 961287
val_err = 0.005026
local_threshold = 0.057911
val_err/local_threshold = 0.09
spectral_whiteness = 0.132
hfer = 0.1556
min_hfer = 0.0500
avg_delta = 0.002588
delta_ratio = 0.71
transient_duration = 15
confidence_score = 0.30
anti_sibilance_triggered = false

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. PASS
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: Oclusión LPC. El error de predicción del click es de apenas `0.0050`, ocultado por el umbral local.

#### GT-013 (20.111s) — CLICK (Magnitud: 0.86)
* **Candidato más cercano**: `time = 20.111s`, `sample_index = 965305`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 20.111s
sample_index = 965305
val_err = 0.007175
local_threshold = 0.107944
val_err/local_threshold = 0.07
spectral_whiteness = 0.139
hfer = 0.1898
min_hfer = 0.0500
avg_delta = 0.022971
delta_ratio = 0.37
transient_duration = 41
confidence_score = 0.00
anti_sibilance_triggered = false

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. PASS
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: Oclusión LPC. El click real queda enmascarado por el umbral de `0.107` de la voz activa.

#### GT-017 (30.304s) — CLICK (Magnitud: 1.00)
* **Candidato más cercano**: `time = 30.304s`, `sample_index = 1454570`
* **Traza de Checkpoints**:
```
[CANDIDATO]
time = 30.304s
sample_index = 1454570
val_err = 0.016682
local_threshold = 0.146433
val_err/local_threshold = 0.11
spectral_whiteness = 0.690
hfer = 6.2184
min_hfer = 0.0500
avg_delta = 0.021626
delta_ratio = 0.62
transient_duration = 19
confidence_score = 0.30
anti_sibilance_triggered = true

LPC ........ FAIL
MAD ........ FAIL
DELTA ...... FAIL
HFER ....... PASS
SIBILANCE .. FAIL
CONFIDENCE . FAIL

DECISION FINAL: DESCARTADO: No supera umbral LPC local
```
* **Diagnóstico**: Oclusión LPC. El click muere en el umbral local inflado a `0.146`.

---

### 3. Tabla Resumen de Falsos Negativos

| GT Event | Tiempo | Muestra | Última Etapa Alcanzada | Motivo Exacto de Descarte |
| :--- | :--- | :--- | :--- | :--- |
| **GT-001** | 4.910s | 235658 | LPC / MAD Gate | `val_err` (0.0098) < `local_threshold` (0.1920) |
| **GT-003** | 4.974s | 238730 | LPC / MAD Gate | `val_err` (0.0073) < `local_threshold` (0.0784) |
| **GT-004** | 5.112s | 245353 | LPC / MAD Gate | `val_err` (0.0310) < `local_threshold` (0.1338) |
| **GT-005** | 5.237s | 251353 | LPC / MAD Gate | `val_err` (0.0267) < `local_threshold` (0.1832) |
| **GT-008** | 12.757s | 612314 | Dirac Signature | Decaimiento de pico / firma envelope inválida |
| **GT-011** | 19.920s | 956138 | LPC / MAD Gate | `val_err` (0.0716) < `local_threshold` (0.1780) |
| **GT-012** | 20.027s | 961287 | LPC / MAD Gate | `val_err` (0.0050) < `local_threshold` (0.0579) |
| **GT-013** | 20.111s | 965305 | LPC / MAD Gate | `val_err` (0.0071) < `local_threshold` (0.1079) |
| **GT-017** | 30.304s | 1454570 | LPC / MAD Gate | `val_err` (0.0166) < `local_threshold` (0.1464) |

---

### 4. Distribución de Causas de FN

* **Porcentaje atribuible a LPC / MAD (Umbral local inflado por voz)**: **88.9%** (8 de 9 eventos).
* **Porcentaje atribuible a Firma de Dirac / Decaimiento**: **11.1%** (1 de 9 eventos).
* **Porcentaje atribuible puramente a HFER o Anti-Sibilancia**: **0%** (ya que los eventos mueren antes de que estos filtros actúen de forma excluyente).

---

### 5. Ranking de Cuellos de Botella Reales

1. **Umbral Adaptativo LPC Inflado en Voz (LPC / MAD)**:
   La mediana absoluta de los residuos (MAD) se eleva a valores de $\approx 0.01$ en bloques vocales activos debido a la imperfección natural del predictor autoregresivo lineal (LPC-16) sobre señales cuasi-periódicas de habla. Al aplicar el multiplicador de sensibilidad, el umbral final eclipsa clicks de magnitud media y baja.
2. **Firma Temporal / Envelope de Dirac**:
   Algunos clicks masivos que superan el umbral (como el de `12.757s`) son rechazados porque la dirección de salida de la señal o la tasa de decaimiento temporal no coincide con el modelo estricto de delta aislado.

---

### 6. Recomendación Fundamentada para LAB-CLICK-006

En la próxima fase de optimización, se recomienda explorar:
1. **Compresión/Atenuación Dinámica del Multiplicador LPC en Regiones Vocales de Alta Energía**:
   Si el RMS de la voz es alto pero la blancura espectral o el predictor detectan una discontinuidad local, permitir que el `std_multiplier` se reduzca dinámicamente de forma proporcional a la energía de la formante vocal, reduciendo el local threshold a rangos de $0.03 - 0.05$.
2. **Relajación de Firma de Dirac en Clicks de Alta Energía**:
   Si el `val_err` supera el umbral local por un factor masivo (ej: $> 8.0$), relajar los requisitos geométricos estrictos del decaimiento temporal o el cambio de dirección de fase, asumiendo que el error del predictor es evidencia física suficiente de discontinuidad.
