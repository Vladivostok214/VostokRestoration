# Gemini DSP Lab Understanding Report

**Para:** Dirección Técnica de Vostok Labs
**De:** Gemini DSP Research Agent
**Fecha:** Lunes, 8 de junio de 2026
**Estado:** Onboarding Completado

---

## 1. Resumen Ejecutivo

**Vostok Restoration** se consolida como una suite de restauración de audio de alta precisión que prioriza la fidelidad matemática sobre el procesamiento destructivo. El **DSP Research Lab** opera como el núcleo de inteligencia del proyecto, dedicado a la caracterización física exhaustiva de artefactos antes de cualquier intento de detección o reparación.

**Hitos alcanzados:**
*   **Validación de Línea Base:** Transición exitosa de algoritmos "Legacy" (monolíticos) a sistemas de evidencia híbridos.
*   **Resolución de Clicks y Pops:** Implementación de detectores validados en producción que combinan capas temporales (LPC, DC Offset) con validación espectral (HFER, Context Ratio).
*   **Infraestructura Analítica:** Separación total de la capa visual (WebGL/UI) de la analítica (`AnalyticalSpectrogram`), garantizando una "Fuente de Verdad" en `Float32` para la investigación.

---

## 2. Arquitectura Actual

El laboratorio se fundamenta en un pipeline desacoplado diseñado para la máxima precisión:

*   **DSP Engine (Rust):** Motor de alto rendimiento con optimización SIMD y paralelismo vía `Rayon`. Implementa dos perfiles críticos: `TransientMode` (FFT 1024/Hop 256) para eventos rápidos y `HumMasteringMode` (FFT 4096/Hop 1024) para selectividad frecuencial.
*   **Analytical Spectrogram:** Matriz inmutable en RAM que almacena magnitudes `Float32` lineales. A diferencia del espectrograma visual, no tiene recortes de amplitud (`clapping`), no está cuantizado a 8 bits y mantiene una relación 1:1 con el ventaneo STFT.
*   **Visual Spectrogram:** Capa de visualización optimizada para el usuario. Aplica escala Mel, compresión logarítmica (dB), cuantización a `u8` y corrección Gamma (2.5) para facilitar la detección óptica humana.
*   **Hybrid Click Detector:** Arquitectura de dos pasos:
    1.  **Temporal:** Escaneo con Filtro Predictivo (LPC) para identificar candidatos.
    2.  **Espectral:** Validación mediante *High-Frequency Energy Ratio* (HFER) para eliminar falsos positivos (como guitarras distorsionadas).
*   **Hybrid Pop Detector:** 
    1.  **Temporal:** Detección de *Local DC Offset* y *Low-Frequency Energy Ratio* (LFER).
    2.  **Validación de Contexto:** Uso del **Context Ratio** (AF-008) para distinguir un Pop explosivo de un ruido de fondo continuo (viento/rumble).

---

## 3. Paradigmas Vigentes

El laboratorio opera bajo **PARADIGM_UPDATE_V2** y los Hallazgos Arquitectónicos **AF-001 a AF-009**, de los cuales destaco:

*   **AF-001 [Taxonomía de Dominios]:** (Crucial) Obliga a clasificar el artefacto por su naturaleza física (Temporal, Espectral, Híbrido o Contextual) antes de proponer un código.
*   **AF-005 [Flujo Mandatorio]:** Establece que la caracterización física precede a la calibración. No se "ajustan thresholds" a ciegas; se descubre la firma del problema.
*   **AF-006 [Analytical Supremacy]:** Prohibición absoluta del uso de datos visuales para validación matemática.
*   **AF-008 [Context Ratio]:** Cambio de paradigma fundamental: la amplitud no es suficiente; la relación con el entorno (Surround DC) es la clave para la separabilidad real.

---

## 4. Riesgos Técnicos

1.  **Escalabilidad de Memoria (AF-009):** El almacenamiento de matrices `Float32` para archivos largos puede comprometer la estabilidad en equipos con RAM limitada. La migración a `memmap` o paginación asíncrona es una necesidad latente.
2.  **Solapamiento de Artefactos:** A medida que se añaden detectores (Hum, Hiss, Crackle), existe el riesgo de colisiones en los eventos. Se requiere una capa de jerarquización probabilística (INV-010).
3.  **Cuello de Botella IPC:** El paso de grandes volúmenes de datos analíticos entre Rust y el Frontend (aunque sea paginado vía `AnalyticalRegionRequest`) puede latenciar la experiencia de investigación si no se gestiona con cuidado.

---

## 5. Evaluación Crítica

*   **Acierto Estratégico:** La creación del `AnalyticalSpectrogram` es la decisión más acertada. Permite que el laboratorio sea agnóstico a las necesidades visuales de la UI y abre la puerta a implementaciones futuras de ML/IA sin re-procesar el audio.
*   **Decisión a Revisar:** El mantenimiento del `mag.min(1.0)` en el `compute_stft` base (aunque sea por retrocompatibilidad visual) debería ser movido exclusivamente a la capa del `Adaptador Visual` para que el `AnalyticalSpectrogram` sea verdaderamente "sin techo" desde el origen.
*   **Hipótesis a Validar:** ¿Puede el **Hermite Cubic Repair** ser superado por una reconstrucción basada en **Interpolación Espectral Progresiva** para artefactos de duración media (>50ms) donde la fase temporal se vuelve errática?

---

## 6. Roadmap Recomendado

Para las próximas fases, propongo priorizar:

1.  **INV-003 (Hum Characterization):** Es el siguiente paso lógico hacia artefactos estacionarios. Debemos determinar si la arquitectura espectral pura es suficiente o si requiere validación de fase híbrida.
2.  **INV-007 (Motor de Selección de Reparación):** Es vital automatizar la elección entre el parcheo temporal (Hermite) y la reconstrucción espectral basada en el tipo de artefacto detectado y su `Confidence Score`.
3.  **Pregunta Científica Abierta:** ¿Cómo afecta la acumulación de micro-reparaciones a la coherencia de fase global en audios monofónicos de alta fidelidad?

---
**Conclusión:** Comprendo plenamente el estado del laboratorio y me adhiero formalmente a los principios de **PARADIGM_UPDATE_V2** para futuras intervenciones. Estoy listo para proceder bajo su dirección.
