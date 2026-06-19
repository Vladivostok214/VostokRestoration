# Auditoría Técnica: Detector de Hiss (`detectar_hiss`)
## Vostok Restoration DSP Engine

---

### Resumen Ejecutivo

Este documento presenta una auditoría técnica detallada del detector de siseo (Hiss) implementado en el archivo [detectors.rs](file:///C:/Users/WLADI/Vostok%20Plugins/DesktopApps/Vostok%20Restoration%20V1/src-tauri/src/vostok_dsp/detectors.rs#L767-L886) mediante la función `detectar_hiss()`.

El análisis revela **debilidades estructurales críticas** en los criterios de activación del detector. En particular, la dependencia simultánea de la planitud espectral global (`feat.spectral_flatness`) y un umbral de energía RMS absoluto extremadamente elevado (`feat.rms > 0.01`) bloquea la detección de siseo en la gran mayoría de los escenarios reales (generando falsos negativos masivos). Al mismo tiempo, una tolerancia a huecos (`gap_tolerance`) desproporcionadamente larga (150 frames o ~3.48s) expone al sistema a fusiones erróneas y eventos sobredimensionados frente a transitorios de alta frecuencia como sibilancias de voz o platillos de batería.

---

### 1. Comparación Arquitectónica: `detectar_hiss()` vs `detectar_hum()`

| Parámetro / Estrategia | Detector de Hum (Referencia Corregida) | Detector de Hiss (Estado Actual) | Impacto de la Diferencia |
| :--- | :--- | :--- | :--- |
| **Estrategia de Detección** | Comparación local de bins específicos (50/60 Hz y armónicos) contra sus vecinos espectrales directos para identificar picos tonales puros. | Medición de la planitud espectral (Spectral Flatness) en la banda superior (>5 kHz) combinada con métricas de la trama global. | **Incoherencia de Ámbito**: El Hum busca picos locales; el Hiss busca ruido de banda ancha plano. Sin embargo, Hiss mezcla mediciones globales y locales de forma restrictiva. |
| **Umbral de Activación** | `peak_threshold` adaptativo regulado por la sensibilidad (`6.0 - sensitivity * 3.0`) sobre vecinos locales. | Doble umbral de Flatness (global y local) + Compuerta de energía RMS rígida (`> 0.01`). | **Bloqueo de detección**: El Hiss requiere que todo el espectro sea plano y que la señal sea muy fuerte, lo cual es contradictorio con la naturaleza del siseo. |
| **Consolidación Temporal** | `gap_tolerance` = 15 frames (~348ms). Evita la fusión de regiones con silencios musicales reales. | `gap_tolerance` = 150 frames (~3.48s). Diseñado para "tolerar enmascaramiento". | **Eventos inflados**: Hiss fusiona pasajes enteros separados por silencios o picos dinámicos, extendiendo artificialmente la detección. |
| **Duración Mínima** | $\ge$ 70 frames (~1.62 segundos). Filtra notas transitorias de instrumentos graves. | $\ge$ 90 frames (~2.09 segundos). Filtra transitorios de alta frecuencia (sibilancias cortas). | Coherente con un ruido estacionario, pero anulado por la fusión excesiva del `gap_tolerance`. |

---

### 2. Análisis Detallado de Debilidades y Causas Probables

A continuación, se listan y priorizan las debilidades identificadas en `detectar_hiss()`, ordenadas de **mayor a menor probabilidad de impacto real**.

#### 1. Dependencia de la Planitud Espectral Global (`feat.spectral_flatness`)
* **Severidad:** 🔴 ALTA
* **Probabilidad de impacto real:** ⚡ CRÍTICA / CASI SEGURA
* **Descripción técnica:** El detector requiere que `feat.spectral_flatness > flatness_threshold` (línea 819). La métrica `feat.spectral_flatness` se calcula en `extract_features` (líneas 90-96) sobre **todo el espectro** (de 0 a $f_s/2$). Si el audio contiene información en bajas y medias frecuencias (lo cual ocurre en el 99% de la música y la voz), el espectro global no será plano y `feat.spectral_flatness` será muy bajo (cercano a 0.0). Esto causa que la condición falle y el hiss no se detecte jamás mientras haya voz o música sonando, provocando un falso negativo masivo.
* **Síntomas esperados:** El hiss solo se detectará en silencios absolutos, pero incluso allí puede fallar debido al umbral RMS (ver debilidad 2).
* **Evidencia en el código:**
  ```rust
  // detectors.rs - línea 819
  if feat.spectral_flatness > flatness_threshold && local_flatness > flatness_threshold && feat.rms > 0.01
  ```

#### 2. Compuerta de Energía Absoluta Demasiado Alta (`feat.rms > 0.01`)
* **Severidad:** 🔴 ALTA
* **Probabilidad de impacto real:** 🔥 MUY ALTA
* **Descripción técnica:** Requiere que el RMS de la trama sea mayor a `0.01` (equivalente a $-40\text{ dBFS}$). El siseo analógico clásico (cinta, preamplificadores) suele ubicarse en niveles de fondo entre $-50\text{ dBFS}$ y $-75\text{ dBFS}$ (valores RMS de `0.003` a `0.00018`). Un umbral rígido de `0.01` impide detectar siseo en las secciones donde es más audible: los silencios o decaimientos suaves del audio.
* **Síntomas esperados:** Falsos negativos continuos. El detector permanece inactivo en zonas de bajo nivel donde el siseo es claramente perceptible para el oído humano.
* **Evidencia en el código:**
  ```rust
  // detectors.rs - línea 819
  if feat.spectral_flatness > flatness_threshold && local_flatness > flatness_threshold && feat.rms > 0.01
  ```

#### 3. Tolerancia de Huecos Desproporcionada (`gap_tolerance = 150`)
* **Severidad:** 🔴 ALTA
* **Probabilidad de impacto real:** 🔥 MUY ALTA
* **Descripción técnica:** `gap_tolerance` está fijado en 150 frames. Con un tamaño de salto (`hop_size`) de 1024 muestras a $44.1\text{ kHz}$, esto equivale a $\approx 3.48$ segundos de tolerancia. Si el detector se activa erróneamente por un transitorio brillante (como un golpe de platillo o sibilancia prolongada) y más adelante ocurre otro evento corto dentro de los 3.48 segundos, ambos se fusionarán en un único evento continuo de Hiss.
* **Síntomas esperados:** Segmentos de siseo detectados extremadamente largos, a menudo abarcando grandes porciones del archivo de audio, uniendo pasajes que no contienen siseo real.
* **Evidencia en el código:**
  ```rust
  // detectors.rs - líneas 827-839
  let gap_tolerance = 150;
  ...
  if gap_counter > gap_tolerance {
      inside_hiss = false;
      ...
  }
  ```

#### 4. Sensibilidad al Tipo de Material (Platillos, Sibilancias y Brillo Musical)
* **Severidad:** 🟡 MEDIA
* **Probabilidad de impacto real:** 📈 MODERADA - ALTA
* **Descripción técnica:** El detector evalúa la planitud espectral local (`local_flatness`) por encima de los 5 kHz (`high_freq_start = 5000.0f32`). Instrumentos como platillos de batería (hi-hats, rides), aplausos, y sibilancias del habla humana (fricativas como `/s/`, `/z/`, `/f/`) tienen una distribución espectral muy ruidosa y plana en esa banda alta. A sensibilidades altas (`flatness_threshold` disminuye hasta `0.30`), estos sonidos activarán `local_flatness > flatness_threshold`. Debido al enorme `gap_tolerance`, se consolidarán como hiss constante.
* **Síntomas esperados:** Falsos positivos severos en música electrónica (hi-hats constantes) y voz sibilante, interpretando incorrectamente elementos artísticos brillantes como siseo.
* **Evidencia en el código:**
  ```rust
  // detectors.rs - líneas 780-783
  let flatness_threshold = 0.45 - (sensitivity * 0.15);
  let high_freq_start = 5000.0f32;
  ```

#### 5. Amplitud Estimada Estática (`amplitude_delta: 0.05`)
* **Severidad:** 🟡 MEDIA
* **Probabilidad de impacto real:** 📈 MODERADA
* **Descripción técnica:** Cuando se crea el `GlitchEvent` de tipo Hiss, se le asigna un `amplitude_delta` fijo de `0.05` (líneas 849 y 873). Esto equivale a una estimación estática de $-26\text{ dBFS}$ de ruido de siseo, la cual es excesivamente alta y no se correlaciona con la energía real del siseo detectado en la banda de alta frecuencia.
* **Síntomas esperados:** Errores de calibración si el motor de restauración utiliza este valor para dosificar la reducción de ruido o la visualización en la interfaz.
* **Evidencia en el código:**
  ```rust
  // detectors.rs - líneas 849 y 873
  amplitude_delta: 0.05,
  ```

#### 6. Falta de Adaptación a la Tasa de Muestreo (Sample Rate)
* **Severidad:** 🟢 BAJA
* **Probabilidad de impacto real:** 📉 BAJA
* **Descripción técnica:** El cálculo del tiempo en segundos de la ventana de tolerancia y el tamaño de la FFT son fijos. Sin bien el `start_bin` se calcula dinámicamente con la tasa de muestreo, el comportamiento dinámico del `gap_tolerance` expresado en frames fijos (150) hace que a $96\text{ kHz}$ la ventana de tiempo se reduzca a la mitad ($\approx 1.6$ segundos) en comparación con $44.1\text{ kHz}$ ($\approx 3.48$ segundos).
* **Síntomas esperados:** Comportamiento inconsistente del detector entre archivos con diferentes tasas de muestreo.
* **Evidencia en el código:**
  ```rust
  // detectors.rs - línea 783 y 827
  let start_bin = (high_freq_start * fft_size as f32 / sample_rate as f32).round() as usize;
  let gap_tolerance = 150;
  ```

---

### 3. Plan de Investigación Recomendado para las Siguientes Iteraciones

Para resolver estas debilidades en fases posteriores sin alterar el código en esta instancia, se propone la siguiente secuencia de validación científica:

1. **Fase 1: Aislamiento Espectral y Eliminación de la Condición Global**
   * *Objetivo:* Probar el impacto de remover la restricción de `feat.spectral_flatness > flatness_threshold` y evaluar la planitud *exclusivamente* en la banda alta (`local_flatness`).
   * *Ground Truth:* Validar con señales mixtas (Voz + Hiss de cinta a $-60\text{ dBFS}$).

2. **Fase 2: Calibración Dinámica del Umbral RMS**
   * *Objetivo:* Reemplazar el umbral estático `feat.rms > 0.01` por un análisis del piso de ruido (Noise Floor) del archivo o una compuerta adaptativa basada en la energía espectral de la banda alta, permitiendo la detección de siseo a niveles realistas ($-50$ a $-75\text{ dBFS}$).

3. **Fase 3: Optimización de la Agrupación Temporal (`gap_tolerance`)**
   * *Objetivo:* Reducir el `gap_tolerance` de 150 frames a un valor óptimo (por ejemplo, entre 15 y 30 frames, similar a la optimización de Hum) para evitar la fusión indeseada de regiones.

4. **Fase 4: Discriminación de Transitorios Brillantes**
   * *Objetivo:* Investigar la inclusión de una métrica de flujo espectral (`spectral_flux`) o tasa de cruces por cero en alta frecuencia para diferenciar el siseo estacionario (flujo bajo) de los platillos y sibilancias (flujo alto y transitorio).
