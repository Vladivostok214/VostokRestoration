# DOC-003: Vostok DSP Research Lab State Snapshot

**Fecha de Generación:** Junio 2026
**Estado General:** Activo y en fase de maduración arquitectónica (Post INV-002).

---

## 1. Estado Actual del Laboratorio
El DSP Research Lab de Vostok Restoration V1 ha superado la validación de sus algoritmos de Clicks (INV-001) y Pops (INV-002). Las implementaciones monolíticas basadas en thresholds estáticos demostraron ser ineficaces contra el Overfitting provocado por el audio natural. El laboratorio transita exitosamente hacia arquitecturas "Híbridas" y "Contextuales", utilizando la infraestructura base del `AnalyticalSpectrogram`.

## 2. Paradigmas Vigentes
1. **Evitar Detectores Monolíticos:** Un artefacto no es un evento binario basado en un threshold mágico.
2. **First Principles (Caracterización Inicial):** No se diseñan detectores sin antes caracterizar exhaustivamente la naturaleza física (Temporal, Espectral, o Híbrida) del artefacto.
3. **Fronteras Físicas Infranqueables:** La separación perfecta en el mundo real es imposible; se debe diseñar priorizando *Confidence Scores* y reduciendo los Falsos Positivos causados por ruido de fondo dinámico.
4. **Diseño Híbrido Obligatorio:** Todo detector debe medir candidatos en el dominio temporal y validadarlos con la matriz espectral analítica, cruzando múltiples capas de evidencia matemática.

## 3. Hallazgos Arquitectónicos (AF-001 → AF-009)
- **AF-001 [Taxonomía de Dominios]:** Los artefactos deben clasificarse primero por su dominio físico dominante (Temporal, Espectral, Híbrido, Contextual).
- **AF-002 [Arquitectura en Capas]:** La arquitectura requerida es `Candidato -> Validación -> Confidence -> Clasificación`.
- **AF-003 [Necesidad Híbrida]:** Artefactos como Micro-Clicks probaron la necesidad de capas temporales (LPC) filtradas por capas espectrales (HFER).
- **AF-004 [Aceptación de Límites]:** Existen escenarios sin separabilidad perfecta (ej. Guitarra Distorsionada vs Ruido Blanco). Se debe exponer la sensibilidad y no perseguir la perfección utópica.
- **AF-005 [Flujo Mandatorio]:** `Caracterización -> Dominio -> Candidato -> Validación Real -> Calibración -> Integración`.
- **AF-006 [Uso de Analytical Spectrogram]:** La infraestructura analítica del espectrograma es obligatoria para la validación espectral en investigación. El *Visual Spectrogram* queda prohibido para análisis matemático.
- **AF-007 [Producción de Confidence]:** Todo evento (ej. `GlitchEvent`) debe retornar una métrica de `Confidence` como ciudadano de primera clase.
- **AF-008 [Aislamiento Contextual - Context Ratio]:** Derivado de INV-002D. Para distinguir eventos explosivos de condiciones climáticas o sonoras sostenidas (ej. Pop vs Rumble), no basta la amplitud; es mandatorio medir el Context Ratio temporal (Peak DC vs Surround DC).
- **AF-009 [Backend Híbrido Optimizado]:** Derivado de PROD-003. La migración a Rust de los detectores debe operar *Zero-Copy* en memoria unificada, solicitando datos temporales y fragmentos espectrales de forma asíncrona, para mantener los tiempos de procesamiento por debajo del segundo para pipelines complejos de múltiples capas.

## 4. Infraestructura Disponible
- **Motor STFT Paralelo:** Resolución analítica con `RustFFT` y `Rayon` (Transient y Hum-Mastering profiles).
- **Analytical Spectrogram Matrix:** Capa unificada, independiente del espectrograma visual frontend, que expone datos en Float32 (Magnitudes) sin mapeo a color (INFRA-001, INFRA-002).
- **Sistema de Inyección de Frecuencias:** Banco de simulaciones y audios de estrés reales (Clicks en viento, Pops sobre batería, Rumble sobre música en vivo).
- **Hermite Cubic Repair:** Interpolarización spline nativa funcional sobre `dsp.rs`.

## 5. Detectores Validados y En Producción
1. **Hybrid Click Detector (PROD-001):** 
   - Arquitectura: Filtro Predictivo (LPC) -> High-Frequency Energy Ratio (HFER) Validation.
   - Rendimiento: 100% Precision, supresión completa de ruido blanco sostenido.
2. **Hybrid Pop Detector (PROD-003):**
   - Arquitectura: Local DC Offset -> LFER Gate (<150Hz) -> Context Ratio Validation (CR > 35).
   - Rendimiento: Recall perfecto (100%) sobre audios en vivo descartando el viento severo natural como Falsos Positivos.

## 6. Investigaciones Pendientes (Roadmap)
- **PROD-004:** Diseño y prototipado UI del Hybrid Pop Detector (Integrar en GlitchPanel).
- **INV-003:** Calibración Detector Hum (Búsqueda de armónicos espurios vs frecuencias base).
- **INV-004:** Calibración Detector Dropout (Fallas masivas de energía de banda ancha).
- **INV-005:** Calibración Detector Clipping (Achatamiento de picos y reconstrucción de ondas).
- **INV-006:** Evaluación de Hermite Cubic Repair.
- **INV-007:** Motor de Selección Automática de Reparación (Recomendar entre Hermite Spline vs Interpolación Espectral según el artefacto).
- **INV-008:** Detector Hiss.
- **INV-009:** Detector Crackle.
- **INV-010:** Sistema de Clasificación Probabilística Integral.

## 7. Riesgos Conocidos
1. **Rendimiento UI:** Pintar cientos o miles de GlitchEvents sobre canvas/WebGL puede causar cuellos de botella severos, requiriendo paginación u optimización LOD en el frontend.
2. **Solapamiento Espectral:** A medida que incorporamos Hum y Dropout, múltiples detectores pueden disparar eventos falsos cruzados; hace falta jerarquización o mutua exclusión probabilística (mitigado con INV-010).
3. **Escalabilidad de Memoria:** Almacenar matrices STFT en `Float32` de archivos muy largos (más de 1 hora) puede sobrepasar presupuestos de memoria en equipos humildes y requerirá `memmap` a disco en vez de residir puramente en la RAM (`AppState`).
