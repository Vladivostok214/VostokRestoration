# Auditoría Técnica: Detector de Pops (`detectar_pops`)
## Vostok Restoration DSP Engine — Investigación LAB-POP-001

---

### Resumen Ejecutivo

Este informe documenta la investigación técnica realizada sobre el detector de "Pops" y "Low Thumps" (bajas frecuencias) implementado en [detectors.rs](file:///C:/Users/WLADI/Vostok%20Plugins/DesktopApps/Vostok%20Restoration%20V1/src-tauri/src/vostok_dsp/detectors.rs#L447-L515).

La campaña de validación arrojó un resultado crítico de **Recall = 0%** (0 aciertos de 3 inyecciones). El análisis estático revela que las condiciones exigidas por el detector (`detectar_pops`) para identificar un pop son **demasiado restrictivas y matemáticamente incompatibles** con la firma física de los pops inyectados por el generador (y comunes en grabaciones reales). La dependencia de un espectrograma de ventana ancha y umbrales de energía globales sobredimensionados bloquea por completo la activación del detector en cualquier señal con contenido musical activo.

---

### 1. Análisis del Algoritmo del Detector vs. Generador

El fallo sistemático de detección se explica por la colisión de los siguientes parámetros y suposiciones físicas:

#### El Generador (`degradar_audio_v2.py`):
* **Frecuencia del Pop**: Pulso sinusoidal amortiguado de baja frecuencia entre **$20\text{ Hz y }60\text{ Hz}$** (`thump = sin(...) * exp(-t * 25)`).
* **Duración**: Entre **$15\text{ ms y }60\text{ ms}$**.
* **Amplitud**: Moderada, entre **$0.2\text{ y }0.5$** de la escala completa.

#### El Detector (`detectar_pops`):
* **Resolución**: Analiza por tramas de la STFT con `hop_size = 1024` muestras ($\approx 23.2\text{ ms}$) y una ventana de análisis FFT de `4096` muestras ($\approx 92.8\text{ ms}$).
* **Criterios de Activación**:
  1. Dominancia de baja frecuencia:
     $$\frac{\text{Energía } < 150\text{ Hz}}{\text{Energía Total}} > 0.80 \quad (80\%)$$
  2. Crest Factor alto de la trama:
     $$\text{Crest Factor} = \frac{\text{AbsMax}}{\text{RMS}} > 5.0$$
  3. Energía RMS alta:
     $$\text{Frame RMS} > \text{Global RMS} \times 3.0 \quad (\approx +9.5\text{ dB})$$

---

### 2. Ranking de Causas Probables de Recall = 0%

A continuación se listan y priorizan las debilidades que provocan el bloqueo de detección:

#### 1. Fracaso de la Dominancia de Baja Frecuencia en Señales Activas
* **Severidad:** 🔴 CRÍTICA
* **Evidencia en código:**
  ```rust
  let is_low_energy_dominant = total_energy > 1e-6 && (low_energy / total_energy) > 0.8;
  ```
* **Descripción técnica:** El detector exige que el $80\%$ de la energía espectral de toda la ventana de la FFT de $92.8\text{ ms}$ se concentre por debajo de $150\text{ Hz}$. Si el audio contiene voces, guitarras, sintetizadores o platillos sonando en paralelo al pop, la energía en las bandas medias y altas superará con creces el $20\%$ restante del espectro total. Como resultado, esta condición fallará siempre en cualquier sección musical activa.
* **Impacto sobre Recall:** Bloqueo del detector en el 99% de las pistas musicales y de voz.

#### 2. Umbral de Energía RMS Inalcanzable (`RMS > Global RMS * 3.0`)
* **Severidad:** 🔴 CRÍTICA
* **Evidencia en código:**
  ```rust
  let has_high_rms = features[t].rms > global_rms * 3.0;
  ```
* **Descripción técnica:** Exigir que la energía del bloque sea más de 3 veces el RMS global de todo el archivo es extremadamente restrictivo. Si un archivo de audio está normalizado a $-15\text{ dBFS}$ (RMS $\approx 0.17$), un pop de amplitud $0.25$ no tiene la energía suficiente para elevar el RMS de una ventana de $92.8\text{ ms}$ a valores mayores a $0.51$ (RMS requerido). El pop solo se detectaría si el archivo es un silencio casi absoluto y el pop es ensordecedor.
* **Impacto sobre Recall:** Anulación de la sensibilidad para pops de nivel medio o bajo en pasajes normales de música.

#### 3. Atenuación del Crest Factor debido a la Ventana de Análisis Ancha
* **Severidad:** 🟡 MEDIA
* **Evidencia en código:**
  ```rust
  let has_high_crest = features[t].crest_factor > 5.0;
  ```
* **Descripción técnica:** El factor de cresta se calcula sobre la ventana del frame en `extract_features` como `abs_max / rms`. Dado que un pop suave tiene una forma de onda senoidal de baja frecuencia continua y amortiguada (cuyo factor de cresta natural es $\approx 1.41$), al sumarse con el audio musical de fondo, raramente empuja el factor de cresta total de la trama de $92.8\text{ ms}$ por encima de $5.0$, a menos que el transitorio sea sumamente picudo (tipo Dirac), lo cual contradice la naturaleza suave y redondeada de un "Pop/Thump".
* **Impacto sobre Recall:** Exclusión de pops auténticos de baja frecuencia (los cuales son transitorios suaves, no pulsos de alta frecuencia).

---

### 3. Cruce con Otros Detectores (¿Descarte o Clasificación Errónea?)

Se evaluó si los pops inyectados estaban siendo absorbidos o mal clasificados por otros módulos:

* **Detector de Clicks (`detectar_clicks`)**:
  * El detector de clicks utiliza el error de predicción lineal (LPC). Dado que un pop es una señal senoidal suave de baja frecuencia (20-60 Hz), el predictor autoregresivo lineal (de orden 16) es sumamente eficiente prediciéndola. Por lo tanto, el error de predicción residual es muy bajo.
  * Adicionalmente, el detector de clicks exige un tiempo de decaimiento corto ($\le 12$ muestras, es decir, $< 0.27\text{ ms}$ a 44.1 kHz). Un pop de $15-60\text{ ms}$ es miles de veces más largo, por lo que es descartado de inmediato en el filtro de firmas de Dirac.
* **Detector de Hum (`detectar_hum`)**:
  * Aunque el Hum analiza las bajas frecuencias, exige que la señal sea altamente estacionaria y persistente en el tiempo (duración $\ge 70$ frames o $\approx 1.6$ segundos). El pop de $15-60\text{ ms}$ es ignorado de inmediato.

* **Conclusión**: Los pops no están siendo absorbidos ni mal clasificados por otros detectores. Simplemente son completamente invisibles para todo el motor DSP.

---

### 4. Plan Experimental Recomendado para LAB-POP-002

Para solucionar la falta de recall en la fase de código subsiguiente, se recomienda:

1. **Fase 1: Rediseño Espectral Relativo**
   * Reemplazar la condición absoluta de dominancia espectral (`low_energy / total_energy > 0.8`) por un detector de transitorios de energía de baja frecuencia (Low-Frequency Spectral Flux).
   * Evaluar si hay un incremento repentino y masivo de energía únicamente en la banda por debajo de $120\text{ Hz}$ en comparación con las tramas adyacentes.

2. **Fase 2: Umbral de Energía Adaptativo Local**
   * Reemplazar el umbral global `global_rms * 3.0` por una comparación local. El pop debe destacar sobre la energía RMS de su contexto inmediato (por ejemplo, superando en un factor de $1.8\text{x}$ al promedio móvil de RMS de baja frecuencia precedente).

3. **Fase 3: Eliminación del Criterio de Crest Factor**
   * Remover el requisito de `crest_factor > 5.0` para la clasificación de pops, ya que los thumps de baja frecuencia por naturaleza son ondas suaves y de baja relación pico/promedio dentro de la ventana de análisis.
