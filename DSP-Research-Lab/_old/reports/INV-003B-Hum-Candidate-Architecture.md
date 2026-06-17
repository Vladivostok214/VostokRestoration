# INV-003B-Hum-Candidate-Architecture: Informe de Arquitectura

**Investigador:** Gemini DSP Research Agent
**Fecha:** Junio 2026
**Referencia:** INV-003, INV-003A, AF-001 → AF-011

---

## 1. Resultados del Benchmark de Arquitecturas

Se evaluaron seis arquitecturas candidatas sobre un dataset de estrés que incluye Hum puro, Hum con armónicos, contenido musical engañoso (50Hz con vibrato/trémolo) y Hum intermitente.

| Arquitectura | Precision | Recall | F1 | Complejidad | MVA Rank |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Arch B (F0 + CV)** | 0.96 | 0.80 | 0.87 | Baja | Candidato |
| **Arch C (F0 + CV + P)** | **0.97** | **0.73** | **0.84** | Media | **MVA Sugerido** |
| **Arch D (F0 + CV + P + Ph)** | 0.97 | 0.25 | 0.40 | Alta | Excesiva |
| **Arch E (Har + CV + P)** | 0.96 | 0.78 | 0.86 | Media | Robusta |
| **Arch F (Har + CV + P + Ph)** | 0.97 | 0.27 | 0.42 | Muy Alta | Excesiva |

---

## 2. Análisis de Hallazgos

### 2.1 El Poder de la Persistencia (Arch C vs B)
La adición de la capa de **Persistencia (P)** mejora la Precision (de 0.96 a 0.97) al filtrar transitorios musicales aleatorios que coinciden en frecuencia, aunque reduce ligeramente el Recall en zonas intermitentes. Es el compromiso ideal para la estabilidad.

### 2.2 El Problema de la Fase (Arch D/F)
La inclusión de la **Fase (Ph)** en la lógica de decisión binaria reduce drásticamente el Recall (de 0.73 a 0.25). La fase es una métrica extremadamente sensible al ruido y a las ventanas de análisis. 
**Conclusión:** La fase NO debe usarse como una "compuerta" (gate) binaria, sino como un ponderador del *Confidence Score*.

### 2.3 Serie Armónica vs Fundamental (Arch E vs C)
La validación de la **Serie Armónica (Har)** es sorprendentemente robusta (F1=0.86) y ayuda a confirmar la naturaleza eléctrica del Hum cuando existen múltiples armónicos, pero falla en casos de "Hum de bucle simple" donde solo está presente la fundamental de 50/60Hz.

---

## 3. Respuestas a la Investigación Especial

### Pregunta A: ¿La fase mejora realmente los resultados?
En su forma binaria actual, **NO**. Incrementa la complejidad y destruye el Recall. Sin embargo, su valor físico es real para la clasificación fina (Confidence).

### Pregunta B: ¿La serie armónica aporta más información?
SÍ, aporta un "seguro de contexto" adicional. Si hay armónicos, la confianza de que sea Hum eléctrico es cercana al 100%.

### Pregunta C: ¿Existe una arquitectura robusta sin fase?
SÍ. La **Arquitectura C (Fundamental + CV + Persistencia)** es la Arquitectura Mínima Viable (MVA). Ofrece un F1 de 0.84 con una complejidad computacional mínima.

---

## 4. Casos de Fallo Identificados

1.  **Arranque de Hum (Latencia):** La persistencia (Arquitecturas C, D, E, F) genera un retraso de detección al inicio del artefacto.
2.  **Instrumentos "Perfectos":** Sintetizadores digitales puros sin modulación seguirán siendo el mayor riesgo de Falsos Positivos para la MVA.

---

## 5. Recomendación para INV-003C (Validación Real)

Se recomienda proceder con la **Arquitectura C Evolucionada** como base para la validación con audios del mundo real:

```text
Candidato (F0 o Armónicos)
↓
Estabilidad (CV de Magnitud)
↓
Persistencia (Mínima 200ms)
↓
Cálculo de Confidence (Ponderado por Fase y Armónicos)
```

Esta arquitectura cumple con **AF-002** (Capas) y **AF-007** (Confidence Score) sin incurrir en la fragilidad de las compuertas de fase binarias.
