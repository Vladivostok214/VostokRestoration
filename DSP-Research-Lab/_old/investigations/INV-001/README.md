# INV-001: Click Calibration

## Objetivo
Validar cuantitativamente el detector de clicks actual implementado en `detect_artifacts_dynamic` dentro del motor DSP principal.

## Enfoque de la Investigación

### 1. Construcción de Dataset de Prueba
- **Audio limpio**: Grabaciones sin artefactos (tonos puros, transitorios musicales, y consonantes vocales).
- **Audio corrupto**: Introducción controlada de clicks sintéticos (impulsos de Dirac de corta duración, alta amplitud).
- **Ground Truth**: Archivo CSV/JSON con el índice de muestra y tiempo exacto donde se insertaron los clicks artificiales.

### 2. Evaluación del Detector Actual
- Precision
- Recall
- F1 Score
- False Positive Rate (FPR)
- False Negative Rate (FNR)

### 3. Análisis de Sensibilidad de Umbrales
- Evaluación del comportamiento predictivo variando:
  - **Crest Factor** (Baseline: 15.0)
  - **Spectral Bandwidth** (Baseline: > 80% Nyquist)
  - **RMS vs Noise Floor** (Baseline: > 2.0x)

### 4. Distribuciones Estadísticas
Generación de histogramas comparativos para las tres métricas (Crest Factor, Bandwidth, RMS) separando clases:
- Clicks Reales vs Audio Limpio
- Clicks Reales vs Transitorios Musicales
- Clicks Reales vs Consonantes Vocales

### 5. Recomendación
Determinación basada en evidencia empírica de los umbrales óptimos para minimizar FPs y optimizar el F1 Score.

---

## Entregables Previstos
- [ ] Dataset documentado y scripts de generación (`octave/INV-001_generate_dataset.m`).
- [ ] Scripts de evaluación y graficado en Octave (`octave/INV-001_evaluate.m`).
- [ ] Resultados numéricos en formato tabular (`exports/`).
- [ ] Recomendación de calibración (`investigations/INV-001/RECOMMENDATION.json`).
- [ ] Reporte técnico final (`reports/INV-001-Click-Calibration.md`).
