# Spectrogram Architecture Refactor: Proposal & Audit

**Status**: Propuesta Arquitectónica (Pendiente de Revisión)
**Prioridad**: Crítica

---

## 1. Auditoría de Pérdida de Información (Architecture Report)

El pipeline actual sacrifica la precisión matemática en favor del rendimiento visual a través de múltiples capas destructivas. La auditoría ha identificado los siguientes **cuellos de botella donde se destruye información analítica**:

### A. En el motor de procesamiento (Rust - `dsp.rs`)
1. **Dynamic Range Clipping (`compute_stft`)**:
   - *Código actual:* `frame[k] = mag.min(1.0);`
   - *Efecto:* Trunca artificialmente cualquier magnitud que exceda 1.0 (0 dBFS). Si un transitorio tiene una amplitud extrema, su pico se aplasta matemáticamente, destruyendo la envolvente real.
2. **Sub-muestreo Físico (`get_paged_spectrogram`)**:
   - *Efecto:* Se fuerza la reducción de la matriz a un máximo de `1024x512`. Un archivo de 3 minutos tiene miles de frames; promediarlos (RMS) en 1024 columnas difumina por completo eventos micro-temporales (clicks de 1 sample).
3. **Cuantización a 8-Bits (`get_paged_spectrogram`)**:
   - *Efecto:* La magnitud en coma flotante (`f32`) se aplasta a un logaritmo (dB) y luego a un `u8` (0-255). Se pierden las variaciones sutiles inter-decibelio.

### B. En el motor gráfico (React / WebGL - `SpectrogramGL.jsx`)
4. **Remapeo Frecuencial (Mel Scale)**:
   - *Efecto:* Los *bins* lineales del FFT son estirados y aplastados logarítmicamente. Si bien refleja la audición humana, rompe la relación armónica matemática lineal necesaria para algoritmos como *Harmonic Product Spectrum (HPS)*.
5. **Corrección Gamma de Alto Contraste**:
   - *Código actual:* `amp = clamp(pow(amp, 2.5), 0.0, 1.0);`
   - *Efecto:* El ruido de fondo y los micro-detalles desaparecen al elevarse a la potencia de 2.5, favoreciendo visualmente solo a las frecuencias dominantes.

---

## 2. Diseño del Analytical Spectrogram (API)

La nueva estructura residirá en la memoria del Backend (Rust) y servirá como fuente de la verdad inmutable.

```rust
/// Espectrograma analítico puro para DSP Research e IA
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticalSpectrogram {
    pub sample_rate: u32,
    pub fft_size: usize,
    pub hop_size: usize,
    pub num_frames: usize,
    pub num_bins: usize,
    /// Matriz cruda 1D (row-major). Magnitudes lineales Float32.
    /// Sin clamping (mag.min(1.0) eliminado).
    pub data: Vec<f32>, 
}

/// Solicitud de una región micro-espectral específica para análisis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticalRegionRequest {
    pub start_frame: usize,
    pub end_frame: usize,
    pub min_bin: usize,
    pub max_bin: usize,
}
```

---

## 3. Comparativa Arquitectónica

| Stage / Característica | Analytical Spectrogram (DSP Lab) | Visual Spectrogram (UI/WebGL) |
| :--- | :--- | :--- |
| **Precisión de Datos** | `Float32` lineal pura | `Uint8` Logarítmica (dB) |
| **Recorte de Amplitud** | Ninguno (Sin límite superior) | Techo en 0 dBFS (`max(1.0)`) |
| **Resolución Temporal** | 1:1 con el `hop_size` | Comprimida (Max 1024 columnas) |
| **Resolución Espectral**| 1:1 con `fft_size / 2` | Comprimida (Max 512 filas) |
| **Modificación Gamma** | Sin distorsión óptica | Gamma 2.5 (High Contrast) |
| **Mapeo Espacial** | Lineal (matemático) | Mel Scale (psicoacústico) |
| **Carga en Red (IPC)** | Pesada (Chunks bajo demanda) | Ultra-ligera (Base64 < 500kb) |

---

## 4. Estrategia de Migración (Migration Plan)

Para no romper el frontend de Vostok, la migración se hará aislando responsabilidades:

1. **Refactorización Core (`dsp.rs`):**
   - Eliminar el `mag.min(1.0)` de la función matemática base `compute_stft()`.
   - Modificar la estructura en RAM de Tauri (`AppState::stft`) para que almacene un `AnalyticalSpectrogram` en lugar de la estructura anticuada.
2. **Adaptador Visual (Compatibilidad hacia atrás):**
   - Modificar `get_paged_spectrogram()` para que acepte el nuevo `AnalyticalSpectrogram`.
   - Incluir la lógica de *clipping visual* (`clamp`) dentro de esta misma función de downsampling antes de pasar a `u8`, protegiendo así la UI de magnitudes extremas sin afectar la RAM.
3. **Exposición de API Analítica:**
   - Crear un nuevo Tauri Command: `obtener_region_analitica(AnalyticalRegionRequest) -> Vec<f32>`. Esto permitirá a la UI de Research descargar *matrices exactas* para zonas pequeñas (ej. los 200 milisegundos alrededor de un transitorio) sin saturar el canal IPC.

---

## 5. Evaluación de Riesgos (Risk Assessment)

- **Riesgo 1: Sobrecarga IPC de Tauri.** Si el frontend intenta pedir el `AnalyticalSpectrogram` entero de un archivo de 5 minutos, el puente serializador JSON de Tauri congelará la app por falta de memoria.
  - *Mitigación:* La API analítica **solo** devolverá información paginada usando la estructura `AnalyticalRegionRequest`. El análisis pesado se hará en el backend en Rust; el frontend solo pedirá los floats de la ventana de interés microscópica.
- **Riesgo 2: Alteración de Visuales.** Remover `mag.min(1.0)` del DSP base podría provocar que `get_paged_spectrogram` calcule RMS superiores a 1.0, lo que podría desbordar la matemática a 8-bits.
  - *Mitigación:* Añadir un clamp seguro a `0.0` y `255.0` directamente en la fase final de `get_paged_spectrogram`, blindando la capa visual del cambio subyacente.
