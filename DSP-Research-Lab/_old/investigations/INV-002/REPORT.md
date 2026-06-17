# INV-002: Pop Characterization Study

## Fase A: Definición Operacional

Desde el punto de vista del Procesamiento de Señales Digitales (DSP), un **Pop** se define como una perturbación transitoria de baja frecuencia y alta amplitud. Físicamente, suele originarse por una sobrepresión mecánica en el diafragma de un micrófono (ráfagas de viento, consonantes plosivas como "P" o "B") o por discontinuidades bruscas de baja frecuencia en medios físicos (rayones severos en vinilo) y empalmes mal realizados que generan un salto en el nivel de DC.

A diferencia del ruido blanco o los clicks, la energía del Pop no se distribuye uniformemente en el espectro. Es una onda lenta en comparación con la tasa de muestreo.

## Fase B: Orígenes y Tipología (Dataset de Referencia Mental)

1. **Pops Vocales (Plosivas)**: Ráfaga de aire que satura el micrófono. Generalmente asimétricos, de larga duración (20-100ms), dominados por frecuencias sub-graves (<150 Hz).
2. **Pops de Vinilo (Thumps)**: Defectos profundos en el surco que generan un salto en la aguja. Presentan un ataque abrupto seguido de una resonancia de baja frecuencia del propio brazo del tocadiscos (típicamente 10-20 Hz).
3. **Pops Digitales / Splices**: Cambios abruptos en el nivel de DC debido a cortes de cinta mal alineados o buffers digitales discontinuos. Producen un salto escalonado que el sistema de reproducción filtra como un transitorio de baja frecuencia.

## Fase C: Caracterización Temporal

- **Duración**: Larga (típicamente 10 ms a 150 ms). Mucho más largo que un click (que dura de 1 a 5 ms).
- **Amplitud**: Alta a muy alta, a menudo acercándose a la escala completa (0 dBFS) o induciendo clipping.
- **Forma de Onda**: A menudo fuertemente **asimétrica** o unipolar en su inicio debido a la presión direccional del aire o al salto de DC.
- **Derivadas**: La primera derivada no es tan extrema como en un click (ataque más suave relativo al click), pero la integral local (energía/DC offset) muestra un desplazamiento masivo respecto al eje cero.
- **Tasa de Cruces por Cero (ZCR)**: Localmente muy baja durante el evento.

## Fase D: Caracterización Espectral (Vía AnalyticalSpectrogram)

- **Distribución de Energía**: Concentración masiva en las bandas más bajas (típicamente 0 - 200 Hz).
- **Bandwidth**: Muy estrecho en el dominio espectral (limitado a sub-graves), a diferencia de los clicks que son broadband.
- **Low-Frequency Energy Ratio (LFER)**: Extremadamente alto. La relación entre la energía por debajo de 200 Hz frente a la energía por encima de 1 kHz se dispara.
- **Spectral Flux**: Alto en la región de baja frecuencia justo en el momento del ataque.
- **Phase Coherence**: A menudo carece de una estructura armónica fundamental clara que decae suavemente (como un bombo o un bajo).

## Fase E: Análisis Comparativo

- **vs. Clicks**: El click es extremadamente corto y espectralmente plano (broadband). El Pop es largo y confinado a bajas frecuencias.
- **vs. Hum**: El Hum es periódico, continuo y armónico (50/60Hz). El Pop es un transitorio aperiódico y singular.
- **vs. Dropout**: El Dropout es una ausencia repentina de energía (silencio). El Pop es una inyección de energía.
- **vs. Transitorios Musicales (Bombo/Kick, Bajo)**: Esta es la frontera de colisión más peligrosa. Un bombo comparte el rango de frecuencias (50-100Hz) y la naturaleza transitoria. Sin embargo, el bombo tiende a ser simétrico (movimiento del parche), presenta una caída de envolvente exponencial coherente y armónicos medibles. El Pop vocal suele ser asimétrico (presión unidireccional) y más ruidoso/caótico en su decaimiento espectral.

---

# Conclusiones Preliminares

## 1. Clasificación del Artefacto
**Dominio Dominante: HÍBRIDO (Temporal-Espectral)**
- **Temporal**: Su asimetría y el desplazamiento local del nivel de DC son firmas temporales críticas.
- **Espectral**: Su abrumadora concentración en frecuencias bajas es indispensable para separarlo de otros artefactos.
- **Contextual**: (Opcional, pero útil) Se requieren métricas de contexto para distinguirlo definitivamente de un bombo musical, basándose en la asimetría y en la falta de armónicos rítmicos.

## 2. Lista de Evidencias Candidatas
Para un futuro sistema de detección, las evidencias más prometedoras son:
1. **Local DC Offset / Asimetría Temporal**: Un pico masivo en la media local de la señal (enventanada a ~50ms).
2. **LFER (Low-Frequency Energy Ratio)**: Utilizando el `AnalyticalSpectrogram` para comparar la magnitud < 150 Hz versus la magnitud total.
3. **Low ZCR (Zero-Crossing Rate)**: Tasa de cruces por cero anormalmente baja durante un pico de energía.
4. **Falta de Tonalidad (Spectral Flatness en bandas bajas)**: Para diferenciar un Pop ruidoso (viento) del fundamental armónico de un bajo eléctrico.

## 3. Hipótesis para INV-002A (Detector Candidato)
**Hipótesis**: Un sistema que identifique candidatos temporales basándose en desplazamientos bruscos de la asimetría de la forma de onda (Local DC Offset), y que valide dichos candidatos espectralmente exigiendo un `LFER` excepcionalmente alto en el `AnalyticalSpectrogram`, será capaz de detectar Pops aislando exitosamente instrumentos musicales graves como bombos y bajos.
