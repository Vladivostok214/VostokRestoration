# INV-003C-Hum-Real-World-Validation: Benchmark en Entorno Real

**Investigador:** Gemini DSP Research Agent
**Fecha:** Junio 2026
**Referencia:** INV-003B, AF-001 → AF-016

---

## 1. Auditoría y Extensión del Generador (Fase 1 y 2)

Se auditó el script `degradar_audio.py`. Al verificar que carecía de soporte para artefactos continuos, se reescribió para inyectar ruido parasitario a lo largo de toda la pista. Se implementaron 5 perfiles de estrés:
1.  **Hum 50Hz:** Seno puro constante.
2.  **Hum 60Hz:** Seno puro constante.
3.  **Ground Loop:** Fundamental + 3 armónicos con decaimiento de amplitud $1/n$.
4.  **Hum Modulado:** Portadora de 50Hz modulada por un LFO de 0.5Hz.
5.  **Hum Intermitente:** Portadora de 50Hz activada en ráfagas de 2 segundos.

---

## 2. Benchmark del Dataset (Fase 3 y 4)

Se generaron 30 audios degradados a partir de las 6 muestras base de Vostok (`bateria`, `musicaconmetronomo`, `musicaenvivo`, `musicapesada`, `vozbajacalidad`, `vozenoff`).
Se ejecutó la MVA (Arquitectura C: `F0 -> CV < 0.1 -> Persistencia > 50%`) sobre el dataset completo más los originales (negativos).

### 2.1 Tabla de Métricas Globales

| Métrica | Valor Obtenido |
| :--- | :--- |
| **True Positives (TP)** | 30 |
| **True Negatives (TN)** | 4 |
| **False Positives (FP)** | 2 |
| **False Negatives (FN)** | 0 |
| **Precision** | **0.9375** |
| **Recall** | **1.0000** |
| **F1-Score** | **0.9677** |

---

## 3. Análisis de Fallos (Fase 5)

### 3.1 Falsos Negativos (FN = 0)
La arquitectura detectó el 100% de los ataques de Hum, incluso los modulados e intermitentes. La ventana de CV (200ms) es lo suficientemente pequeña para tolerar modulaciones lentas, y la ventana de persistencia (800ms) es lo suficientemente corta para capturar ráfagas de 2 segundos.

### 3.2 Falsos Positivos (FP = 2)
Se detectaron Falsos Positivos en audios originales limpios:
1.  **`musicapesada.wav`:** (Instrumentos). Las guitarras distorsionadas y bajos ultra-comprimidos actúan como drones. La compresión destruye la dinámica, generando un Coeficiente de Variación (CV) artificialmente bajo que engaña al detector.
2.  **`musicaenvivo.wav`:** (Ambientes). El "Rumble" continuo del sistema PA y la resonancia del recinto generan frecuencias estacionarias en los graves que imitan el comportamiento eléctrico.

---

## 4. Respuestas a Preguntas de Investigación

**Pregunta A: ¿Qué tipo de Hum es más difícil de detectar?**
El Hum altamente modulado o intermitente rápido (ráfagas $< 500\text{ms}$). Aunque nuestro dataset no falló, forzó a las métricas de CV y Persistencia al límite. Un Hum que varíe de amplitud rápidamente disparará el CV y será clasificado erróneamente como música.

**Pregunta B: ¿Qué tipo de contenido produce más falsos positivos?**
La música pesada ultra-comprimida y los drones densos.

**Pregunta C: ¿La arquitectura falla por Fundamental, CV, Persistencia o Confidence?**
Falla por **CV y Persistencia**. En música pesada, el RMS de los graves no fluctúa (engaña al CV) y persiste por segundos (engaña a la Persistencia).

**Pregunta D: ¿Existe una evidencia adicional no descubierta todavía?**
La arquitectura evaluada (C) omitió deliberadamente la **Fase** y los **Armónicos** (evaluados en INV-003B) para comprobar el baseline mínimo. Queda demostrado que sin ellos, el "paredón" final no resiste el audio altamente comprimido. 

---

## 5. Recomendación y Siguientes Pasos

**Estado:** **Requiere INV-003D / Rediseño del Confidence Score.**

La MVA tiene un Recall excepcional, pero una Precision inaceptable para producción en escenarios musicales agresivos. Un Falso Positivo en música pesada significaría que Vostok mutilaría los graves de la canción.

**Recomendación Arquitectónica Definitiva:**
La arquitectura NO debe emitir un dictamen binario basado solo en CV. Debe integrarse un modelo continuo:
1. `Candidato (F0)`
2. `Validación Base (CV + Persistencia)` -> Genera Evento Previo.
3. `Calibración Final (Fase + Armónicos)` -> Pondera el **Confidence Score**. Si el Confidence es $< 0.8$ (ej. música pesada sin coherencia de fase de red), se descarta silenciosamente.
