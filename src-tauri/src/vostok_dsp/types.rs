use serde::{Serialize, Deserialize};

/// Estructura contenedora de un canal de audio decodificado
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioBuffer {
    /// Muestras del canal en formato Float32 normalizado [-1.0, 1.0]
    pub samples: Vec<f32>,
    /// Frecuencia de muestreo (ej: 44100, 48000 Hz)
    pub sample_rate: u32,
    /// Cantidad de canales decodificados en el stream
    pub channels: u16,
    /// Profundidad de bits original (ej: 16, 24, 32 bits)
    pub bit_depth: u16,
    /// Duración total del audio en segundos
    pub duration_seconds: f64,
}

/// Representa la matriz bidimensional resultante del análisis espectral
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StftResult {
    /// Matriz linealizada contigua (row-major: num_frames x num_bins) de amplitudes
    pub matrix: Vec<f32>,
    /// Cantidad de bloques de tiempo calculados
    pub num_frames: usize,
    /// Cantidad de bins de frecuencia por frame (fft_size / 2)
    pub num_bins: usize,
}

/// Configuración de ventana de visualización (Viewport)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ViewportConfig {
    /// Índice de frame de inicio de la visualización
    pub start_frame: usize,
    /// Índice de frame de fin de la visualización
    pub end_frame: usize,
    /// Ancho máximo de textura permitido por la GPU (ej: 4096 o 8192)
    pub max_texture_width: usize,
}

/// Clasificación de tipos de glitches digitales
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GlitchType {
    Click,
    Pop,
    Dropout,
    Hum,
    Hiss,
    Slip,
    Distortion,
}

/// Modo de audio para adaptar los umbrales de detección
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AudioMode {
    Music,
    Voice,
}

/// Parámetros de escaneo enviados desde el frontend
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanParams {
    pub clicks: bool,
    pub hum: bool,
    pub hiss: bool,
    pub dropouts: bool,
    pub distortion: bool,
    pub sensitivity: f32,
    pub audio_mode: Option<AudioMode>,
}

/// Batería de características extraídas por cada frame de audio para análisis de dominios
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameFeatures {
    pub rms: f32,
    pub zero_crossing_rate: f32,
    pub crest_factor: f32,
    pub z_score: f32,
    pub spectral_centroid: f32,
    pub spectral_flux: f32,
    pub spectral_flatness: f32,
    pub frame_index: usize,
    pub time_secs: f32,
}

/// Representación de un evento de glitch detectado en el audio
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GlitchEvent {
    /// Índice del sample de inicio del glitch en el vector de audio
    pub sample_index: usize,
    /// Ubicación temporal exacta del glitch en segundos
    pub time_secs: f64,
    /// Magnitud del salto de voltaje (diferencia de amplitud)
    pub amplitude_delta: f32,
    /// Dirección del gradiente (+1 para salto positivo, -1 para negativo)
    pub direction: i8,
    /// Categoría del glitch identificado
    pub event_type: GlitchType,
    /// Estado de la reparación
    pub repaired: bool,
    /// Frecuencia física asociada al glitch en Hz
    pub frequency: Option<f32>,
    /// Canal donde se detectó el glitch (0 para L, 1 para R, etc.)
    #[serde(default)]
    pub channel: u16,
    /// Duración aproximada del evento en muestras (opcional)
    #[serde(default)]
    pub duration_samples: Option<usize>,
}

/// Parámetros de la interpolación Hermite cúbica para la reparación de glitches
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HermiteConfig {
    /// Tamaño de la ventana de contexto en muestras (4–64)
    pub window_size: usize,
    /// Bias de la spline (reservado para uso futuro)
    pub bias: f32,
    /// Tensión de la spline (-1.0 a 1.0)
    pub tension: f32,
}

impl Default for HermiteConfig {
    fn default() -> Self {
        HermiteConfig { window_size: 16, bias: 0.0, tension: 0.0 }
    }
}

