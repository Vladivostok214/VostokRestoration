# Reporte Final: INV-000 Baseline Validation

**Fecha de Auditoría**: Junio 2026
**Archivo Base**: `src-tauri/src/dsp.rs`
**Documentación Base**: `DSP_BASELINE.md`

## 1. Inventario de Capacidades DSP

Tras el análisis de `dsp.rs`, se identifican las siguientes capacidades:

### Decodificación
- **WAV, MP3, FLAC**: Implementado mediante la librería `symphonia` (Decodificación a Float32 nativo).

### Transformadas
- **STFT**: Implementado utilizando `rustfft` con paralelización (SIMD via `rayon`). Incluye la ventana de Hann y Blackman-Harris.

### Feature Extraction
- RMS, Peak, Crest Factor, Spectral Centroid, Spectral Bandwidth, Spectral Flatness, Spectral Flux están **implementados** en la función `extract_descriptors`.

### Detectores
- **Click**: Implementado en `detect_artifacts_dynamic`.
- **Pop**: Implementado en `detect_artifacts_dynamic`.
- **Hum**: Implementado en `detect_artifacts_dynamic`.
- **Dropout**: Implementado en `detect_artifacts_dynamic`.
- **Clipping**: Implementado en `detect_artifacts_dynamic`.

### Reparadores
- **Hermite Cubic Repair**: Implementado en `heal_glitches` y `export_repaired_wav`.
- **Bit-perfect patching**: Soporte in-place para 16-bit, 24-bit y 32-bit float.

---

## 2. Matriz de Capacidades

| Capacidad | Documentada | Implementada | Estado |
|---|---|---|---|
| Decodificación (WAV, MP3, FLAC) | Parcial | Sí | OK |
| STFT / SIMD | Sí | Sí | OK |
| Feature: RMS | Sí | Sí | OK |
| Feature: Peak | Sí | Sí | OK |
| Feature: Crest Factor | Sí | Sí | OK |
| Feature: Spectral Centroid | Sí | Sí | OK |
| Feature: Spectral Bandwidth | Sí | Sí | OK |
| Feature: Spectral Flatness | Sí | Sí | OK |
| Feature: Spectral Flux | Sí | Sí | OK |
| Detector: Click | Sí | Sí | OK |
| Detector: Pop | Sí | Sí | OK |
| Detector: Hum | Sí | Sí | OK |
| Detector: Clipping | Sí | Sí | OK |
| Detector: Dropout | Sí | Sí | OK |
| Reparador: Hermite Cubic | Sí | Sí | OK |
| Patching Bit-perfect | Sí | Sí | OK |

---

## 3. Validación Matemática y de Umbrales

La auditoría confirma que las matemáticas descritas en `DSP_BASELINE.md` corresponden **exactamente** al código en `dsp.rs`:

1. **Ventana de Hann**: `w[n] = 0.5 * (1.0 - cos((2.0 * PI * n) / (fft_size - 1)))` (Línea 284).
2. **Descriptores**: El cálculo de Centroide, Bandwidth, Flatness y Flux es matemáticamente equivalente a las descripciones documentadas.
3. **Umbrales de Click**: `crest_factor > 15.0`, `bandwidth > 0.8 * f_nyquist`, `rms > noise_floor * 2.0`.
4. **Umbrales de Pop**: `< 150 Hz` (Ratio > 80%), `crest_factor > 5.0`, `rms > 3.0 * noise_floor`.
5. **Umbrales de Hum**: Mag > `2.0 * neighbor_avg`, persistencia > 40%, sobre las frecuencias objetivo exactas.
6. **Clipping**: `val >= 0.99`, tolerancia `< 1e-4`, cuenta consecutiva `> 3`.
7. **Dropout**: Caída de RMS a `< 10%` del promedio móvil, por más de `10ms`.
8. **Hermite Cubic**: Promedio de 8 anclajes, Catmull-Rom para tangentes ($C^1$), e interpolación polinómica idéntica a la fórmula.

---

## 4. Registro de Discrepancias

### Discrepancia 1 (Tipo B: Implementado pero no documentado)
En `dsp.rs` (Líneas 340-466) existe una función denominada `detect_glitches` que opera utilizando derivadas puramente temporales y estima el *noise floor* mediante percentiles (95%) de deltas de primer orden. Esta función detecta anomalías clasificadas como `Drop`, `Sample` y `Slip` (Clock Slip). Esta lógica temporal **no está documentada** en el `DSP_BASELINE.md`, el cual se basa en la lógica espectral implementada en `detect_artifacts_dynamic`.

---

## 5. Identificación de Deuda Técnica (Capacidades Ausentes)

Las siguientes capacidades identificadas como mejoras futuras en las `SPECS.md` se confirman como **NO implementadas** en el motor actual:

- Hiss Detection
- Crackle Detection
- Spectral Repair / Inpainting
- AR Reconstruction
- LPC Reconstruction
- Probabilistic Classification
- Automatic Repair Selection

---

## Conclusión

El `DSP_BASELINE.md` representa de forma precisa y exacta el motor de extracción de características espectrales y las rutinas dinámicas de `detect_artifacts_dynamic`. 
Se ha validado la línea base con éxito. La única recomendación operativa es documentar o evaluar la necesidad de la antigua función `detect_glitches` (derivada temporal). 

La investigación **INV-000** se considera FINALIZADA.
