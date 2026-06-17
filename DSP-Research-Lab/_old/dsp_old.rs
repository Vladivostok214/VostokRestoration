//! Módulo DSP (Digital Signal Processing) de Vostok Restoration v1
//! 
//! Implementa la decodificación nativa con `symphonia`, la STFT paralela
//! con `rustfft` (SIMD), el detector por primera derivada en tiempo lineal,
//! la interpolación Hermite cúbica in-place y el sub-muestreo espectral para WebGL.

use std::path::Path;
use std::sync::Arc;
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
    /// Caída rápida de energía (Micro drop de buffer)
    Drop,
    /// Salto aislado de muestra única (Spike / Dirac Impulse)
    Sample,
    /// Pérdida de sincronización de reloj (Clock Slip)
    Slip,
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
}

/// Decodifica un archivo de audio WAV, MP3 o FLAC a Float32 nativo usando `symphonia`
pub fn decode_audio_file<P: AsRef<Path>>(path: P) -> Result<AudioBuffer, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    
    // Crear el stream de origen multimedia
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
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
    let channels = track.codec_params.channels.map(|c| c.count() as u16).unwrap_or(1);
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
    
    let total_samples = samples.len();
    let duration_seconds = total_samples as f64 / sample_rate as f64;
    
    Ok(AudioBuffer {
        samples,
        sample_rate,
        channels,
        bit_depth,
        duration_seconds,
    })
}

/// Precomputa los coeficientes de la ventana de análisis
fn build_window(fft_size: usize, window_type: &str) -> Vec<f32> {
    let mut window = vec![0.0f32; fft_size];
    let pi2 = 2.0 * std::f32::consts::PI;
    if window_type == "blackman-harris" {
        let (a0, a1, a2, a3) = (0.35875f32, 0.48829f32, 0.14128f32, 0.01168f32);
        for i in 0..fft_size {
            let n = i as f32 / (fft_size - 1) as f32;
            window[i] = a0
                - a1 * (pi2 * n).cos()
                + a2 * (2.0 * pi2 * n).cos()
                - a3 * (3.0 * pi2 * n).cos();
        }
    } else {
        // Hann window
        for i in 0..fft_size {
            window[i] = 0.5 * (1.0 - (pi2 * i as f32 / (fft_size - 1) as f32).cos());
        }
    }
    window
}

/// Calcula la STFT usando `rustfft` (SIMD) con frames paralelos via `rayon`.
/// Cada frame es independiente: se procesa en un thread distinto sin locks.
pub fn compute_stft(
    samples: &[f32],
    fft_size: usize,
    hop_size: usize,
    window_type: &str,
) -> Result<StftResult, String> {
    let num_bins = fft_size / 2;
    if samples.len() < fft_size {
        return Err("Muestras insuficientes para el tamaño de FFT.".to_string());
    }

    let num_frames = (samples.len() - fft_size) / hop_size + 1;
    let mut matrix = vec![0.0f32; num_frames * num_bins];

    // 1. Ventana precomputada (un solo hilo, rápido)
    let window = build_window(fft_size, window_type);

    // 2. Plan FFT compartido entre threads: rustfft::Fft es Send + Sync
    let fft: Arc<dyn rustfft::Fft<f32>> = {
        let mut planner = FftPlanner::new();
        Arc::from(planner.plan_fft_forward(fft_size))
    };

    // Normalización: suma de ventana Blackman-Harris ≈ 0.35875×N, Hann ≈ 0.5×N
    let window_sum: f32 = window.iter().sum();
    let norm = 1.0 / window_sum.max(1e-9);

    // 3. Procesar frames en paralelo — cada chunk de `num_bins` es una fila independiente
    matrix
        .par_chunks_mut(num_bins)
        .enumerate()
        .for_each(|(f, frame_slice)| {
            let offset = f * hop_size;
            // Buffer local por thread (no shared state)
            let mut buf: Vec<Complex<f32>> = (0..fft_size)
                .map(|i| Complex::new(samples[offset + i] * window[i], 0.0))
                .collect();

            fft.process(&mut buf);

            for k in 0..num_bins {
                let mag = (buf[k].re * buf[k].re + buf[k].im * buf[k].im).sqrt() * norm;
                frame_slice[k] = mag.min(1.0);
            }
        });

    Ok(StftResult { matrix, num_frames, num_bins })
}

/// Serializa un `StftResult` a bytes compactos para transferencia IPC hacia el frontend.
///
/// Formato binario (little-endian):
/// ```text
/// [0..4)  num_frames : u32
/// [4..8)  num_bins   : u32
/// [8..)   magnitudes : u8 × (num_frames × num_bins)   (f32 [0,1] → u8 [0,255])
/// ```
/// El uso de u8 reduce el payload ~4× frente a f32 JSON, suficiente para display WebGL.
pub fn stft_to_binary(stft: &StftResult) -> Vec<u8> {
    let payload = stft.num_frames * stft.num_bins;
    let mut buf = Vec::with_capacity(8 + payload);
    buf.extend_from_slice(&(stft.num_frames as u32).to_le_bytes());
    buf.extend_from_slice(&(stft.num_bins   as u32).to_le_bytes());
    for &v in &stft.matrix {
        buf.push((v.clamp(0.0, 1.0) * 255.0) as u8);
    }
    buf
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

    // 1. Estimar noise floor (percentil 95 de la derivada)
    const PROBE: usize = 10000;
    let step = 1.max(n / PROBE);
    let mut deltas = Vec::new();
    let mut i = step;
    while i < n {
        deltas.push((samples[i] - samples[i - 1]).abs());
        i += step;
    }
    deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let noise_floor = if !deltas.is_empty() {
        deltas[(deltas.len() as f32 * 0.95) as usize].max(0.001)
    } else {
        0.001
    };

    let ctx_win = 32.max((sample_rate as f32 * 0.002) as usize); // ~2ms
    let min_gap = 32.max((sample_rate as f32 * 0.00133) as usize); // ~1.33ms

    let rms = |start: usize, len: usize| -> f32 {
        let end = (start + len).min(n);
        let s = start;
        if s >= end {
            return 0.0;
        }
        let mut sum = 0.0;
        for j in s..end {
            sum += samples[j] * samples[j];
        }
        (sum / (end - s) as f32).sqrt()
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
                && recovery1.min(recovery2) < threshold * 0.4
                && rms_before > (noise_floor * 6.0).max(min_active_rms);

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
            events.push(GlitchEvent {
                sample_index: event_idx,
                time_secs,
                amplitude_delta,
                direction: if samples[event_idx] > samples[event_idx - 1] { 1 } else { -1 },
                event_type,
                repaired: false,
            });
            last_idx = event_idx as isize;
        }
    }

    events
}

/// Repara quirúrgicamente los glitches aplicando Splines Cúbicas Hermite **in-place**.
/// Opera directamente sobre el slice mutable — sin allocación del buffer completo.
pub fn heal_glitches_inplace(
    samples: &mut [f32],
    glitches: &[GlitchEvent],
    noise_floor: f32,
) {
    let n_total = samples.len();

    for glitch in glitches {
        if glitch.repaired {
            continue;
        }

        let idx = glitch.sample_index;
        if idx >= n_total {
            continue;
        }

        // 1. Detectar extensión real del daño
        let max_win   = 256.min((glitch.amplitude_delta * 128.0) as usize);
        let dev_thresh = (noise_floor * 3.0).max(0.01);

        // Expandir hacia atrás
        let mut start_dmg = idx;
        while start_dmg > 1 && (idx - start_dmg) < max_win {
            if (samples[start_dmg] - samples[start_dmg - 1]).abs() > dev_thresh {
                start_dmg -= 1;
            } else {
                break;
            }
        }

        // Expandir hacia adelante
        let mut end_dmg = idx;
        while end_dmg < n_total - 2 && (end_dmg - idx) < max_win {
            if (samples[end_dmg] - samples[end_dmg + 1]).abs() > dev_thresh {
                end_dmg += 1;
            } else {
                break;
            }
        }

        // Márgenes seguros
        start_dmg = start_dmg.max(9);
        end_dmg   = end_dmg.min(n_total - 10);

        if start_dmg >= end_dmg {
            continue;
        }

        // 2. Puntos de anclaje (promedio de 8 samples)
        const ANCHOR: usize = 8;
        let (mut p0, mut p1) = (0.0f32, 0.0f32);
        for i in 0..ANCHOR {
            p0 += samples[start_dmg - 1 - i];
            p1 += samples[end_dmg + 1 + i];
        }
        p0 /= ANCHOR as f32;
        p1 /= ANCHOR as f32;

        // 3. Tangentes Catmull-Rom
        let p0prev = samples[start_dmg - 2];
        let p1next = samples[end_dmg + 2];
        let m0 = 0.5 * (p0 - p0prev);
        let m1 = 0.5 * (p1next - p1);

        // 4. Interpolación Hermite Cúbica (Continuidad C1)
        let span = end_dmg - start_dmg + 1;
        for i in 0..span {
            let t  = if span > 1 { i as f32 / (span - 1) as f32 } else { 0.5 };
            let t2 = t * t;
            let t3 = t2 * t;

            let h00 =  2.0 * t3 - 3.0 * t2 + 1.0;
            let h10 =       t3 - 2.0 * t2 + t;
            let h01 = -2.0 * t3 + 3.0 * t2;
            let h11 =       t3 - t2;

            samples[start_dmg + i] = (h00*p0 + h10*m0 + h01*p1 + h11*m1).clamp(-1.0, 1.0);
        }
    }
}

/// Wrapper de compatibilidad: retorna un Vec<f32> reparado (allocación completa).
/// Preferir `heal_glitches_inplace` cuando el buffer ya existe en memoria.
#[allow(dead_code)]
pub fn heal_glitches(
    samples: &[f32],
    glitches: &[GlitchEvent],
    noise_floor: f32,
) -> Vec<f32> {
    let mut v = samples.to_vec();
    heal_glitches_inplace(&mut v, glitches, noise_floor);
    v
}

/// Extrae y sub-muestrea la matriz espectral para adaptarla al área visible de WebGL
pub fn get_paged_spectrogram(
    stft: &StftResult,
    config: &ViewportConfig,
) -> StftResult {
    let num_bins = stft.num_bins;
    let total_frames = stft.num_frames;

    let start = config.start_frame.min(total_frames);
    let end = config.end_frame.min(total_frames).max(start);
    let visible_frames_len = end - start;

    if visible_frames_len == 0 {
        return StftResult {
            matrix: Vec::new(),
            num_frames: 0,
            num_bins,
        };
    }

    // Caso A: Si cabe dentro del tamaño máximo de textura de la GPU, se copia directamente
    if visible_frames_len <= config.max_texture_width {
        let mut sub_matrix = vec![0.0; visible_frames_len * num_bins];
        for f in 0..visible_frames_len {
            let src_offset = (start + f) * num_bins;
            let dest_offset = f * num_bins;
            sub_matrix[dest_offset..dest_offset + num_bins]
                .copy_from_slice(&stft.matrix[src_offset..src_offset + num_bins]);
        }
        return StftResult {
            matrix: sub_matrix,
            num_frames: visible_frames_len,
            num_bins,
        };
    }

    // Caso B: Si excede MAX_TEXTURE_SIZE, se realiza downsampling temporal por promedio de energía (RMS)
    let target_width = config.max_texture_width;
    let mut downsampled_matrix = vec![0.0; target_width * num_bins];
    let step = visible_frames_len as f64 / target_width as f64;

    for dest_f in 0..target_width {
        let src_start = (start as f64 + dest_f as f64 * step).floor() as usize;
        let src_end = (start as f64 + (dest_f + 1) as f64 * step).ceil() as usize;
        let src_end = src_end.min(end);
        let count = (src_end - src_start).max(1) as f32;

        let dest_offset = dest_f * num_bins;

        for k in 0..num_bins {
            let mut sum_sq = 0.0;
            for src_f in src_start..src_end {
                let val = stft.matrix[src_f * num_bins + k];
                sum_sq += val * val;
            }
            downsampled_matrix[dest_offset + k] = (sum_sq / count).sqrt().min(1.0);
        }
    }

    StftResult {
        matrix: downsampled_matrix,
        num_frames: target_width,
        num_bins,
    }
}

/// Exporta las muestras sanadas a un archivo WAV PCM usando `hound`
pub fn export_repaired_wav<P: AsRef<Path>>(
    path: P,
    samples: &[f32],
    sample_rate: u32,
    channels: u16,
    bit_depth: u16,
) -> Result<(), String> {
    let spec = hound::WavSpec {
        channels,
        sample_rate,
        bits_per_sample: bit_depth,
        sample_format: if bit_depth == 32 {
            hound::SampleFormat::Float
        } else {
            hound::SampleFormat::Int
        },
    };

    let mut writer = hound::WavWriter::create(path, spec)
        .map_err(|e| format!("No se pudo crear el archivo WAV: {}", e))?;

    match bit_depth {
        16 => {
            for &s in samples {
                let i16_val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                writer.write_sample(i16_val).map_err(|e| e.to_string())?;
            }
        }
        24 => {
            for &s in samples {
                let i32_val = (s.clamp(-1.0, 1.0) * 8388607.0) as i32;
                writer.write_sample(i32_val).map_err(|e| e.to_string())?;
            }
        }
        32 => {
            for &s in samples {
                writer.write_sample(s.clamp(-1.0, 1.0)).map_err(|e| e.to_string())?;
            }
        }
        _ => {
            for &s in samples {
                let i16_val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                writer.write_sample(i16_val).map_err(|e| e.to_string())?;
            }
        }
    }

    writer.finalize().map_err(|e| format!("Error finalizando el archivo WAV: {}", e))?;
    Ok(())
}

