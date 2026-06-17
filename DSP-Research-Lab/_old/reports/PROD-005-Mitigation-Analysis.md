# PROD-005-Mitigation: Análisis de Fallos por Enmascaramiento y Soluciones Arquitectónicas

**Investigador:** Gemini DSP Research Agent
**Fecha:** Junio 2026
**Referencia:** PROD-005, Auditoría de Inyección Múltiple (Test_All2)

---

## 1. Naturaleza de la Falla: El Fenómeno de Enmascaramiento (Masking)

La auditoría de los algoritmos Vostok utilizando el dataset de inyección combinada (`all_mixed`) reveló que la detección de transitorios (Clicks, Pops, Clipping) colapsa totalmente en presencia de ruido estacionario (Hiss) e interferencia de red (Hum). 

La causa raíz no es un error de código per se, sino un fenómeno físico: **El enmascaramiento aditivo**.

### 1.1 Falla en Clipping (Rizado inducido)
*   **Mecanismo:** El detector busca muestras consecutivas con derivada casi cero ($\Delta < 0.0001$). Al inyectar Hiss y Hum *después* de saturar la onda, la zona plana adquiere un micro-rizado que rompe la condición de derivada nula.
*   **Impacto:** Fallo total. El clipping real en grabaciones ruidosas analógicas será invisible.

### 1.2 Falla en Clicks (Saturación HFER)
*   **Mecanismo:** El detector valida impulsos exigiendo un *High-Frequency Energy Ratio* (HFER) que triplique la media del entorno. El ruido blanco del Hiss eleva artificialmente el piso de alta frecuencia, reduciendo el ratio de los Clicks por debajo del umbral del 300%.
*   **Impacto:** Fallo total. Transitorios débiles en pistas con siseo de cinta serán ignorados.

### 1.3 Falla en Pops (Saturación LFER)
*   **Mecanismo:** Se detectan por picos de energía de baja frecuencia (LFER). El Hum de 50/60Hz satura los bins de baja frecuencia de manera estacionaria, ahogando la asimetría temporal del Pop.
*   **Impacto:** Falsos negativos masivos en recintos con interferencia eléctrica.

### 1.4 Colapso del Clustering (Error Lógico)
*   **Mecanismo:** Agrupar `GlitchEvents` de naturaleza transitoria (finitos) y estacionaria (continuos) en una misma matriz temporal destruye la heurística del agrupador de 15ms. Cuando un bloque de Hiss se intercala con un Click, el agrupador asume un cambio de "familia", fragmentando ambos.

---

## 2. Estrategias de Solución y Análisis de Riesgo / Viabilidad

### Solución A: Segregación Arquitectónica de Eventos
**Propuesta:** El backend de Rust ya no devolverá un único `Vec<GlitchEvent>`. Separará los hallazgos en:
1.  `Vec<TransientEvent>` (Clicks, Pops, Drops, Slips): Sujetos a clustering milimétrico.
2.  `Vec<StationaryCondition>` (Hum, Hiss): Tratados como "regiones" (`start_sec`, `end_sec`, `confidence`, `magnitude_profile`).
**Análisis de Viabilidad:**
*   **Riesgo:** Requiere actualizar los tipos de TypeScript en el Frontend y modificar el componente `GlitchPanel.jsx` para parsear dos arrays distintos.
*   **Cuello de Botella:** Ninguno. De hecho, acelera la ejecución en Rust al liberar al algoritmo de clustering de evaluar condiciones estacionarias irrelevantes.
*   **Veredicto:** **Viable y Obligatorio.** Resuelve el colapso lógico del array unificado.

### Solución B: Pipeline DSP en Cascada (Pre-filtrado)
**Propuesta:** Los algoritmos no pueden evaluar el audio original en crudo si hay filtros de Hum/Hiss activos.
1.  Si Hum está activo: Se aplica un Notch Filter a 50/60Hz sobre un buffer de clonación *antes* de enviarlo al detector de Pops.
2.  Si Hiss está activo: El detector de Clicks ajusta dinámicamente su exigencia HFER. En lugar de exigir `HFER > avg_bg * 3.0`, usará una curva de mitigación: `umbral = max(1.5, 3.0 - (Hiss_RMS * k))`.
**Análisis de Viabilidad:**
*   **Riesgo:** Aplicar filtros IIR/Notch al dominio del tiempo crea un *buffer_copy*, lo que aumenta el consumo de RAM.
*   **Cuello de Botella:** Riesgo Medio. Múltiples pasadas sobre el array de audio pueden degradar la latencia de respuesta de los actuales ~15ms a ~40ms en archivos largos.
*   **Veredicto:** **Viable con Optimización.** El Notch filter no debe aplicarse al audio completo, sino que el detector de Pops debe excluir (ignorar) los bins 4 y 5 (50/60Hz) durante su cálculo LFER directamente en el espectrograma analítico. Esto tiene costo $O(1)$.

### Solución C: Clipping Dinámico Tolerante a Ruido (Derivada Suavizada)
**Propuesta:** El detector de clipping debe ser ciego al micro-ruido. Antes de calcular la derivada de planitud ($d_1[n] \approx 0$), el buffer de análisis debe someterse a un suavizado de media móvil ultracorta (ej. ventana de 3 a 5 muestras).
**Análisis de Viabilidad:**
*   **Riesgo:** Un suavizado fuerte puede redondear esquinas y ocultar el inicio exacto del clipping.
*   **Cuello de Botella:** Riesgo Bajo. Una media móvil de 3 muestras en Rust con optimización de iteradores toma menos de 1 milisegundo por minuto de audio.
*   **Veredicto:** **Altamente Viable.** Transforma el detector de idealista a pragmático. Reemplazará la tolerancia actual rígida (`1e-4`).

---

## 3. Conclusión Ejecutiva

Las soluciones propuestas son **técnicamente sólidas y computacionalmente viables**. 

Evitan la creación de cuellos de botella al trasladar las correcciones del dominio del tiempo (costoso) al dominio espectral (gratis, pues la STFT ya está pre-calculada en memoria por `AnalyticalSpectrogram`).

La segregación de arrays (`Transient` vs `Stationary`) en la IPC es el cambio más invasivo, requiriendo actualización Full-Stack (Rust + React), pero es la única arquitectura escalable que evitará que futuros detectores (ej. Reverb Reduction) colapsen la telemetría UI.
