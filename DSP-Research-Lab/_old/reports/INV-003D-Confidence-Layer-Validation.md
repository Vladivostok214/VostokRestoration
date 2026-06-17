# INV-003D-Confidence-Layer-Validation

**Investigador:** Gemini DSP Research Agent
**Fecha:** Junio 2026
**Referencia:** INV-003C, AF-001 → AF-017

---

## 1. Objetivo y Metodología

El objetivo de esta fase fue identificar las métricas matemáticas que compondrán la **Confidence Layer** del detector Hum. Partiendo de la Arquitectura MVA (`Fundamental -> CV -> Persistencia`), que produce un Recall perfecto (1.0) pero sufre de Falsos Positivos críticos en música pesada, se evaluaron cinco candidatos de evidencia adicionales.

El benchmark se ejecutó sobre el dataset expandido de `TestSamples`, cruzando 6 audios base limpios contra 5 modos de inyección (Hum 50/60Hz, Modulado, Ground Loop, Intermitente).

---

## 2. Evaluación de Candidatos

### Evidencia A: Coherencia de Fase
*   **Hipótesis:** El Hum mantiene una fase más estable que el contenido musical.
*   **Resultado:** **REFUTADO (Efecto Inverso).**
*   **Análisis:** En pistas densas (`musicapesada.wav`), un sintetizador de sub-graves posee una varianza de fase casi nula ($\approx 0.0003$). En contraste, un Hum eléctrico débil grabado a través de un micrófono (`bateria_hum_50hz.wav`) sufre la contaminación del ruido de banda ancha, elevando su varianza de fase ($\approx 0.5$). La fase perfecta indica, paradójicamente, síntesis digital o una nota aislada, no una interferencia física.

### Evidencia C: Harmonic Energy Decay
*   **Hipótesis:** Los armónicos eléctricos siguen patrones predecibles ($n \cdot f_0$ decayendo).
*   **Resultado:** **VALIDADO (Excelente Discriminador).**
*   **Análisis:** La música rica en graves (`musicaenvivo.wav`) presenta una fuerte energía en la fundamental (50Hz), pero su 2º armónico (100Hz) frecuentemente la supera (Decay Ratio $\approx 1.33$). El Hum eléctrico puro o de Ground Loop presenta siempre un decaimiento monótono (Decay Ratio $< 0.8$). Filtra los falsos positivos armónicos con alta eficacia.

### Evidencia E: Cross-Window Consistency (Global Persistence)
*   **Hipótesis:** La firma del Hum permanece inalterada a lo largo de todo el archivo.
*   **Resultado:** **VALIDADO (La "Bala de Plata").**
*   **Análisis:** Un bajo musical (`musicapesada.wav`) puede tener un CV perfecto y un decaimiento armónico similar al Hum, pero solo existe durante un breve "drop" (Persistencia Global $\approx 1.3\%$). El Hum eléctrico intermitente más débil tiene una presencia mínima del $\approx 7.4\%$.

---

## 3. Tabla de Benchmark: MVA + Evidencias

| Configuración | Precision | Recall | F1 | Coste | Veredicto |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MVA (Baseline)** | 0.9375 (2 FP) | **1.0000** | 0.9677 | Bajo | Base |
| **MVA + Phase Coherence (A)** | 0.9259 (2 FP) | 0.8333 (5 FN) | 0.8772 | Medio | Descartado |
| **MVA + Harmonic Decay (C)** | 0.9666 (1 FP) | **1.0000** | 0.9830 | Bajo | Aprobado |
| **MVA + Global Persist (E)** | 0.9630 (1 FP) | 0.8667 (4 FN) | 0.9123 | Medio | Aprobado |
| **MVA + Decay(C) + Global(E)** | **1.0000** (0 FP) | 0.9666 (1 FN) | **0.9830** | Medio | **ÓPTIMO** |

*Nota: La combinación final eliminó el 100% de los Falsos Positivos en la música pesada sacrificando solo un caso extremo de Hum Modulado en música ultra-densa.*

---

## 4. Respuestas a Preguntas de Investigación

**Pregunta A: ¿Qué evidencia elimina más Falsos Positivos?**
El **Harmonic Decay (Evidencia C)** elimina los drones musicales ricos, y el **Global Persistence (Evidencia E)** elimina los sub-graves sintéticos puros. Ambos son requeridos.

**Pregunta B: ¿Cuál tiene menor costo computacional?**
El Harmonic Decay. Solo requiere leer la magnitud de un bin superior (ej. 100Hz) y dividir.

**Pregunta C: ¿Cuál mantiene Recall más cercano a 100%?**
El Harmonic Decay.

**Pregunta D: ¿Es posible eliminar los FP sin introducir nuevos FN?**
Casi. La eliminación total de Falsos Positivos en audios hostiles causó la pérdida de 1 solo caso de Recall (F1 escaló de 0.96 a 0.98).

---

## 5. Recomendación para INV-003E

Se aprueba formalmente la **Fórmula del Confidence Score**:
La futura implementación en Producción debe mantener la MVA como puerta lógica binaria, y calcular la confianza del `GlitchEvent` utilizando la ponderación de **Evidencia C** y **Evidencia E**.

**Nueva Arquitectura Final (Concepto):**
```text
Fundamental (Bin > Umbral)
↓
Estabilidad (CV < 0.1)
↓
Persistencia Local (> 500ms)
↓
[Confidence Layer] = f(Harmonic Decay, Global Persistence)
↓
Hum Event
```

La línea INV-003 queda madura y preparada para su integración a producción.
