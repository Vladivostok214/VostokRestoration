# INV-003-Hum-Characterization: Estudio de la Firma Física del Hum

**Investigador:** Gemini DSP Research Agent
**Fecha:** Junio 2026
**Proyecto:** Vostok Restoration V1
**Referencia:** AF-001 → AF-009, PARADIGM_UPDATE_V2

---

## 1. Resumen de Hallazgos (Executive Summary)

El Hum eléctrico se confirma como el **primer artefacto de naturaleza predominantemente Espectral y Contextual** en el ecosistema Vostok. A diferencia de los Clicks y Pops (Transitorios), el Hum carece de una firma temporal de "impulso" o "asimetría DC" útil para la detección por candidatos aislados. Su identidad reside en la **estabilidad de fase y magnitud en bins de frecuencia específicos** a lo largo de ventanas de tiempo extendidas.

---

## 2. Pregunta Principal: ¿Cuál es la firma física dominante?

**Firma Dominante:** Espectral (Estrechez de Banda) y Contextual (Persistencia Temporal).

### Evidencia:
- **Dominio Espectral:** El Hum se manifiesta como picos de energía en bins de frecuencia ultra-estrechos ($< 10\text{ Hz}$). Su ancho de banda espectral es mínimo comparado con cualquier transitorio musical.
- **Dominio Temporal:** En el dominio del tiempo, el Hum es indistinguible de una nota musical pura sin el contexto de su **estabilidad infinita**. Mientras que una nota musical tiene un ciclo de vida (Ataque, Decaimiento, Sostenido, Relajación), el Hum es una condición de estado del sistema.

---

## 3. Hipótesis: ¿Es predominantemente Espectral?

**Resultado:** **DEMOSTRADO (Híbrido con predominancia Espectral).**

Si bien el Hum tiene una periodicidad perfecta en el tiempo, su separación del contenido legítimo es imposible sin la resolución del `AnalyticalSpectrogram`. El Hum "vive" en la estructura armónica inamovible de la red eléctrica, no en la dinámica del audio.

---

## 4. Diferenciación de Artefactos (Firmas Comparativas)

| Característica | Hum Eléctrico | Nota Musical (Seno) | Bajo Sostenido | Ruido de Ventilador (HVAC) |
| :--- | :--- | :--- | :--- | :--- |
| **Frecuencia** | Estática (50/60Hz) | Variable (Vibrato/Portamento) | Dinámica (Envolvente de Pitch) | Resonancia de Banda Ancha |
| **Armónicos** | Serie Perfecta ($n \cdot f_0$) | Serie con Inarmonicidad | Ricos en Medios/Altos | Inexistentes (Ruido de Aire) |
| **Spectral Flux** | $\approx 0$ (Inmutable) | Dinámico ($> 0$) | Dinámico | Estable pero con Jitter |
| **Flatness** | Muy Baja (Tonal) | Baja | Media-Baja | Alta (Ruido Blanco/Rosa) |
| **Persistencia** | Infinita (Contextual) | Finita (Musical) | Finita | Continua |

### 4.1 Hum vs. Bajo Eléctrico
El bajo eléctrico, aunque ocupe frecuencias similares, presenta un **Spectral Flux** significativo durante el ataque de la cuerda y una inestabilidad de fase natural. El Hum es matemáticamente "frío" y perfectamente coherente.

### 4.2 Hum vs. Ventiladores/HVAC
Los ventiladores generan "Rumble" de banda ancha. En el `AnalyticalSpectrogram`, el ventilador eleva el piso de ruido en un rango de frecuencias (ej. 40-100Hz), mientras que el Hum inyecta energía en un **bin específico**.

---

## 5. Caracterización por Dominios (AF-001)

### 5.1 Dominio Temporal (Insuficiente)
- **RMS/Envelope:** El Hum mantiene una envolvente plana. No genera transitorios.
- **Conclusión:** No existe una firma temporal que permita identificar Hum en ventanas de < 100ms sin riesgo masivo de falsos positivos.

### 5.2 Dominio Espectral (Dominante)
- **Frecuencia Fundamental ($f_0$):** Bloqueada a 50Hz/60Hz.
- **Serie Armónica:** Presencia de armónicos impares (común en transformadores saturados) o pares/impares (Ground Loops).
- **Conclusión:** El `AnalyticalSpectrogram` revela el Hum como "líneas" verticales inamovibles en la matriz de magnitudes.

### 5.3 Dominio Contextual (Crítico)
- **Estabilidad de Larga Duración:** El Hum requiere un análisis de persistencia ($> 500\text{ ms}$) para ser clasificado como interferencia. Una nota de órgano puede durar segundos, pero el Hum permanece incluso en los silencios entre frases musicales.

---

## 6. Comparativa con Clicks y Pops

| Artefacto | Dominio Dominante | Mecanismo de Detección |
| :--- | :--- | :--- |
| **Click** | Temporal (LPC) | Impulso / High Frequency Spike |
| **Pop** | Híbrido (DC Offset + LFER) | Explosión de Graves / Asimetría |
| **Hum** | Espectral / Contextual | Estabilidad de Bin / Armónicos |

---

## 7. Recomendación para INV-003A

Se recomienda que la fase de investigación **INV-003A** se centre en la **Validación de Estabilidad de Fase**. 

**Pregunta científica para INV-003A:**
¿Es la coherencia de fase entre ventanas consecutivas la métrica definitiva para distinguir un armónico musical (que fluctúa) de un Hum eléctrico (que es coherente)?

---

## 8. Conclusión Física

El Hum no es un "evento" de audio; es una **señal portadora parásita**. Su firma física es la **anti-dinámica**: la ausencia total de cambio en frecuencia y magnitud sobre la matriz analítica de la STFT.
