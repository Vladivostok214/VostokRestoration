# INFRA-001: Analytical Spectrogram Foundation

## Contexto y Motivación
Tras la auditoría del pipeline visual (SPECTROGRAM_ARCHITECTURE_REFACTOR.md), se evidenció que la matriz espectral utilizada para el renderizado web (basada en RMS downsampling y cuantización de 8 bits a través de conversiones a escala Mel) era matemáticamente destructiva. 

Esta infraestructura visual, aunque altamente optimizada para el renderizado humano en WebGL, impedía que el DSP Research Lab extrajera ventanas espectrales analíticas de alta precisión (Float32 puro, alta resolución en el dominio del tiempo y de la frecuencia) para tareas de detección, clasificación algorítmica y reparación.

El objetivo de esta infraestructura fue establecer una **Fuente de Verdad en RAM** separando la capa visual de la analítica, manteniendo una estricta retrocompatibilidad con la interfaz de usuario existente de Vostok Restoration v1.

---

## Implementación Arquitectónica

### 1. Estructura de Datos (`AnalyticalSpectrogram`)
Se reemplazó el antiguo struct de transferencia `StftResult` por una estructura inmutable y con tipado riguroso, añadiendo metadatos esenciales para algoritmos híbridos.

```rust
/// Espectrograma analítico puro para DSP Research e IA
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticalSpectrogram {
    pub sample_rate: u32,
    pub fft_size: usize,
    pub hop_size: usize,
    pub num_frames: usize,
    pub num_bins: usize,
    pub data: Vec<f32>,
}
```

### 2. Estructura de Peticiones (`AnalyticalRegionRequest`)
Para prevenir la sobrecarga del canal IPC de Tauri y proteger la memoria RAM al transferir datos de Rust a Node, se creó un sistema de bounding boxes que recorta y envía exclusivamente la zona matemática de interés:

```rust
/// Solicitud de una región micro-espectral específica para análisis
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticalRegionRequest {
    pub start_frame: usize,
    pub end_frame: usize,
    pub min_bin: usize,
    pub max_bin: usize,
}
```

### 3. API y Capa de Servicios (`obtener_region_analitica`)
Se inyectó en el backend de `lib.rs` un Tauri Command especializado que interactúa asíncronamente con el estado inmutable (`Mutex<Option<Arc<AnalyticalSpectrogram>>>`), recortando la región de forma eficiente y abortando la petición si supera el límite seguro de la IPC (500,000 bins por request).

### 4. Adaptador Visual Neutro (`get_paged_spectrogram`)
Las funciones visuales fueron actualizadas para consumir el `AnalyticalSpectrogram` como capa base inmutable. A partir de ella, los datos Float32 originales sufren el clipping, downsampling temporal y mapeo a u8 antes de enviarse al frontend. El `SpectrogramGL.jsx` funciona exactamente igual, consumiendo Base64 como antes.

---

## Resultado e Impacto Técnico
* **Backward Compatibility**: `100%`. El UI no requiere refactorización.
* **Precisión para DSP Lab**: `Float32 (32-bits)`. Se preservan las magnitudes completas pre-clipping dinámico.
* **Futuras Investigaciones Habilitadas**:
  - Hiss Detection.
  - Crackle Classification (requiere acceso puro al dominio de alta frecuencia).
  - AR Reconstruction y Probabilistic Repair.

## Limitaciones y Próximos Riesgos a Observar
* El clamp en el procesamiento subyacente `mag.min(1.0)` fue dejado intacto en `compute_stft` de acuerdo con las especificaciones de la investigación. Esto será abordado posteriormente mediante calibración de rango dinámico.
