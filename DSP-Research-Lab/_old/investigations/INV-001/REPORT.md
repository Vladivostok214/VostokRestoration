# Reporte Final: INV-001 Click Calibration

**Fecha**: Junio 2026
**Estado**: Completado
**Objetivo**: Validar y calibrar cuantitativamente el detector de clicks espectral (`detect_artifacts_dynamic`).

## 1. Dataset y Metodología
Se generó una pista sintética de 10 segundos (`inv001_synthetic_clean.wav`) combinando un tono estable, percusiones y ráfagas de ruido blanco. Sobre esta pista, se inyectaron 20 micro-clicks sintéticos de corta duración (1-3 muestras) en posiciones aleatorias para conformar el archivo `inv001_synthetic_corrupted.wav` junto con un Ground Truth CSV.
La evaluación se ejecutó midiendo el **F1 Score** en GNU Octave.

---

## 2. Evaluación de la Línea Base (Baseline)
Se testeó el detector espectral (STFT) con los umbrales documentados en la arquitectura original:
* Crest Factor > 15.0
* Spectral Bandwidth > 80% Nyquist

**Resultado Empírico**:
`F1 Score = 0.0000` (0 True Positives, 20 False Negatives).
El detector original era 100% ciego.

---

## 3. Análisis de las Causas (Descubrimientos Matemáticos)

### A. El Error del Ancho de Banda (Spectral Bandwidth)
El diseño original exigía que el ancho de banda del click superase el 80% de Nyquist. Sin embargo, matemáticamente, el espectro de un impulso ideal (ruido blanco plano) tiene una desviación estándar que oscila alrededor de $\frac{1}{\sqrt{3}} \approx 0.577$. **Es matemáticamente imposible que un click real alcance el 80% de Nyquist**. Su límite natural ronda el 40-50%.

### B. El Enmascaramiento del Crest Factor
El detector evalúa frames STFT de 1024 muestras. Un micro-click de 2 muestras diluye dramáticamente su energía entre las restantes 1022 muestras de contenido musical del mismo frame. Esto causa que el *Crest Factor* del frame raramente supere el valor de `5.0` o `6.0`, rango en el cual los transitorios percusivos lícitos de la música también coexisten.

---

## 4. Resultados de la Calibración Empírica
Se inyectaron umbrales experimentales corregidos (`Crest Factor = 5.0`, `Bandwidth = 30%`, `RMS mult = 1.2`) directamente en Rust mediante un refactoring a la estructura `DetectorThresholds`.

**Métricas Finales**:
* True Positives (TP): 2
* False Positives (FP): 3
* False Negatives (FN): 18
* **Precision**: 0.4000
* **Recall**: 0.1000
* **F1 Score: 0.1600**

**Conclusión**: Bajar los umbrales permite capturar algunos clicks, pero a costa de falsos positivos inaceptables. Detectar discontinuidades de 1 o 2 muestras en el dominio espectral es inherentemente frágil.

---

## 5. Propuesta de Integración Arquitectónica (DSP Pipeline)

A raíz de esta evidencia empírica, se propone reestructurar el motor de detección principal en el ecosistema Vostok:

1. **Detección de Alta Frecuencia / Micro-Clicks (Dominio del Tiempo mediante LPC):**
   * **Problema:** La resolución temporal STFT es muy ancha (1024 muestras), lo que enmascara los clicks. Además, pruebas complementarias demostraron que la función legada temporal `detect_glitches` (basada en derivadas ingenuas) genera cientos de falsos positivos en presencia de transitorios musicales lícitos.
   * **Solución:** Relegar la detección de micro-clicks al dominio del tiempo pero **actualizando el algoritmo a un modelo de Predicción Lineal (LPC o Burg)**. En lugar de diferencias simples, el modelo LPC predecirá la siguiente muestra basándose en la forma de onda local; solo los errores de predicción masivos serán marcados como clicks genuinos.

2. **Detección de Baja Frecuencia / Pops & Hum (Dominio Espectral - STFT):**
   * **Problema:** El dominio temporal no diferencia el ruido de fondo del Hum eléctrico.
   * **Solución:** Utilizar la función calibrada `detect_artifacts_dynamic` **exclusivamente** para rastrear anomalías de largo aliento, como plops de graves y acoples de red eléctrica (Hum), donde la resolución frecuencial brilla y el enmascaramiento no afecta.

3. **Inyección de Dependencias (Implementado):**
   * Mantener el *struct* `DetectorThresholds` inyectado en INV-001 para que la interfaz gráfica (Tauri/React) tenga control absoluto de la sensibilidad sin modificar código estático.
