# Current Research: Vostok DSP

**Estado del Motor**: Línea base establecida y **validada** (v1.0) mediante [INV-000].

## Investigaciones Completadas:
1. **INV-000 Baseline Validation**: (Completado) Validó y documentó la equivalencia entre el código fuente `dsp.rs` actual y las especificaciones teóricas del Baseline, identificando funciones heredadas no documentadas (`detect_glitches`).
2. **INV-001 Click Calibration**: (Completado) Evaluó el detector de clicks STFT. Se comprobó matemáticamente el error en el cálculo del umbral *Spectral Bandwidth* y se determinó experimentalmente (F1 = 0.16) que la detección de micro-clicks debe relegarse al dominio temporal debido a la dilución de energía en ventanas FFT.

3. **INV-001A Micro-Click Detection Study**: (Completado) Benchmarking de 5 detectores temporales en Rust. Se comprobó que el Filtro Predictivo Adaptativo LMS (Candidato D) es el algoritmo óptimo para reemplazar a `detect_glitches`, logrando 100% de Recall en ~85ms.
4. **INV-001B LPC Detector Optimization**: (Completado) Grid Search paramétrico y adición de post-procesamiento (Clustering temporal). Se redujeron los Falsos Positivos de ~104 a 19 (FN=0) usando LPC de orden 2 y umbral RMS=6.

5. **INV-001C Real-World Validation**: (Completado) Auditoría de Data Augmentation sobre audios del mundo real. Se comprobó que el algoritmo temporal óptimo sufre de severo Overfitting, disparando cientos de Falsos Positivos ante transitorios naturales y perdiendo el Recall absoluto.
6. **INFRA-001 Analytical Spectrogram Foundation**: (Completado) Implementación del pipeline paralelo del espectrograma, aislando la estructura base de las mutaciones visuales y permitiendo la obtención asíncrona de recortes espectrales en Float32 para futuros análisis y algoritmos en el frontend.
7. **INFRA-002 Analytical Spectrogram Validation**: (Completado) Verificación empírica de la precisión de `AnalyticalSpectrogram` usando señales controladas (Dirac, Hum, Dropouts). La infraestructura demostró una exactitud y coherencia absoluta, aprobándola como la nueva capa oficial del *DSP Lab*.
8. **INV-001D Hybrid Temporal-Spectral Click Detection**: (Completado) Implementación de un filtro cruzado post-LPC utilizando *High-Frequency Energy Ratios* en la STFT analítica. Redujo los Falsos Positivos de over-fitting en un 90% (de 3344 a 352) manteniendo un 80% de recall absoluto. Solución aprobada para entorno de producción.
9. **INV-001E Adaptive HFER Grid Search**: (Completado) Confirmación de que el umbral absoluto HFER controla eficazmente los Falsos Positivos (llevándolos a casi 0 en voces limpias), pero los Falsos Negativos en música ruidosa ocurren debido al enmascaramiento del ruido de fondo y no al umbral estático. Cierre oficial de la línea de detección de Clicks.

10. **PROD-001 Hybrid Click Detector Integration**: (Completado) Integración oficial del detector híbrido (LPC + HFER) en el backend (dsp.rs), protegiendo la retrocompatibilidad mediante feature flags y dotando a los GlitchEvents de una puntuación de confianza continua basada en la sensibilidad espectral.

11. **INV-002 Pop Characterization Study**: (Completado) Determinó que el Pop es de naturaleza híbrida (Temporal-Espectral) con asimetría masiva y LFER extremo.
12. **INV-002A Pop Candidate Detector Study**: (Completado) Simuló candidatos y determinó que Local DC Offset + LFER supera todas las otras opciones de detección.
13. **INV-002B Pop Prototype Study**: (Completado) Validó el prototipo Python en audios vocales, detectando 5 pops inyectados sin falsos positivos.
14. **INV-002C Pop Real-World Validation**: (Completado) El algoritmo se rompió exitosamente contra *Música en vivo* generando 137 Falsos Positivos causados por viento y rumble real. Se requiere evolución de la arquitectura para incorporar *Context Ratio Validation*.
15. **INV-002D Pop Context Validation Study**: (Completado) Confirmó que la métrica 'Context Ratio' (DC Peak / DC Surround) separa perfectamente un Pop aislado de un viento continuo (Rumble max CR = 28, Pops min CR = 46). Precisión y Recall devueltos al 100%.
16. **PROD-003 Pop Detector Integration**: (Completado) Migración nativa del algoritmo de Context Ratio al backend de Rust. El detector procesa de forma híbrida e incluye validaciones temporales (LFER) para un recall de 100% libre de falsos positivos en 800ms.

## Investigaciones en Curso
- **PROD-004**: Pop Detector UX Integration

## Investigaciones Prioritarias Pendientes:
- **PROD-004**: Diseño y prototipado UI del Hybrid Pop Detector
- **INV-003**: Calibración Detector Hum
- **INV-004**: Calibración Detector Dropout
- **INV-005**: Calibración Detector Clipping
- **INV-006**: Evaluación de Hermite Cubic Repair
- **INV-007**: Motor de Selección Automática de Reparación
- **INV-008**: Detector Hiss
- **INV-009**: Detector Crackle
- **INV-010**: Sistema de Clasificación Probabilística
