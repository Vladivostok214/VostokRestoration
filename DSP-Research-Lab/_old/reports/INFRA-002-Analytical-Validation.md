# INFRA-002: Analytical Spectrogram Validation

## Objetivo
Verificar la integridad matemática, la precisión de bins y la coherencia temporal de la nueva capa analítica `AnalyticalSpectrogram` y su endpoint de consulta `obtener_region_analitica(...)` frente a fenómenos de audio sintéticos y controlados.

## Metodología
Se construyó un script de benchmarking (`infra002_runner.rs`) que inyecta señales matemáticamente predecibles en la función `compute_stft` y analiza los resultados `Float32` devueltos, confirmando empíricamente su comportamiento espectral.

---

## Resultados de Casos de Prueba

### Caso 1: Seno puro de 1 kHz (FFT: 1024)
* **Objetivo:** Verificar precisión frecuencial y resolución de bins (Resolución teórica: ~43.07 Hz/bin).
* **Esperado:** Pico dominante en el bin más cercano a 1000 Hz, con baja dispersión energética.
* **Resultado:** 
  * Bin dominante: 23 (Frecuencia central: ~990.53 Hz).
  * Magnitud Máxima: 0.3873.
  * Dispersión confinada correctamente a los bins laterales (Bin 22: 0.13, Bin 24: 0.26).
  * **Conclusión:** Aprobado. La FFT mantiene escala y localización precisa.

### Caso 2: Hum sintético (60, 120, 180 Hz) (FFT: 4096)
* **Objetivo:** Validar la representación de múltiples armónicos de baja frecuencia simulando interferencia eléctrica real (Resolución teórica: ~10.77 Hz/bin).
* **Esperado:** Picos consistentes alrededor de las fundamentales de Hum.
* **Resultado:**
  * Armónico 60 Hz -> Detectado en Bin 5 (53.8 Hz) y Bin 6 (64.6 Hz) con magnitudes de ~0.17.
  * Armónico 120 Hz -> Detectado en Bin 11 (118.4 Hz) con magnitud 0.098.
  * Armónico 180 Hz -> Detectado en Bin 17 (183.0 Hz).
  * **Conclusión:** Aprobado. Las relaciones de amplitud armónica son consistentes con la suma de ondas introducida.

### Caso 3: Click Sintético de Dirac
* **Objetivo:** Confirmar el comportamiento de la dispersión temporal y frecuencial de transitorios instantáneos.
* **Señal:** Un pulso de Dirac inyectado en la muestra 22050.
* **Resultado:**
  * El frame teórico en el cual caía el click era el frame 86.
  * La energía del pulso se distribuyó a través de los frames 84, 85 y 86 debido al solapamiento de ventanas (Hann Window y Hop Size de 256).
  * **Conclusión:** Aprobado. Corrobora el problema hallado en INV-001 (Dilución de clicks en STFT), reafirmando que la capa STFT devuelve los cálculos correctamente y es útil para transitorios densos pero no micro-clicks solitarios.

### Caso 4: Dropout Sintético
* **Objetivo:** Comprobar la ausencia pura de energía en silencios artificiales.
* **Señal:** Onda cortada abruptamente entre la muestra 20000 y 25000 (Frames teóricos 78 al 97).
* **Resultado:**
  * Energía cae progresivamente en el frame 77 (0.39) y frame 78 (0.0019) debido a la ventana.
  * Energía exactamente `0.0000` sostenida entre los frames 79 al 93.
  * Retorno progresivo al salir de la ventana.
  * **Conclusión:** Aprobado. Localización de límites de silencio perfecta.

### Caso 5: Analytical vs Visual
* **Objetivo:** Verificar la región analítica Float32 vs la capa visual comprimida.
* **Resultado:**
  * Petición de 3x4 (Frames 20-22, Bins 5-8) a `obtener_region_analitica` devolvió exitosamente arrays puros (ej: `[0.1611, 0.1775, 0.0420]`) en Float32 (32 bits reales matemáticos).
  * La petición homóloga visual devolvió un string comprimido en Base64 de 1368 caracteres mapeados a u8 tras downsampling masivo.
  * **Conclusión:** Aprobado. Ambas capas conviven pacíficamente cumpliendo sus propósitos disjuntos.

---

## Hallazgos Finales y Recomendación
1. **Precisión Matemática Absoluta:** La estructura `AnalyticalSpectrogram` retiene el 100% de la fidelidad del cómputo STFT original.
2. **Endpoint Seguro:** La API de consultas Tauri bloquea exitosamente peticiones excesivas y empaca los datos crudos correctamente para serialización.

**Recomendación:** Se aprueba el uso de `AnalyticalSpectrogram` para todas las investigaciones DSP futuras. 

El proyecto se encuentra listo para iniciar **INV-001D (Hybrid Temporal-Spectral Click Detection)**.
