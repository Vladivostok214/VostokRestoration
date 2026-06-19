# Auditoría Técnica: Detector de Dropouts (`detectar_dropouts`)
## Vostok Restoration DSP Engine — Investigación LAB-DROPOUT-001

---

### Resumen Ejecutivo

Este informe documenta la investigación técnica realizada sobre el detector de caídas de señal (dropouts) implementado en [detectors.rs](file:///C:/Users/WLADI/Vostok%20Plugins/DesktopApps/Vostok%20Restoration%20V1/src-tauri/src/vostok_dsp/detectors.rs#L560-L641).

La campaña de validación arrojó un resultado crítico de **Recall = 0%** (0 aciertos de 2 inyecciones). El análisis estático revela una **incompatibilidad estructural severa** entre el generador de degradación y el detector: el generador inyecta dropouts de corta duración (5 a 50 ms), mientras que el detector opera en el dominio espectral/temporal utilizando una ventana FFT demasiado ancha (92.8 ms) y una compuerta de silencio absoluto (-90 dBFS) que imposibilita la detección física de cualquier dropout de corta duración en zonas activas de audio.

---

### 1. Funcionamiento del Detector vs. Generador

La ineficacia del detector se debe a un conflicto directo entre las suposiciones matemáticas del generador y la resolución temporal del detector:

#### El Generador (`degradar_audio_v2.py`):
1. **Modo `real_world`**: Inyecta dropouts de **$5\text{ a }25\text{ ms}$** llevando las muestras a `0.0`.
2. **Modo `all_mixed`**: Inyecta dropouts de **$10\text{ a }50\text{ ms}$** llevando las muestras a `0.0`.

#### El Detector (`detectar_dropouts`):
1. **Métricas y Resolución**:
   * Opera sobre frames de la STFT con un tamaño de salto (`hop_size`) de **1024 muestras** ($\approx 23.2\text{ ms}$ a 44.1 kHz).
   * El cálculo del RMS se realiza en ventanas de FFT de **4096 muestras** ($\approx 92.8\text{ ms}$).
2. **Condiciones de Activación**:
   * Requiere que el frame pertenezca a una zona activa (`avg_rms > 0.003` o $-50\text{ dBFS}$).
   * Exige que el RMS del frame caiga por debajo de $-90\text{ dBFS}$ (`feat.rms < 3.162e-5`).

---

### 2. Ranking de Causas Probables de Recall = 0%

A continuación se listan y priorizan las debilidades que explican la nula capacidad de detección:

#### 1. Difuminación de Energía por Ventana de Análisis Ancha (Incompatibilidad Física)
* **Severidad:** 🔴 CRÍTICA
* **Evidencia en código:**
  ```rust
  let fft_size = 4096; // 92.8 ms a 44.1 kHz
  ...
  feat.rms < threshold_90db // threshold_90db = 3.162e-5 (-90 dBFS)
  ```
* **Descripción técnica:** Dado que la ventana de análisis de RMS de la STFT abarca $92.8\text{ ms}$ (`fft_size = 4096`), un dropout de $10\text{ ms}$ inyectado sobre una región activa de música o voz solo reducirá la energía del frame en aproximadamente un $10.7\%$. El RMS resultante seguirá siendo sumamente alto (muy por encima de $-90\text{ dBFS}$ o `3.162e-5`). Por lo tanto, la condición `feat.rms < threshold_90db` **nunca se cumplirá** para dropouts de corta duración en regiones con señal de audio activa.
* **Impacto sobre Recall:** Anulación completa (falsos negativos sistemáticos).

#### 2. Paradoja de la Región Activa (`is_active_region`)
* **Severidad:** 🔴 CRÍTICA
* **Evidencia en código:**
  ```rust
  let is_active_region = avg_rms > global_rms * 0.15 && avg_rms > 0.003;
  ```
* **Descripción técnica:** Para evitar falsos positivos en silencios legítimos, el detector exige que el promedio móvil RMS de los últimos 10 frames ($210\text{ ms}$) sea mayor a `0.003` ($-50.4\text{ dBFS}$). 
  * Si el dropout dura poco (ej. $15\text{ ms}$), el promedio móvil no se ve afectado y la región se considera activa, pero la compuerta de $-90\text{ dBFS}$ falla por el tamaño de la ventana (Causa 1).
  * Si el dropout fuera lo suficientemente largo como para reducir el RMS de la ventana FFT por debajo de $-90\text{ dBFS}$, entonces el promedio móvil del RMS (`avg_rms`) caería rápidamente por debajo de `0.003`, apagando `is_active_region` y cancelando la detección.
* **Impacto sobre Recall:** Bloqueo de detección en el inicio de zonas largas y omisión de zonas cortas.

#### 3. Limitación de Duración Mínima Rígida en el Filtro Post-Procesamiento
* **Severidad:** 🔴 CRÍTICA
* **Evidencia en código:**
  ```rust
  // detectors.rs - línea 620
  if duration_ms >= 20.0 && duration_ms <= 250.0
  ```
* **Descripción técnica:** El detector filtra y descarta cualquier evento cuya duración detectada sea inferior a $20\text{ ms}$. 
  * En el modo `real_world`, los dropouts inyectados son de $5\text{ a }25\text{ ms}$. Más del **75% de los eventos inyectados** tienen una duración real de entre $5\text{ y }20\text{ ms}$.
  * Incluso si el motor superara las limitaciones de ventana y detectara estos dropouts cortos, el filtro post-procesamiento los descartaría de inmediato por estar debajo de la cota de $20\text{ ms}$.
* **Impacto sobre Recall:** Pérdida masiva de eventos en el rango de micro-dropouts.

#### 4. Umbral de Tasa de Cruce por Cero (`feat.zero_crossing_rate < 0.2`)
* **Severidad:** 🟡 MEDIA
* **Evidencia en código:**
  ```rust
  // detectors.rs - línea 602
  feat.zero_crossing_rate < 0.2
  ```
* **Descripción técnica:** Exige que el frame tenga baja tasa de cruces por cero. Sin embargo, cuando ocurre una interrupción abrupta de la señal (caída a 0), los flancos de entrada y salida del dropout actúan como transitorios rápidos de alta frecuencia. Si el dropout está rodeado de ruido de fondo (como el Hiss inyectado en `all_mixed` o `real_world`), el siseo residual dentro de la ventana de análisis elevará artificialmente el `zero_crossing_rate` por encima del $0.2$, abortando la detección.
* **Impacto sobre Recall:** Falsos negativos en presencia de ruido de cinta o de fondo.

---

### 3. Comparación de Condiciones: Generador vs. Detector

| Característica | Inyectado por el Generador | Exigido por el Detector | ¿Existe Compatibilidad? |
| :--- | :--- | :--- | :--- |
| **Duración del Evento** | $5\text{ ms a }50\text{ ms}$ | $\ge 20\text{ ms}$ | **No**. Excluye la mayoría de los dropouts del modo `real_world`. |
| **Piso de Ruido en Silencio** | Muestras = 0.0 absoluto ($-\infty\text{ dBFS}$) | RMS del bloque $< -90\text{ dBFS}$ | **No**. Debido al tamaño de la ventana de FFT de 92.8ms, el promedio del bloque nunca baja a $-90\text{ dBFS}$. |
| **Resolución Temporal** | Muestra a muestra ($1\text{ sample}$) | Resolución de frame ($23.2\text{ ms}$) | **No**. La STFT difumina los límites del micro-silencio. |

---

### 4. Plan de Experimentación Recomendado para la Siguiente Iteración

Para romper el bloqueo del 0% de Recall en la iteración de código subsiguiente, se propone el siguiente diseño experimental:

1. **Fase 1: Reducción de la Ventana Temporal del Detector**
   * *Propuesta:* Modificar el análisis para que se base en la señal del dominio temporal directo (`samples`) en lugar de depender exclusivamente de los features de la STFT (`features[t].rms`).
   * *Justificación:* En el dominio temporal es posible medir caídas de energía con resolución de muestra (ej. ventanas móviles de 2 ms a 5 ms), permitiendo detectar micro-silencios sin el efecto de difuminación de la FFT.

2. **Fase 2: Flexibilización del Filtro de Duración Mínima**
   * *Propuesta:* Reducir el límite inferior de duración en el post-procesamiento de $20\text{ ms}$ a $5\text{ ms}$.

3. **Fase 3: Umbrales Adaptativos de Silencio**
   * *Propuesta:* Reemplazar la compuerta de $-90\text{ dBFS}$ rígida por un umbral dinámico basado en una caída relativa abrupta respecto al RMS local del canal (por ejemplo, una atenuación repentina $> 25\text{ dB}$ en el dominio temporal).
