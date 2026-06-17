//! Módulo DSP (Digital Signal Processing) de Vostok Restoration v1
//! 
//! Implementa la decodificación nativa con `symphonia`, la STFT paralela
//! con `rustfft` (SIMD), el detector por primera derivada en tiempo lineal,
//! la interpolación Hermite cúbica in-place y el sub-muestreo espectral para WebGL.

use std::path::Path;
use serde::{Serialize, Deserialize};
use rustfft::{FftPlanner, num_complex::Complex};
use rayon::prelude::*;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

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
    /// Canales originales del archivo (para exportación y patching)
    pub original_channels: u16,
    /// Bytes crudos originales si es un archivo WAV
    #[serde(skip)]
    pub raw_bytes: Option<Vec<u8>>,
    /// Offset del chunk 'data' en los bytes crudos
    #[serde(skip)]
    pub data_offset: Option<usize>,
}

fn find_data_chunk_offset(bytes: &[u8]) -> Option<usize> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut offset = 12;
    while offset + 8 <= bytes.len() {
        let chunk_id = &bytes[offset..offset+4];
        let chunk_size = u32::from_le_bytes(bytes[offset+4..offset+8].try_into().unwrap()) as usize;
        offset += 8;
        if chunk_id == b"data" {
            return Some(offset);
        }
        offset += chunk_size;
        // WAV chunks are padded to 2-byte boundaries
        if offset % 2 != 0 {
            offset += 1;
        }
    }
    None
}

/// Representa la matriz bidimensional resultante del análisis espectral
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticalSpectrogram {
    pub sample_rate: u32,
    pub fft_size: usize,
    pub hop_size: usize,
    pub num_frames: usize,
    pub num_bins: usize,
    pub data: Vec<f32>,
    /// Persistencia global de fundamentales de Hum (50Hz/60Hz) calculada una sola vez
    pub global_hum_persistence: std::collections::HashMap<u32, f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PagedStftResult {
    pub matrix: String,
    pub num_frames: usize,
    pub num_bins: usize,
}



/// Representa el espectrograma sub-muestreado optimizado para transferencia IPC y renderizado WebGL


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

/// Perfil de resolución espectral para optimizar el análisis de transitorios o armónicos
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum ResolutionProfile {
    #[serde(rename = "transient")]
    TransientMode,
    #[serde(rename = "hum")]
    HumMasteringMode,
}

/// Clasificación de tipos de glitches digitales
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GlitchType {
    /// Caída rápida de energía (Micro drop de buffer)
    Drop,
    /// Salto aislado de muestra única (Spike / Dirac Impulse)
    Sample,
    /// Pérdida de sincronización de reloj (Clock Slip)
    Slip,
    /// Siseo de alta frecuencia constante
    Hiss,
}

/// Estructura tipada para almacenar la evidencia del detector de Hum (PROD-004B)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HumEvidence {
    pub cv: f32,
    pub harmonic_decay: f32,
    pub global_persistence: f32,
}

/// Representación de un evento estacionario (Hum, Hiss)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StationaryEvent {
    pub start_time_secs: f64,
    pub end_time_secs: f64,
    pub event_type: GlitchType,
    pub artifact_type: String,
    pub confidence: f32,
    pub average_db: f32,
    pub spectral_flatness: f32,
    pub hum_evidence: Option<HumEvidence>,
}

/// Resultado unificado de detección de la arquitectura segregada
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectionResult {
    pub transients: Vec<GlitchEvent>,
    pub stationaries: Vec<StationaryEvent>,
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
    /// Tipo de artefacto identificado (CLICK, POP, HUM, CLIP, DROPOUT)
    pub artifact_type: String,
    pub confidence: f32,
    /// Evidencia detallada para eventos de Hum (telemetría tipada)
    pub hum_evidence: Option<HumEvidence>,
}

/// Decodifica un archivo de audio WAV, MP3 o FLAC a Float32 nativo usando `symphonia`
pub fn decode_audio_file<P: AsRef<Path>>(path: P) -> Result<AudioBuffer, String> {
    let path = path.as_ref();
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    
    // Read raw bytes if WAV for in-place patching later
    let raw_bytes = std::fs::read(path).ok();
    let mut data_offset = None;
    if let Some(bytes) = &raw_bytes {
        data_offset = find_data_chunk_offset(bytes);
    }

    // Crear el stream de origen multimedia 100% en RAM si logramos leerlo
    let mss = if let Some(bytes) = &raw_bytes {
        let cursor = std::io::Cursor::new(bytes.clone());
        MediaSourceStream::new(Box::new(cursor), Default::default())
    } else {
        MediaSourceStream::new(Box::new(file), Default::default())
    };
    let hint = Hint::new();
    
    // Detectar formato
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Error de contenedor: {}", e))?;
        
    let mut format = probed.format;
    
    // Buscar track de audio
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| "No se encontró ningún track de audio.".to_string())?;
        
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .map_err(|e| format!("Error de decodificador: {}", e))?;
        
    let track_id = track.id;
    let sample_rate = track.codec_params.sample_rate.unwrap_or(48000);
    let original_channels = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(1);
    let _channels = 1; // Mono visual / DSP
    let bit_depth = track.codec_params.bits_per_sample.unwrap_or(16) as u16;
    
    let mut samples = Vec::new();
    
    // Decodificar paquetes
    loop {
        let packet = match format.next_packet() {
            Ok(packet) => packet,
            Err(SymphoniaError::IoError(ref err)) if err.kind() == std::io::ErrorKind::UnexpectedEof => {
                break;
            }
            Err(err) => return Err(format!("Error leyendo paquete: {}", err)),
        };
        
        if packet.track_id() != track_id {
            continue;
        }
        
        let decoded = decoder.decode(&packet).map_err(|e| format!("Error decodificando: {}", e))?;
        
        // Extraer muestras del Canal 0 (Mono)
        match decoded {
            AudioBufferRef::F32(buf) => {
                if buf.frames() > 0 {
                    samples.extend_from_slice(buf.chan(0));
                }
            }
            AudioBufferRef::S16(buf) => {
                if buf.frames() > 0 {
                    let scale = 1.0 / 32768.0;
                    for &s in buf.chan(0) {
                        samples.push(s as f32 * scale);
                    }
                }
            }
            AudioBufferRef::S32(buf) => {
                if buf.frames() > 0 {
                    let scale = 1.0 / 2147483648.0;
                    for &s in buf.chan(0) {
                        samples.push(s as f32 * scale);
                    }
                }
            }
            AudioBufferRef::S24(buf) => {
                if buf.frames() > 0 {
                    let scale = 1.0 / 8388608.0;
                    for &s in buf.chan(0) {
                        samples.push(s.inner() as f32 * scale);
                    }
                }
            }
            _ => {
                return Err("Formato de buffer no soportado directamente.".to_string());
            }
        }
    }
    
    let duration_seconds = samples.len() as f64 / sample_rate as f64;

    Ok(AudioBuffer {
        samples,
        sample_rate,
        channels: 1, // forzamos mono para UI y Detección
        original_channels,
        bit_depth,
        duration_seconds,
        raw_bytes,
        data_offset,
    })
}

/// Calcula la transformada de Fourier de tiempo reducido (STFT) usando `rustfft` con SIMD
pub fn compute_stft(
    samples: &[f32],
    sample_rate: u32,
    fft_size: usize,
    hop_size: usize,
    window_type: &str,
) -> Result<AnalyticalSpectrogram, String> {
    let num_bins = fft_size / 2;
    if samples.len() < fft_size {
        return Err("Muestras insuficientes para el tamaño de FFT.".to_string());
    }
    
    let num_frames = (samples.len() - fft_size) / hop_size + 1;
    let mut matrix = vec![0.0; num_frames * num_bins];
    
    // 1. Precomputar coeficientes de ventana
    let mut window = vec![0.0; fft_size];
    if window_type == "blackman-harris" {
        let a0 = 0.35875;
        let a1 = 0.48829;
        let a2 = 0.14128;
        let a3 = 0.01168;
        let pi2 = 2.0 * std::f32::consts::PI;
        for i in 0..fft_size {
            let n = i as f32 / (fft_size - 1) as f32;
            window[i] = a0 
                - a1 * (pi2 * n).cos() 
                + a2 * (2.0 * pi2 * n).cos() 
                - a3 * (3.0 * pi2 * n).cos();
        }
    } else {
        // Hann window pura: w[n] = 0.5 * (1.0 - cos((2.0 * PI * n) / (FFT_SIZE - 1)))
        let pi = std::f32::consts::PI;
        for n in 0..fft_size {
            window[n] = 0.5 * (1.0 - ((2.0 * pi * n as f32) / (fft_size - 1) as f32).cos());
        }
    }
    
    // 2. Inicializar FftPlanner (SIMD de rustfft)
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(fft_size);
    let norm = 1.0 / (fft_size as f32 * 0.5);
    
    matrix.par_chunks_mut(num_bins).enumerate().for_each(|(f, frame)| {
        let mut buffer = vec![Complex::new(0.0, 0.0); fft_size];
        let offset = f * hop_size;
        
        for i in 0..fft_size {
            buffer[i] = Complex::new(samples[offset + i] * window[i], 0.0);
        }
        
        fft.process(&mut buffer);
        
        for k in 0..num_bins {
            let mag = (buffer[k].re * buffer[k].re + buffer[k].im * buffer[k].im).sqrt() * norm;
            frame[k] = mag.min(1.0);
        }
    });
    
    // 3. Precalculo de persistencia global de Hum (50Hz / 60Hz) en O(N)
    let mut global_hum_persistence = std::collections::HashMap::new();
    for &f0 in &[50, 60] {
        let bin_f0 = (f0 as f32 * fft_size as f32 / sample_rate as f32).round() as usize;
        if bin_f0 > 1 && bin_f0 < num_bins - 1 {
            let mut active_frames = 0;
            for f in 0..num_frames {
                let offset = f * num_bins;
                let mag = matrix[offset + bin_f0];
                let left = matrix[offset + bin_f0 - 1];
                let right = matrix[offset + bin_f0 + 1];
                let neighbor_avg = (left + right) / 2.0;

                // Umbral inicial basado en neighbor_ratio = 1.5 y min_mag = 0.005
                if mag > 1.5 * neighbor_avg && mag > 0.005 {
                    active_frames += 1;
                }
            }
            let ratio = active_frames as f32 / num_frames as f32;
            global_hum_persistence.insert(f0, ratio);
        }
    }

    Ok(AnalyticalSpectrogram {
        sample_rate,
        fft_size,
        hop_size,
        data: matrix,
        num_frames,
        num_bins,
        global_hum_persistence,
    })
}

/// Estima el ruido base (percentil 95 de la derivada de primer orden)
pub fn estimate_noise_floor(samples: &[f32]) -> f32 {
    let n = samples.len();
    if n < 2 {
        return 0.001;
    }
    const PROBE: usize = 10000;
    let step = 1.max(n / PROBE);
    let mut deltas = Vec::new();
    let mut i = step;
    while i < n {
        deltas.push((samples[i] - samples[i - 1]).abs());
        i += step;
    }
    if !deltas.is_empty() {
        let target_idx = (deltas.len() as f32 * 0.95) as usize;
        let (_, &mut val, _) = deltas.select_nth_unstable_by(target_idx, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        val.max(0.001)
    } else {
        0.001
    }
}

/// Escanea el audio buscando saltos anómalos de voltaje y anomalías espectrales
pub fn detect_glitches(
    samples: &[f32],
    threshold: f32,
    sample_rate: u32,
) -> Vec<GlitchEvent> {
    let n = samples.len();
    let mut events = Vec::new();
    if n < 2 {
        return events;
    }

    let noise_floor = estimate_noise_floor(samples);

    let ctx_win = 32.max((sample_rate as f32 * 0.002) as usize); // ~2ms
    let min_gap = 32.max((sample_rate as f32 * 0.00133) as usize); // ~1.33ms

    let mut prefix_sq = vec![0.0; n + 1];
    let mut sum_sq_val = 0.0;
    for i in 0..n {
        sum_sq_val += samples[i] * samples[i];
        prefix_sq[i + 1] = sum_sq_val;
    }

    let rms = |start: usize, len: usize| -> f32 {
        let end = (start + len).min(n);
        let s = start;
        if s >= end {
            return 0.0;
        }
        let sum_sq = prefix_sq[end] - prefix_sq[s];
        let sum_sq = sum_sq.max(0.0);
        (sum_sq / (end - s) as f32).sqrt()
    };

    let min_active_rms = 0.01;
    let mut last_idx = -(min_gap as isize);
    let end_limit = if n > ctx_win { n - ctx_win } else { 0 };

    for n_idx in 1..end_limit {
        if (n_idx as isize - last_idx) <= min_gap as isize {
            continue;
        }

        let delta = (samples[n_idx] - samples[n_idx - 1]).abs();
        let rms_before = rms(n_idx.saturating_sub(ctx_win), ctx_win);

        let mut detected = false;
        let mut event_type = GlitchType::Drop;
        let mut amplitude_delta = delta;
        let mut event_idx = n_idx;

        // Detector 1: Clicks/Drops de Alta Energía
        if delta > threshold {
            let rms_center = rms(n_idx, ctx_win);
            let drop_ratio = 0.35;
            let is_energy_drop = rms_before > (noise_floor * 4.0).max(min_active_rms)
                && rms_center < rms_before * drop_ratio;

            let recovery1 = (samples[n_idx.min(n - 1)] - samples[n_idx - 1]).abs();
            let recovery2 = (samples[(n_idx + 1).min(n - 1)] - samples[n_idx - 1]).abs();
            let is_single_sample = delta > threshold * 1.5
                && recovery1.min(recovery2) < threshold * 0.4;

            if is_energy_drop {
                detected = true;
                event_type = GlitchType::Drop;
            } else if is_single_sample {
                detected = true;
                event_type = GlitchType::Sample;
            }
        }

        // Detector 2: Drops de Baja Energía (Silencios abruptos)
        if !detected && samples[n_idx].abs() < 1e-6 && rms_before > min_active_rms {
            let mut drop_len = 0;
            while n_idx + drop_len < n && samples[n_idx + drop_len].abs() < 1e-6 {
                drop_len += 1;
            }

            if drop_len >= 2 && drop_len <= 16 {
                let rms_after = rms(n_idx + drop_len, ctx_win);
                if rms_after > 0.008 {
                    detected = true;
                    event_type = GlitchType::Drop;
                    amplitude_delta = rms_before;
                    event_idx = n_idx;
                }
            }
        }

        // Detector 3: Repetición de samples (Clock Slip)
        if !detected && samples[n_idx].abs() > 0.05 && rms_before > min_active_rms {
            let mut repeat_len = 0;
            while n_idx + repeat_len < n && (samples[n_idx + repeat_len] - samples[n_idx - 1]).abs() < 1e-7 {
                repeat_len += 1;
            }

            if repeat_len >= 6 && repeat_len <= 16 {
                detected = true;
                event_type = GlitchType::Slip;
                amplitude_delta = 0.4;
                event_idx = n_idx;
            }
        }

        if detected {
            let time_secs = event_idx as f64 / sample_rate as f64;
            let current_event_type = event_type.clone();
            events.push(GlitchEvent {
                sample_index: event_idx,
                time_secs,
                amplitude_delta,
                direction: if samples[event_idx] > samples[event_idx - 1] { 1 } else { -1 },
                event_type: current_event_type.clone(),
                repaired: false,
                confidence: 1.0,
                artifact_type: match current_event_type {
                    GlitchType::Drop => "DROPOUT".to_string(),
                    GlitchType::Sample => "CLICK".to_string(),
                    GlitchType::Slip => "SLIP".to_string(),
                    GlitchType::Hiss => "HISS".to_string(),
                },
                hum_evidence: None,
            });
            last_idx = event_idx as isize;
        }
    }

    events
}

/// Repara quirúrgicamente los glitches identificados aplicando Splines Cúbicas Hermite
pub fn heal_glitches(
    audio_buf: &mut AudioBuffer,
    glitches: &[GlitchEvent],
    noise_floor: f32,
) {
    let n_total = audio_buf.samples.len();
    let mut modified_indices: Vec<(usize, f32)> = Vec::new();

    for glitch in glitches {
        if glitch.repaired {
            continue;
        }

        let idx = glitch.sample_index;
        if idx >= n_total {
            continue;
        }

        // 1. Detectar extensión real del daño
        let max_win = 256.min((glitch.amplitude_delta * 128.0) as usize);
        let dev_thresh = (noise_floor * 3.0).max(0.01);

        // Expandir hacia atrás
        let mut start_dmg = idx;
        while start_dmg > 1 && (idx - start_dmg) < max_win {
            let predicted = audio_buf.samples[start_dmg - 1];
            if (audio_buf.samples[start_dmg] - predicted).abs() > dev_thresh {
                start_dmg -= 1;
            } else {
                break;
            }
        }

        // Expandir hacia adelante
        let mut end_dmg = idx;
        while end_dmg < n_total - 2 && (end_dmg - idx) < max_win {
            let predicted = audio_buf.samples[end_dmg + 1];
            if (audio_buf.samples[end_dmg] - predicted).abs() > dev_thresh {
                end_dmg += 1;
            } else {
                break;
            }
        }

        // Márgenes seguros
        start_dmg = start_dmg.max(9);
        end_dmg = end_dmg.min(n_total - 10);

        if start_dmg >= end_dmg {
            continue;
        }

        // 2. Puntos de anclaje (promedio de 8 samples)
        const ANCHOR: usize = 8;
        let mut p0 = 0.0;
        let mut p1 = 0.0;
        for i in 0..ANCHOR {
            p0 += audio_buf.samples[start_dmg - 1 - i];
            p1 += audio_buf.samples[end_dmg + 1 + i];
        }
        p0 /= ANCHOR as f32;
        p1 /= ANCHOR as f32;

        // 3. Tangentes Catmull-Rom
        let p0prev = audio_buf.samples[start_dmg - 2];
        let p1next = audio_buf.samples[end_dmg + 2];
        let m0 = 0.5 * (p0 - p0prev);
        let m1 = 0.5 * (p1next - p1);

        // 4. Interpolación Hermite Cúbica (Continuidad C1)
        let span = end_dmg - start_dmg + 1;
        for i in 0..span {
            let t = if span > 1 { i as f32 / (span - 1) as f32 } else { 0.5 };
            let t2 = t * t;
            let t3 = t2 * t;

            let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
            let h10 = t3 - 2.0 * t2 + t;
            let h01 = -2.0 * t3 + 3.0 * t2;
            let h11 = t3 - t2;

            let val = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
            let clamped_val = val.clamp(-1.0, 1.0);
            audio_buf.samples[start_dmg + i] = clamped_val;
            modified_indices.push((start_dmg + i, clamped_val));
        }
    }

    // Patch raw bytes if available
    if let (Some(raw_bytes), Some(data_offset)) = (&mut audio_buf.raw_bytes, audio_buf.data_offset) {
        let bytes_per_sample = (audio_buf.bit_depth / 8) as usize;
        let orig_chans = audio_buf.original_channels as usize;

        for &(idx, val) in &modified_indices {
            let frame_offset = data_offset + idx * orig_chans * bytes_per_sample;
            for ch in 0..orig_chans {
                let sample_offset = frame_offset + ch * bytes_per_sample;
                if sample_offset + bytes_per_sample > raw_bytes.len() {
                    continue; // safety
                }
                
                // Conversión de f32 a los bytes originales
                if audio_buf.bit_depth == 16 {
                    let s16 = (val * 32767.0).clamp(-32768.0, 32767.0) as i16;
                    raw_bytes[sample_offset..sample_offset+2].copy_from_slice(&s16.to_le_bytes());
                } else if audio_buf.bit_depth == 24 {
                    let s32 = (val * 8388607.0).clamp(-8388608.0, 8388607.0) as i32;
                    let bytes = s32.to_le_bytes();
                    raw_bytes[sample_offset] = bytes[0];
                    raw_bytes[sample_offset+1] = bytes[1];
                    raw_bytes[sample_offset+2] = bytes[2];
                } else if audio_buf.bit_depth == 32 {
                    let s32 = (val * 2147483647.0).clamp(-2147483648.0, 2147483647.0) as i32;
                    raw_bytes[sample_offset..sample_offset+4].copy_from_slice(&s32.to_le_bytes());
                }
            }
        }
    }
}

/// Extrae y sub-muestrea la matriz espectral para adaptarla al área visible de WebGL
/// Aplica downsampling agresivo tanto temporal (coincidiendo con el viewport)
/// como vertical (restringiendo a 256 bins para transferencia ultraligera < 500 KB).


/// Exporta las muestras sanadas a un archivo WAV PCM usando `hound` o escribiendo los bytes crudos
pub fn export_repaired_wav<P: AsRef<Path>>(
    path: P,
    audio_buf: &AudioBuffer,
) -> Result<(), String> {
    if let Some(raw) = &audio_buf.raw_bytes {
        // Exportación bit-perfect in-place
        std::fs::write(path, raw).map_err(|e| format!("No se pudo escribir el archivo WAV: {}", e))?;
        Ok(())
    } else {
        let spec = hound::WavSpec {
            channels: audio_buf.original_channels,
            sample_rate: audio_buf.sample_rate,
            bits_per_sample: audio_buf.bit_depth,
            sample_format: if audio_buf.bit_depth == 32 {
                hound::SampleFormat::Float
            } else {
                hound::SampleFormat::Int
            },
        };

        let mut writer = hound::WavWriter::create(path, spec)
            .map_err(|e| format!("No se pudo crear el archivo WAV: {}", e))?;

        match audio_buf.bit_depth {
            16 => {
                for &s in &audio_buf.samples {
                    let i16_val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                    for _ in 0..audio_buf.original_channels {
                        writer.write_sample(i16_val).map_err(|e| e.to_string())?;
                    }
                }
            }
            24 => {
                for &s in &audio_buf.samples {
                    let i32_val = (s.clamp(-1.0, 1.0) * 8388607.0) as i32;
                    for _ in 0..audio_buf.original_channels {
                        writer.write_sample(i32_val).map_err(|e| e.to_string())?;
                    }
                }
            }
            _ => {
                for &s in &audio_buf.samples {
                    for _ in 0..audio_buf.original_channels {
                        writer.write_sample(s).map_err(|e| e.to_string())?;
                    }
                }
            }
        }

        writer.finalize().map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Calcula la energía total de una señal como la suma de los cuadrados de sus muestras.
pub fn calcular_energia_total(samples: &[f32]) -> f64 {
    samples.iter().map(|&x| (x as f64) * (x as f64)).sum()
}



#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalyticalRegionRequest {
    pub start_frame: usize,
    pub end_frame: usize,
    pub min_bin: usize,
    pub max_bin: usize,
}

pub fn obtener_region_analitica(stft: &AnalyticalSpectrogram, req: AnalyticalRegionRequest) -> Result<Vec<Vec<f32>>, String> {
    let start_f = req.start_frame.min(stft.num_frames);
    let end_f = req.end_frame.min(stft.num_frames).max(start_f);
    let start_b = req.min_bin.min(stft.num_bins);
    let end_b = req.max_bin.min(stft.num_bins).max(start_b);
    let total_elements = (end_f - start_f) * (end_b - start_b);
    if total_elements > 500_000 { return Err("Región demasiado grande para la IPC de Tauri.".to_string()); }
    let mut result = Vec::with_capacity(end_f - start_f);
    for f in start_f..end_f {
        let offset = f * stft.num_bins;
        let mut frame_data = Vec::with_capacity(end_b - start_b);
        for b in start_b..end_b { frame_data.push(stft.data[offset + b]); }
        result.push(frame_data);
    }
    Ok(result)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpectralDescriptors {
    pub rms: f32,
    pub peak: f32,
    pub crest_factor: f32,
    pub spectral_centroid: f32,
    pub spectral_bandwidth: f32,
    pub spectral_flatness: f32,
    pub spectral_flux: f32,
}

pub fn extract_descriptors(
    samples: &[f32],
    stft: &AnalyticalSpectrogram,
    fft_size: usize,
    hop_size: usize,
    sample_rate: u32,
) -> Vec<SpectralDescriptors> {
    use rayon::prelude::*;
    let num_bins = stft.num_bins;
    let num_frames = stft.num_frames;
    let mut descriptors = vec![
        SpectralDescriptors { rms: 0.0, peak: 0.0, crest_factor: 0.0, spectral_centroid: 0.0, spectral_bandwidth: 0.0, spectral_flatness: 0.0, spectral_flux: 0.0 };
        num_frames
    ];
    let bin_freq_step = sample_rate as f32 / fft_size as f32;
    descriptors.par_iter_mut().enumerate().for_each(|(f, desc)| {
        let offset = f * hop_size;
        let mut sum_sq = 0.0;
        let mut peak_val = 0.0;
        let win_limit = (offset + fft_size).min(samples.len());
        let count = win_limit - offset;
        if count > 0 {
            for i in offset..win_limit {
                let s = samples[i];
                sum_sq += s * s;
                let abs_s = s.abs();
                if abs_s > peak_val { peak_val = abs_s; }
            }
            desc.rms = (sum_sq / count as f32).sqrt();
            desc.peak = peak_val;
            desc.crest_factor = if desc.rms > 1e-7 { desc.peak / desc.rms } else { 0.0 };
        }
        let frame_offset = f * num_bins;
        let frame_mags = &stft.data[frame_offset..frame_offset + num_bins];
        let mut mag_sum = 0.0;
        let mut centroid_num = 0.0;
        let mut log_sum = 0.0;
        let mut sq_sum = 0.0;
        for k in 0..num_bins {
            let mag = frame_mags[k];
            mag_sum += mag;
            let freq = k as f32 * bin_freq_step;
            centroid_num += freq * mag;
            let mag_sq = mag * mag;
            log_sum += (mag_sq + 1e-7).ln();
            sq_sum += mag_sq;
        }
        desc.spectral_centroid = if mag_sum > 1e-7 { centroid_num / mag_sum } else { 0.0 };
        let mut bandwidth_num = 0.0;
        for k in 0..num_bins {
            let mag = frame_mags[k];
            let freq = k as f32 * bin_freq_step;
            let diff = freq - desc.spectral_centroid;
            bandwidth_num += diff * diff * mag;
        }
        desc.spectral_bandwidth = if mag_sum > 1e-7 { (bandwidth_num / mag_sum).sqrt() } else { 0.0 };
        desc.spectral_flatness = if sq_sum > 1e-7 {
            let geom_mean = (log_sum / num_bins as f32).exp();
            let arith_mean = sq_sum / num_bins as f32;
            geom_mean / arith_mean
        } else { 0.0 };
    });
    for f in 0..num_frames {
        if f == 0 { descriptors[f].spectral_flux = 0.0; } else {
            let current_offset = f * num_bins;
            let prev_offset = (f - 1) * num_bins;
            let mut diff_sum = 0.0;
            for k in 0..num_bins {
                let diff = stft.data[current_offset + k] - stft.data[prev_offset + k];
                diff_sum += diff * diff;
            }
            descriptors[f].spectral_flux = diff_sum.sqrt();
        }
    }
    descriptors
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DetectorThresholds {
    pub click_crest_factor: f32,
    pub click_bandwidth_ratio: f32,
    pub click_rms_multiplier: f32,
    pub pop_energy_ratio: f32,
    pub pop_crest_factor: f32,
    pub pop_rms_multiplier: f32,
    pub hum_neighbor_ratio: f32,
    pub hum_min_mag: f32,
    pub hum_active_ratio: f32,
    pub hum_cv_threshold: f32,
    pub hum_harmonic_decay_max: f32,
    pub hum_global_persistence_min: f32,
    pub clip_consecutive: usize,
    pub clip_threshold: f32,
    pub clip_tolerance: f32,
    pub dropout_rms_ratio: f32,
    pub dropout_min_duration_ms: f32,
    pub spectral_sensitivity: f32,
}
impl Default for DetectorThresholds {
    fn default() -> Self {
        Self {
            click_crest_factor: 15.0,
            click_bandwidth_ratio: 0.8,
            click_rms_multiplier: 2.0,
            pop_energy_ratio: 0.8,
            pop_crest_factor: 5.0,
            pop_rms_multiplier: 3.0,
            hum_neighbor_ratio: 1.5,
            hum_min_mag: 0.005,
            hum_active_ratio: 0.4,
            hum_cv_threshold: 0.1,
            hum_harmonic_decay_max: 0.8,
            hum_global_persistence_min: 0.05,
            clip_consecutive: 3,
            clip_threshold: 0.99,
            clip_tolerance: 1e-4,
            dropout_rms_ratio: 0.1,
            dropout_min_duration_ms: 10.0,
            spectral_sensitivity: 0.12,
        }
    }
}

pub fn detect_artifacts_dynamic(
    samples: &[f32],
    stft: &AnalyticalSpectrogram,
    fft_size: usize,
    hop_size: usize,
    sample_rate: u32,
    active_filters: &std::collections::HashMap<String, bool>,
    time_start: f64,
    time_end: f64,
    thresholds: &DetectorThresholds,
) -> DetectionResult {
    let mut transients = Vec::new();
    let mut stationaries = Vec::new();
    let descriptors = extract_descriptors(samples, stft, fft_size, hop_size, sample_rate);
    let num_frames = stft.num_frames;
    
    let start_secs = time_start;
    let end_secs = time_end;
    let start_frame = (start_secs * sample_rate as f64 / hop_size as f64).floor() as usize;
    let end_frame = (end_secs * sample_rate as f64 / hop_size as f64).ceil() as usize;
    let start_frame = start_frame.min(num_frames);
    let end_frame = end_frame.min(num_frames).max(start_frame);

    // ADVANCED HISS DETECTION (PROD-005) - Done first to tune HFER
    let mut hiss_rms_avg = 0.0;
    if active_filters.get("hiss").copied().unwrap_or(false) {
        let frame_duration = hop_size as f32 / sample_rate as f32;
        let min_run_frames = (0.5 / frame_duration) as usize; // 500ms
        let max_gap_frames = (1.0 / frame_duration) as usize; 

        let mut hiss_start_frame = None;
        let mut last_hiss_frame = None;
        let mut total_hiss_rms = 0.0;
        let mut hiss_frames_count = 0;

        let mut f = start_frame;
        while f < end_frame {
            let desc = &descriptors[f];
            let is_hiss_frame = desc.spectral_flatness > 0.45 
                && desc.rms > 0.001 
                && desc.spectral_centroid > (sample_rate as f32 * 0.1);

            if is_hiss_frame {
                if hiss_start_frame.is_none() { hiss_start_frame = Some(f); }
                last_hiss_frame = Some(f);
                total_hiss_rms += desc.rms;
                hiss_frames_count += 1;
            } else {
                if let Some(start) = hiss_start_frame {
                    let last = last_hiss_frame.unwrap_or(start);
                    let gap = f - last;
                    if gap > max_gap_frames {
                        let run_length = last - start;
                        if run_length >= min_run_frames {
                            let time_start_ev = start as f64 * frame_duration as f64;
                            let time_end_ev = last as f64 * frame_duration as f64;
                            let mut sum_flatness = 0.0;
                            let mut sum_rms = 0.0;
                            for idx in start..last {
                                sum_flatness += descriptors[idx].spectral_flatness;
                                sum_rms += descriptors[idx].rms;
                            }
                            let avg_flatness = sum_flatness / run_length as f32;
                            let avg_rms = sum_rms / run_length as f32;
                            let confidence = 0.4 + 0.6 * (avg_flatness - 0.45) / (1.0 - 0.45);

                            stationaries.push(StationaryEvent {
                                start_time_secs: time_start_ev,
                                end_time_secs: time_end_ev,
                                event_type: GlitchType::Hiss,
                                artifact_type: "HISS".to_string(),
                                confidence: confidence.clamp(0.0, 1.0),
                                average_db: 20.0 * avg_rms.max(1e-7).log10(),
                                spectral_flatness: avg_flatness,
                                hum_evidence: None,
                            });
                        }
                        hiss_start_frame = None;
                        last_hiss_frame = None;
                    }
                }
            }
            f += 1;
        }
        if let Some(start) = hiss_start_frame {
            let last = last_hiss_frame.unwrap_or(start);
            let run_length = last - start;
            if run_length >= min_run_frames {
                let time_start_ev = start as f64 * frame_duration as f64;
                let time_end_ev = last as f64 * frame_duration as f64;
                let mut sum_flatness = 0.0;
                let mut sum_rms = 0.0;
                for idx in start..last {
                    sum_flatness += descriptors[idx].spectral_flatness;
                    sum_rms += descriptors[idx].rms;
                }
                let avg_flatness = sum_flatness / run_length as f32;
                let avg_rms = sum_rms / run_length as f32;
                let confidence = 0.4 + 0.6 * (avg_flatness - 0.45) / (1.0 - 0.45);

                stationaries.push(StationaryEvent {
                    start_time_secs: time_start_ev,
                    end_time_secs: time_end_ev,
                    event_type: GlitchType::Hiss,
                    artifact_type: "HISS".to_string(),
                    confidence: confidence.clamp(0.0, 1.0),
                    average_db: 20.0 * avg_rms.max(1e-7).log10(),
                    spectral_flatness: avg_flatness,
                    hum_evidence: None,
                });
            }
        }
        if hiss_frames_count > 0 { hiss_rms_avg = total_hiss_rms / hiss_frames_count as f32; }
    }

    // Dynamic HFER multiplier
    let mut dynamic_hfer_multiplier = 3.0;
    if hiss_rms_avg > 0.005 {
        dynamic_hfer_multiplier = (3.0 - (hiss_rms_avg * 100.0)).max(1.5);
    }

    // Hybrid Clicks
    if active_filters.get("clicks").copied().unwrap_or(false) {
        let order = 2;
        let err_window = 256.0;
        let lpc_threshold = 6.0;
        let mut w = vec![0.0f32; order];
        let mu = 0.05;
        let mut running_error_sq: f32 = 0.0;
        let min_err_rms = 0.001;

        let start_sample = (start_secs * sample_rate as f64) as usize;
        let end_sample = (end_secs * sample_rate as f64) as usize;
        let start_sample = start_sample.min(samples.len());
        let end_sample = end_sample.min(samples.len()).max(start_sample);

        let mut candidates = Vec::new();
        for i in start_sample.max(order)..end_sample {
            let x = samples[i];
            let mut x_hat = 0.0;
            for j in 0..order { x_hat += w[j] * samples[i - 1 - j]; }
            let e = x - x_hat;
            running_error_sq = running_error_sq + (e * e - running_error_sq) / err_window;
            let err_rms = running_error_sq.max(0.0).sqrt().max(min_err_rms);
            if e.abs() > lpc_threshold * err_rms {
                candidates.push(GlitchEvent {
                    sample_index: i, time_secs: i as f64 / sample_rate as f64,
                    amplitude_delta: e, direction: if e > 0.0 { 1 } else { -1 },
                    artifact_type: "CLICK".to_string(), event_type: GlitchType::Sample, repaired: false, confidence: 1.0, hum_evidence: None,
                });
            } else {
                for j in 0..order { w[j] += mu * e * samples[i - 1 - j]; }
            }
        }

        let mut clustered = Vec::new();
        let max_distance_samples = sample_rate as usize / 200;
        if !candidates.is_empty() {
            let mut current_cluster = vec![candidates[0].clone()];
            for i in 1..candidates.len() {
                if candidates[i].sample_index - candidates[i - 1].sample_index <= max_distance_samples { 
                    current_cluster.push(candidates[i].clone()); 
                } else {
                    let rep = current_cluster.iter().max_by(|a, b| a.amplitude_delta.abs().partial_cmp(&b.amplitude_delta.abs()).unwrap()).unwrap().clone();
                    clustered.push(rep); current_cluster.clear(); current_cluster.push(candidates[i].clone());
                }
            }
            if !current_cluster.is_empty() {
                let rep = current_cluster.iter().max_by(|a, b| a.amplitude_delta.abs().partial_cmp(&b.amplitude_delta.abs()).unwrap()).unwrap().clone();
                clustered.push(rep);
            }
        }

        let get_hfer = |f_idx: usize| -> f32 {
            if f_idx >= stft.num_frames { return 0.0; }
            let offset = f_idx * stft.num_bins;
            let mut hf_e = 0.0; let mut lf_e = 0.0;
            for b in 0..(stft.num_bins / 4) { lf_e += stft.data[offset + b]; }
            for b in (stft.num_bins / 2)..stft.num_bins { hf_e += stft.data[offset + b]; }
            hf_e / (lf_e + 1e-6)
        };

        let hfer_threshold = thresholds.spectral_sensitivity;
        for mut cand in clustered {
            let frame_idx = cand.sample_index / stft.hop_size;
            if frame_idx < 4 || frame_idx + 4 >= stft.num_frames { continue; }
            let mut max_hfer = 0.0;
            for f in (frame_idx - 1)..=(frame_idx + 1) {
                let hfer = get_hfer(f);
                if hfer > max_hfer { max_hfer = hfer; }
            }
            let mut avg_hfer_bg = 0.0;
            let bg_frames = [frame_idx - 4, frame_idx - 3, frame_idx + 3, frame_idx + 4];
            for f in bg_frames.iter() { avg_hfer_bg += get_hfer(*f); }
            avg_hfer_bg /= 4.0;
            
            if max_hfer > avg_hfer_bg * dynamic_hfer_multiplier && max_hfer > hfer_threshold {
                cand.confidence = ((max_hfer - hfer_threshold) / (1.0 - hfer_threshold)).clamp(0.0, 1.0);
                transients.push(cand);
            }
        }
    }

    // Hybrid Pops (ignoring 50/60Hz implicitly handled here or via LFER)
    if active_filters.get("use_hybrid_pop_detector").copied().unwrap_or(false) || active_filters.get("pops").copied().unwrap_or(false) {
        let mut pop_events = detect_pops_dynamic(samples, stft, fft_size, hop_size, sample_rate, start_secs, end_secs);
        transients.append(&mut pop_events);
    }

    // Advanced Hum
    if active_filters.get("hum").copied().unwrap_or(false) {
        let hum_events = detect_hum_dynamic(samples, stft, fft_size, hop_size, sample_rate, start_secs, end_secs, thresholds);
        
        for h in hum_events {
            stationaries.push(StationaryEvent {
                start_time_secs: h.time_secs,
                end_time_secs: h.time_secs + 0.5, 
                event_type: GlitchType::Slip,
                artifact_type: h.artifact_type,
                confidence: h.confidence,
                average_db: 20.0 * h.amplitude_delta.max(1e-7).log10(),
                spectral_flatness: 0.0, 
                hum_evidence: h.hum_evidence,
            });
        }
    }

    // ADVANCED CLIPPING (PROD-005) - Dynamic Tolerant Clipping
    if active_filters.get("clipping").copied().unwrap_or(false) {
        let mut hist = [0usize; 1024];
        let start_sample = (start_secs * sample_rate as f64) as usize;
        let end_sample = (end_secs * sample_rate as f64) as usize;
        let start_sample = start_sample.min(samples.len());
        let end_sample = end_sample.min(samples.len()).max(start_sample);

        for &s in &samples[start_sample..end_sample] {
            let bin = ((s.abs() * 1023.0) as usize).min(1023);
            hist[bin] += 1;
        }

        let mut dynamic_ceiling = thresholds.clip_threshold;
        let total_samples = (end_sample - start_sample) as f64;
        if total_samples > 1000.0 {
            for bin in (512..1023).rev() {
                if hist[bin] > (total_samples * 0.0005) as usize {
                    let mut sum_above = 0;
                    for b in (bin + 1)..1024 { sum_above += hist[b]; }
                    if sum_above < (total_samples * 0.00005) as usize {
                        dynamic_ceiling = bin as f32 / 1023.0;
                        break;
                    }
                }
            }
        }
        let dynamic_ceiling = dynamic_ceiling.max(0.5);

        let clip_tol = 0.015; // Suavizado para ruido
        let mut i = start_sample + 1;
        while i < end_sample - 1 {
            let val = (samples[i-1].abs() + samples[i].abs() + samples[i+1].abs()) / 3.0;
            
            if val >= (dynamic_ceiling - clip_tol) {
                let mut count = 0;
                while i + count < end_sample - 1 {
                    let smoothed_next = (samples[i+count-1].abs() + samples[i+count].abs() + samples[i+count+1].abs()) / 3.0;
                    if (smoothed_next - val).abs() < clip_tol && smoothed_next >= (dynamic_ceiling - clip_tol) {
                        count += 1;
                    } else {
                        break;
                    }
                }

                if count >= thresholds.clip_consecutive {
                    let start_idx = i;
                    let end_idx = i + count - 1;
                    
                    let pre_idx = start_idx.saturating_sub(1);
                    let post_idx = (end_idx + 1).min(samples.len() - 1);
                    let pre_pre_idx = start_idx.saturating_sub(3);
                    let post_post_idx = (end_idx + 3).min(samples.len() - 1);

                    let t = 0.5f32;
                    let y0 = samples[pre_idx];
                    let y1 = samples[post_idx];
                    let m0 = (samples[pre_idx] - samples[pre_pre_idx]) * 2.0;
                    let m1 = (samples[post_post_idx] - samples[post_idx]) * 2.0;

                    let h00 = 2.0*t*t*t - 3.0*t*t + 1.0;
                    let h10 = t*t*t - 2.0*t*t + t;
                    let h01 = -2.0*t*t*t + 3.0*t*t;
                    let h11 = t*t*t - t*t;

                    let predicted_peak = h00 * y0 + h10 * m0 + h01 * y1 + h11 * m1;
                    let delta_peak = (predicted_peak.abs() - samples[start_idx].abs()).max(0.0);

                    let spline_residual_factor = (delta_peak / dynamic_ceiling).min(1.0);
                    let length_factor = (count as f32 / 3.0).min(3.0) / 3.0;
                    let raw_confidence = 0.4 + 0.6 * (spline_residual_factor * 2.0 + length_factor).min(1.0);

                    let sample_idx = start_idx + count / 2;
                    transients.push(GlitchEvent {
                        sample_index: sample_idx,
                        time_secs: sample_idx as f64 / sample_rate as f64,
                        amplitude_delta: val,
                        direction: if samples[start_idx] > 0.0 { 1 } else { -1 },
                        event_type: GlitchType::Sample,
                        repaired: false,
                        artifact_type: "CLIP".to_string(),
                        confidence: raw_confidence.clamp(0.0, 1.0),
                        hum_evidence: None,
                    });
                    i += count;
                    continue;
                }
            }
            i += 1;
        }
    }

    // ADVANCED DROPOUTS (PROD-005) - Log Envelope Decay
    if active_filters.get("dropouts").copied().unwrap_or(false) {
        let mut active_rms_vals = Vec::new();
        let num_f = stft.num_frames;
        let limit_f = end_frame.min(num_f);
        for f in start_frame..limit_f {
            let rms = descriptors[f].rms;
            if rms > 1e-4 { active_rms_vals.push(rms); }
        }
        let n_floor = if !active_rms_vals.is_empty() {
            let target_idx = (active_rms_vals.len() as f32 * 0.1) as usize;
            let (_, &mut val, _) = active_rms_vals.select_nth_unstable_by(target_idx, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            val.max(0.0005)
        } else { 0.005 };

        let frame_duration = hop_size as f32 / sample_rate as f32;
        let mut in_dropout = false;
        let mut dropout_start_frame = start_frame;
        let mut max_decay_rate = 0.0f32;

        for f in (start_frame + 1)..limit_f {
            let rms = descriptors[f].rms;
            let prev_rms = descriptors[f - 1].rms;

            let rms_db = 20.0 * (rms + 1e-7).log10();
            let prev_rms_db = 20.0 * (prev_rms + 1e-7).log10();
            let decay_rate = (rms_db - prev_rms_db) / frame_duration;

            let is_dropping = decay_rate < -1500.0 && rms < n_floor * 0.5 && prev_rms > 0.002;
            let is_very_low = rms < n_floor * 0.2;

            if is_dropping || (in_dropout && is_very_low) {
                if !in_dropout {
                    in_dropout = true;
                    dropout_start_frame = f;
                    max_decay_rate = decay_rate;
                } else {
                    max_decay_rate = max_decay_rate.min(decay_rate);
                }
            } else {
                if in_dropout {
                    let duration_ms = (f - dropout_start_frame) as f32 * frame_duration * 1000.0;
                    if duration_ms > thresholds.dropout_min_duration_ms {
                        let sample_idx = dropout_start_frame * hop_size + fft_size / 2;
                        let floor_ratio = (1.0 - (rms / n_floor)).clamp(0.0, 1.0);
                        let slope_factor = (max_decay_rate / -3000.0).min(1.0);
                        let confidence = 0.5 + 0.5 * (slope_factor * 0.7 + floor_ratio * 0.3);

                        transients.push(GlitchEvent {
                            sample_index: sample_idx,
                            time_secs: sample_idx as f64 / sample_rate as f64,
                            amplitude_delta: n_floor - rms,
                            direction: -1,
                            event_type: GlitchType::Drop,
                            repaired: false,
                            artifact_type: "DROPOUT".to_string(),
                            confidence: confidence.clamp(0.0, 1.0),
                            hum_evidence: None,
                        });
                    }
                    in_dropout = false;
                }
            }
        }
    }

    // CLUSTERING OF TRANSIENTS ONLY
    transients.sort_by_key(|e| e.sample_index);
    let mut consolidated_events = Vec::new();
    if !transients.is_empty() {
        let max_distance_samples = (sample_rate as f64 * 0.015) as usize; 
        let mut current_cluster: Vec<GlitchEvent> = vec![transients[0].clone()];

        let get_group = |art_type: &str| -> String {
            if art_type == "CLICK" || art_type == "CLICK_LEGACY" { "click".to_string() } 
            else if art_type == "POP" || art_type == "POP_LEGACY" { "pop".to_string() } 
            else if art_type == "CLIP" { "clip".to_string() } 
            else if art_type == "DROPOUT" { "dropout".to_string() } 
            else { art_type.to_string() }
        };

        for event in transients.into_iter().skip(1) {
            let last_in_cluster = &current_cluster[current_cluster.len() - 1];
            let is_same_group = get_group(&event.artifact_type) == get_group(&last_in_cluster.artifact_type);
            let within_distance = event.sample_index - last_in_cluster.sample_index <= max_distance_samples;

            if within_distance && is_same_group {
                current_cluster.push(event);
            } else {
                let representative = current_cluster.iter().max_by(|a, b| a.amplitude_delta.abs().partial_cmp(&b.amplitude_delta.abs()).unwrap_or(std::cmp::Ordering::Equal)).unwrap().clone();
                consolidated_events.push(representative);
                current_cluster = vec![event];
            }
        }
        if !current_cluster.is_empty() {
            let representative = current_cluster.iter().max_by(|a, b| a.amplitude_delta.abs().partial_cmp(&b.amplitude_delta.abs()).unwrap_or(std::cmp::Ordering::Equal)).unwrap().clone();
            consolidated_events.push(representative);
        }
    }

    DetectionResult {
        transients: consolidated_events,
        stationaries,
    }
}


pub fn detect_pops_dynamic(
    samples: &[f32],
    stft: &AnalyticalSpectrogram,
    _fft_size: usize,
    _hop_size: usize,
    sample_rate: u32,
    start_secs: f64,
    end_secs: f64,
) -> Vec<GlitchEvent> {
    let t_start = std::time::Instant::now();
    let mut events = Vec::new();
    
    let win_size = (sample_rate as f32 * 0.05) as usize; // 50ms
    let scan_hop = (sample_rate as f32 * 0.01) as usize; // 10ms
    let surround_size = (sample_rate as f32 * 0.5) as usize; // 500ms
    
    let dc_thresh = 0.05;
    let lfer_thresh = 0.10;
    let cr_thresh = 35.0;
    
    let total_samples = samples.len();
    let start_sample = (start_secs * sample_rate as f64) as usize;
    let end_sample = (end_secs * sample_rate as f64) as usize;
    
    let safe_start = start_sample.max(surround_size).min(total_samples);
    let safe_end = end_sample.min(total_samples.saturating_sub(surround_size + win_size)).max(safe_start);

    // 1 & 2. DC Offset + LFER Gate (Candidatos)
    #[derive(Clone)]
    struct PopCandidate {
        idx: usize,
        dc: f32,
        lfer: f32,
        duration: usize,
    }
    
    let mut candidates = Vec::new();
    let mut i = safe_start;
    
    // Función auxiliar para obtener LFER desde la STFT aproximada usando el frame más cercano
    let get_lfer = |idx: usize| -> f32 {
        let frame_idx = idx / stft.hop_size;
        if frame_idx >= stft.num_frames { return 0.0; }
        let offset = frame_idx * stft.num_bins;
        let mut lf_energy = 0.0;
        let mut total_energy = 0.0;
        let bin_150 = (150.0 * stft.fft_size as f32 / sample_rate as f32).round() as usize;
        let bin_150 = bin_150.min(stft.num_bins);
        
        for b in 0..stft.num_bins {
            let mag = stft.data[offset + b];
            total_energy += mag;
            if b < bin_150 {
                lf_energy += mag;
            }
        }
        if total_energy > 1e-6 { lf_energy / total_energy } else { 0.0 }
    };

    while i < safe_end {
        let mut sum = 0.0;
        for j in 0..win_size {
            sum += samples[i + j];
        }
        let dc = (sum / win_size as f32).abs();
        
        if dc > dc_thresh {
            let lfer = get_lfer(i);
            if lfer > lfer_thresh {
                candidates.push(PopCandidate { idx: i, dc, lfer, duration: win_size });
            }
        }
        i += scan_hop;
    }
    
    // Clustering
    let mut clustered = Vec::new();
    let cluster_gap = (sample_rate as f32 * 0.1) as usize; // 100ms
    if !candidates.is_empty() {
        let mut current_cluster = vec![candidates[0].clone()];
        for cand in candidates.into_iter().skip(1) {
            if cand.idx - current_cluster.last().unwrap().idx <= cluster_gap {
                current_cluster.push(cand);
            } else {
                let best = current_cluster.iter().max_by(|a, b| a.dc.partial_cmp(&b.dc).unwrap()).unwrap().clone();
                clustered.push(best);
                current_cluster = vec![cand];
            }
        }
        let best = current_cluster.iter().max_by(|a, b| a.dc.partial_cmp(&b.dc).unwrap()).unwrap().clone();
        clustered.push(best);
    }
    
    // 3. Context Ratio Validation
    for cand in &clustered {
        let idx = cand.idx;
        
        let mut sum_before = 0.0;
        for j in (idx - surround_size)..idx {
            sum_before += samples[j];
        }
        let dc_before = (sum_before / surround_size as f32).abs();
        
        let mut sum_after = 0.0;
        for j in (idx + win_size)..(idx + win_size + surround_size) {
            sum_after += samples[j];
        }
        let dc_after = (sum_after / surround_size as f32).abs();
        
        let dc_surround = (dc_before + dc_after) / 2.0;
        let cr = cand.dc / (dc_surround + 1e-6);
        
        if cr > cr_thresh {
            // 4. Confidence
            // Mapeamos CR de [35.0, 150.0] a [0.0, 1.0]
            let confidence = ((cr - cr_thresh) / (150.0 - cr_thresh)).clamp(0.0, 1.0);
            
            // 5. Generar Evento
            events.push(GlitchEvent {
                sample_index: cand.idx + win_size / 2, // Centrar el evento
                time_secs: (cand.idx + win_size / 2) as f64 / sample_rate as f64,
                amplitude_delta: cand.dc,
                direction: if sum_before > 0.0 { 1 } else { -1 },
                event_type: GlitchType::Drop,
                repaired: false,
                artifact_type: "POP".to_string(),
                confidence,
                hum_evidence: None,
            });
        }
    }
    
    let elapsed = t_start.elapsed();
    println!("[PROD-003 Metrics] Pop Detector: {:?}, Cand: {}, Events: {}", elapsed, clustered.len(), events.len());
    
    events
}

/// Implementación del detector de Hum Híbrido-Contextual (INV-003D / AF-016 / AF-018)
/// Fundamental -> CV -> Persistencia Local -> Confidence (Harmonic Decay + Global Persistence) -> Hum
pub fn detect_hum_dynamic(
    _samples: &[f32],
    stft: &AnalyticalSpectrogram,
    fft_size: usize,
    hop_size: usize,
    sample_rate: u32,
    start_secs: f64,
    end_secs: f64,
    thresholds: &DetectorThresholds,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let num_frames = stft.num_frames;
    let num_bins = stft.num_bins;

    // Target fundamentals for grid hum
    let target_fundamentals = [50.0f32, 60.0f32];

    // Frame duration in seconds
    let frame_duration = hop_size as f64 / sample_rate as f64;
    // 200ms in frames
    let cv_window_frames = (0.2 / frame_duration).round() as usize;
    let cv_window_frames = cv_window_frames.max(3);

    // 500ms in frames for local persistence
    let persistence_frames_req = (0.5 / frame_duration).round() as usize;
    let persistence_frames_req = persistence_frames_req.max(5);

    // Viewport frame limits
    let start_frame = (start_secs / frame_duration).floor() as usize;
    let end_frame = (end_secs / frame_duration).ceil() as usize;
    let start_frame = start_frame.min(num_frames);
    let end_frame = end_frame.min(num_frames).max(start_frame);

    for &f0 in &target_fundamentals {
        let mut f0_events = Vec::new();
        let bin_f0 = (f0 * fft_size as f32 / sample_rate as f32).round() as usize;
        let bin_f1 = ((2.0 * f0) * fft_size as f32 / sample_rate as f32).round() as usize;

        if bin_f0 > 1 && bin_f0 < num_bins - 1 && bin_f1 < num_bins {
            // Retrieve global persistence calculated in compute_stft in O(1)
            let global_persistence = stft.global_hum_persistence.get(&(f0 as u32)).copied().unwrap_or(0.0);

            // Now, scan the viewport frames to find stable regions
            let mut active_run_start: Option<usize> = None;

            for f in start_frame..end_frame {
                let offset = f * num_bins;
                let mag = stft.data[offset + bin_f0];
                let left = stft.data[offset + bin_f0 - 1];
                let right = stft.data[offset + bin_f0 + 1];
                let neighbor_avg = (left + right) / 2.0;

                let is_candidate = mag > thresholds.hum_neighbor_ratio * neighbor_avg && mag > thresholds.hum_min_mag;

                let mut is_stable = false;
                let mut current_cv = 999.0f32;

                if is_candidate && f >= cv_window_frames {
                    let mut sum_mag = 0.0;
                    let mut sum_sq_mag = 0.0;
                    let count = cv_window_frames;

                    for w in 0..count {
                        let f_w = f - w;
                        let mag_w = stft.data[f_w * num_bins + bin_f0];
                        sum_mag += mag_w;
                        sum_sq_mag += mag_w * mag_w;
                    }

                    let mean = sum_mag / count as f32;
                    let variance = (sum_sq_mag / count as f32) - (mean * mean);
                    let variance = variance.max(0.0);
                    let std_dev = variance.sqrt();
                    current_cv = if mean > 1e-7 { std_dev / mean } else { 999.0 };

                    if current_cv < thresholds.hum_cv_threshold {
                        is_stable = true;
                    }
                }

                if is_stable {
                    if active_run_start.is_none() {
                        active_run_start = Some(f);
                    }
                } else {
                    if let Some(start_f) = active_run_start {
                        let duration_frames = f - start_f;
                        if duration_frames >= persistence_frames_req {
                            // Calculate metrics over the segment
                            let mut sum_active_mag = 0.0;
                            let mut sum_harmonic_mag = 0.0;
                            for frame in start_f..f {
                                sum_active_mag += stft.data[frame * num_bins + bin_f0];
                                sum_harmonic_mag += stft.data[frame * num_bins + bin_f1];
                            }
                            let avg_mag = sum_active_mag / duration_frames as f32;
                            let avg_harm_mag = sum_harmonic_mag / duration_frames as f32;

                            let decay_ratio = if avg_mag > 1e-7 { avg_harm_mag / avg_mag } else { 999.0 };
                            let decay_score = if decay_ratio < thresholds.hum_harmonic_decay_max {
                                1.0f32
                            } else if decay_ratio < 1.2 {
                                0.5f32
                            } else {
                                0.0f32
                            };

                            let global_persist_score = if global_persistence >= thresholds.hum_global_persistence_min {
                                let divisor = (0.50 - thresholds.hum_global_persistence_min).max(0.01);
                                ((global_persistence - thresholds.hum_global_persistence_min) / divisor).clamp(0.0, 1.0)
                            } else {
                                0.0f32
                            };

                            let confidence = (decay_score * 0.5) + (global_persist_score * 0.5);

                            if confidence >= 0.7 && global_persistence >= thresholds.hum_global_persistence_min {
                                let sample_idx = start_f * hop_size;
                                let time_secs = sample_idx as f64 / sample_rate as f64;
                                f0_events.push(GlitchEvent {
                                    sample_index: sample_idx,
                                    time_secs,
                                    amplitude_delta: avg_mag,
                                    direction: f0 as i8,
                                    event_type: GlitchType::Slip,
                                    repaired: false,
                                    artifact_type: format!("HUM ({:.0} Hz)", f0),
                                    confidence,
                                    hum_evidence: Some(HumEvidence {
                                        cv: current_cv,
                                        harmonic_decay: decay_ratio,
                                        global_persistence,
                                    }),
                                });
                            }
                        }
                        active_run_start = None;
                    }
                }
            }

            if let Some(start_f) = active_run_start {
                let duration_frames = end_frame - start_f;
                if duration_frames >= persistence_frames_req {
                    let mut sum_active_mag = 0.0;
                    let mut sum_harmonic_mag = 0.0;
                    for frame in start_f..end_frame {
                        sum_active_mag += stft.data[frame * num_bins + bin_f0];
                        sum_harmonic_mag += stft.data[frame * num_bins + bin_f1];
                    }
                    let avg_mag = sum_active_mag / duration_frames as f32;
                    let avg_harm_mag = sum_harmonic_mag / duration_frames as f32;

                    let decay_ratio = if avg_mag > 1e-7 { avg_harm_mag / avg_mag } else { 999.0 };
                    let decay_score = if decay_ratio < thresholds.hum_harmonic_decay_max {
                        1.0f32
                    } else if decay_ratio < 1.2 {
                        0.5f32
                    } else {
                        0.0f32
                    };

                    let global_persist_score = if global_persistence >= thresholds.hum_global_persistence_min {
                        let divisor = (0.50 - thresholds.hum_global_persistence_min).max(0.01);
                        ((global_persistence - thresholds.hum_global_persistence_min) / divisor).clamp(0.0, 1.0)
                    } else {
                        0.0f32
                    };

                    let confidence = (decay_score * 0.5) + (global_persist_score * 0.5);

                    if confidence >= 0.7 && global_persistence >= thresholds.hum_global_persistence_min {
                        let sample_idx = start_f * hop_size;
                        let time_secs = sample_idx as f64 / sample_rate as f64;
                        f0_events.push(GlitchEvent {
                            sample_index: sample_idx,
                            time_secs,
                            amplitude_delta: avg_mag,
                            direction: f0 as i8,
                            event_type: GlitchType::Slip,
                            repaired: false,
                            artifact_type: format!("HUM ({:.0} Hz)", f0),
                            confidence,
                            hum_evidence: Some(HumEvidence {
                                cv: thresholds.hum_cv_threshold, // approximate CV
                                harmonic_decay: decay_ratio,
                                global_persistence,
                            }),
                        });
                    }
                }
            }
        }

        // Consolidation logic: merge all local segments of this fundamental frequency into 1 master event
        if !f0_events.is_empty() {
            let first_event = &f0_events[0];
            let count = f0_events.len() as f32;
            
            let mut sum_amp = 0.0;
            let mut sum_conf = 0.0;
            let mut sum_cv = 0.0;
            let mut sum_decay = 0.0;
            
            for ev in &f0_events {
                sum_amp += ev.amplitude_delta;
                sum_conf += ev.confidence;
                if let Some(ref evidence) = ev.hum_evidence {
                    sum_cv += evidence.cv;
                    sum_decay += evidence.harmonic_decay;
                }
            }
            
            let global_persistence = first_event.hum_evidence.as_ref().map(|e| e.global_persistence).unwrap_or(0.0);
            
            events.push(GlitchEvent {
                sample_index: first_event.sample_index,
                time_secs: first_event.time_secs,
                amplitude_delta: sum_amp / count,
                direction: f0 as i8,
                event_type: GlitchType::Slip,
                repaired: false,
                artifact_type: format!("HUM ({:.0} Hz)", f0),
                confidence: sum_conf / count,
                hum_evidence: Some(HumEvidence {
                    cv: sum_cv / count,
                    harmonic_decay: sum_decay / count,
                    global_persistence,
                }),
            });
        }
    }

    events
}

pub fn get_paged_spectrogram(
    stft: &AnalyticalSpectrogram,
    config: &ViewportConfig,
) -> PagedStftResult {
    let num_bins = stft.num_bins;
    let total_frames = stft.num_frames;
    let start = config.start_frame.min(total_frames);
    let end = config.end_frame.min(total_frames).max(start);
    let visible_frames_len = end - start;
    let max_width = 1024;
    let max_height = 512;
    let target_bins = num_bins.min(max_height);
    if visible_frames_len == 0 {
        return PagedStftResult { matrix: String::new(), num_frames: 0, num_bins: target_bins };
    }
    let target_frames = visible_frames_len.min(max_width);
    let mut downsampled_matrix = vec![0u8; target_frames * target_bins];
    let frame_step = visible_frames_len as f64 / target_frames as f64;
    let bin_step = num_bins as f64 / target_bins as f64;
    for dest_f in 0..target_frames {
        let src_f_start = (start as f64 + dest_f as f64 * frame_step).floor() as usize;
        let src_f_end = (start as f64 + (dest_f + 1) as f64 * frame_step).ceil() as usize;
        let src_f_end = src_f_end.min(end).max(src_f_start + 1);
        let f_count = (src_f_end - src_f_start) as f32;
        let dest_offset = dest_f * target_bins;
        for dest_b in 0..target_bins {
            let src_b_start = (dest_b as f64 * bin_step).floor() as usize;
            let src_b_end = ((dest_b + 1) as f64 * bin_step).ceil() as usize;
            let src_b_end = src_b_end.min(num_bins).max(src_b_start + 1);
            let b_count = (src_b_end - src_b_start) as f32;
            let mut sum_sq = 0.0;
            for src_f in src_f_start..src_f_end {
                let frame_offset = src_f * num_bins;
                for src_b in src_b_start..src_b_end {
                    let val = stft.data[frame_offset + src_b];
                    sum_sq += val * val;
                }
            }
            let rms = (sum_sq / (f_count * b_count)).sqrt();
            let db = 20.0 * rms.max(1e-7).log10();
            let u8_val = ((db + 120.0) / 120.0 * 255.0).clamp(0.0, 255.0) as u8;
            downsampled_matrix[dest_offset + dest_b] = u8_val;
        }
    }
    use base64::Engine;
    let encoded = base64::engine::general_purpose::STANDARD.encode(&downsampled_matrix);
    PagedStftResult { matrix: encoded, num_frames: target_frames, num_bins: target_bins }
}
