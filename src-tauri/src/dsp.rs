//! Módulo DSP (Digital Signal Processing) de Vostok Restoration v1
//! 
//! Implementa la decodificación nativa con `symphonia`, la STFT paralela
//! con `realfft` (SIMD SOTA), el detector por primera derivada en tiempo lineal,
//! la interpolación Hermite cúbica in-place y el sub-muestreo espectral para WebGL.

use std::path::Path;
use serde::{Serialize, Deserialize};
use realfft::RealFftPlanner; // ✨ CORRECCIÓN: Eliminado import de Complex no utilizado
use rayon::prelude::*;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

pub use crate::vostok_dsp::types::*;
pub use crate::vostok_dsp::utils::*;

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

/// Extrae características multidimensionales de todos los frames alineados con la STFT
pub fn extract_features(
    audio: &AudioBuffer,
    stft: &StftResult,
    global_rms: f32,
) -> Vec<FrameFeatures> {
    let num_frames = stft.num_frames;
    let num_bins = stft.num_bins;
    let samples = &audio.samples;
    let sample_rate = audio.sample_rate as f32;
    let n_samples = samples.len();

    let fft_size = 4096;
    let hop_size = 1024;

    (0..num_frames)
        .into_par_iter()
        .map(|t| {
            let start_sample = t * hop_size;
            let end_sample = (start_sample + fft_size).min(n_samples);
            let frame_samples = &samples[start_sample..end_sample];
            let len = frame_samples.len() as f32;

            // --- Extracción Temporal ---
            let (sum_sq, abs_max, zero_crossings) = if !frame_samples.is_empty() {
                let mut sq = 0.0f32;
                let mut mx = 0.0f32;
                let mut zc = 0usize;
                
                for i in 0..frame_samples.len() {
                    let val = frame_samples[i];
                    sq += val * val;
                    let abs_val = val.abs();
                    if abs_val > mx {
                        mx = abs_val;
                    }
                    if i > 0 {
                        if (frame_samples[i] >= 0.0) != (frame_samples[i - 1] >= 0.0) {
                            zc += 1;
                        }
                    }
                }
                (sq, mx, zc)
            } else {
                (0.0, 0.0, 0)
            };

            let rms = (sum_sq / len.max(1.0)).sqrt().max(1e-9);
            let zero_crossing_rate = if len > 1.0 {
                zero_crossings as f32 / (len - 1.0)
            } else {
                0.0
            };
            let crest_factor = abs_max / rms;
            let z_score = (abs_max - global_rms) / global_rms;

            // --- Extracción Espectral ---
            let start_bin = t * num_bins;
            let end_bin = start_bin + num_bins;
            let mags = &stft.matrix[start_bin..end_bin];

            let (sum_mags, sum_weighted_mags, sum_ln_mags) = if !mags.is_empty() {
                let mut sum_m = 0.0f32;
                let mut sum_wm = 0.0f32;
                let mut sum_ln = 0.0f32;
                
                for k in 0..num_bins {
                    let mag = mags[k];
                    let freq = (k as f32) * (sample_rate / (2.0 * num_bins as f32));
                    sum_m += mag;
                    sum_wm += freq * mag;
                    sum_ln += (mag + 1e-7).ln();
                }
                (sum_m, sum_wm, sum_ln)
            } else {
                (0.0, 0.0, 0.0)
            };

            let spectral_centroid = if sum_mags > 1e-9 {
                sum_weighted_mags / sum_mags
            } else {
                0.0
            };

            let spectral_flatness = if sum_mags > 1e-9 {
                let geom_mean = (sum_ln_mags / num_bins as f32).exp();
                let arith_mean = sum_mags / num_bins as f32;
                (geom_mean / arith_mean.max(1e-9)).clamp(0.0, 1.0)
            } else {
                0.0
            };

            // Spectral Flux respecto al frame anterior
            let spectral_flux = if t > 0 {
                let prev_start_bin = (t - 1) * num_bins;
                let prev_mags = &stft.matrix[prev_start_bin..prev_start_bin + num_bins];
                let mut flux_sum = 0.0f32;
                for k in 0..num_bins {
                    let diff = mags[k] - prev_mags[k];
                    flux_sum += diff * diff;
                }
                flux_sum
            } else {
                0.0
            };

            let time_secs = start_sample as f32 / sample_rate;

            FrameFeatures {
                rms,
                zero_crossing_rate,
                crest_factor,
                z_score,
                spectral_centroid,
                spectral_flux,
                spectral_flatness,
                frame_index: t,
                time_secs,
            }
        })
        .collect()
}

/// Calcula los coeficientes LPC de orden P para un bloque de muestras in-place utilizando el stack.
/// Retorna `Some(stable_order)` con el orden máximo estable alcanzado (entre 1 y order), o `None` en silencio/error.
pub fn lpc_levinson_durbin_in_place(
    samples: &[f32],
    order: usize,
    out_coefs: &mut [f32],
) -> Option<usize> {
    let n = samples.len();
    if n <= order || order > 128 || out_coefs.len() < order {
        return None;
    }

    // Arrays fijos en el stack (0 heap allocation, soporte hasta orden 128)
    let mut r = [0.0f32; 129];
    let mut a = [0.0f32; 129];
    let mut a_next = [0.0f32; 129];

    // 1. Calcular coeficientes de autocorrelación R[0..=order]
    for l in 0..=order {
        let mut sum = 0.0f64;
        for i in 0..(n - l) {
            sum += (samples[i] as f64) * (samples[i + l] as f64);
        }
        r[l] = sum as f32;
    }

    if r[0] < 1e-9 {
        return None; // Bloque en silencio absoluto
    }

    // 2. Recursión algebraico-iterativa de Levinson-Durbin
    let mut e = r[0];
    a[0] = 1.0;
    let mut stable_order = 0;

    for i in 1..=order {
        let mut sum = 0.0f64;
        for j in 1..i {
            sum += (a[j] as f64) * (r[i - j] as f64);
        }
        
        let ki = (r[i] - sum as f32) / e.max(1e-9);
        
        // Comprobación de estabilidad del filtro predictor
        if ki.abs() >= 1.0 {
            break; // Retornamos el último orden estable
        }

        a[i] = ki;
        a_next[0..=i].copy_from_slice(&a[0..=i]);
        for j in 1..i {
            a_next[j] = a[j] - ki * a[i - j];
        }
        a[0..=i].copy_from_slice(&a_next[0..=i]);
        e *= 1.0 - ki * ki;
        stable_order = i;
        
        if e < 1e-9 {
            break;
        }
    }

    if stable_order == 0 {
        None
    } else {
        out_coefs[0..stable_order].copy_from_slice(&a[1..=stable_order]);
        Some(stable_order)
    }
}

/// Detector SOTA de clicks e impulsos usando el error residual de predicción lineal (LPC Autoregresivo)
pub fn detectar_clicks(
    _features: &[FrameFeatures],
    stft: &StftResult,
    samples: &[f32],
    sample_rate: u32,
    sensitivity: f32,
    audio_mode: AudioMode,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let n_samples = samples.len();
    let lpc_order = 16;
    let block_size = 2048;
    let hop_size = 1024;

    if n_samples < block_size {
        return events;
    }

    let std_multiplier = 14.0 - (sensitivity * 10.0);
    let min_absolute_delta = 0.04 - (sensitivity * 0.03); 
    let min_gap = 128.max((sample_rate as f32 * 0.008) as usize); 

    // Umbral de delta físico mínimo regulado por la sensibilidad
    let min_physical_delta = 0.03 - (sensitivity * 0.025); // 0.005 a 0.03

    let num_blocks = (n_samples - block_size) / hop_size + 1;
    let mut last_detected_sample = -(min_gap as isize);

    // Buffers reutilizados en stack y heap local para evitar allocations
    let mut residual = vec![0.0f32; block_size];
    let mut a_coefs = [0.0f32; 16];

    // Evaluamos bloque por bloque (solapados) para adaptación local del modelo AR
    for b in 0..num_blocks {
        let block_start = b * hop_size;
        let block_end = block_start + block_size;
        let block_samples = &samples[block_start..block_end];

        // --- INSERTA AQUÍ LA COMPUERTA DE ENERGÍA ---
        // Calculamos la energía RMS del bloque actual para validar si hay contenido
        let sum_sq: f32 = block_samples.iter().map(|s| s * s).sum();
        let rms = (sum_sq / block_size as f32).sqrt();

        // Si el RMS está por debajo de -80dB (0.0001), es ruido de cola/silencio.
        // Ignoramos este bloque para evitar falsos positivos.
        if rms < 0.0001 { 
            continue; 
        }
        // --------------------------------------------

        // Estimar coeficientes AR mediante Levinson-Durbin in-place
        if let Some(stable_order) = lpc_levinson_durbin_in_place(block_samples, lpc_order, &mut a_coefs) {
            // Limpiar únicamente la porción no calculada del residuo
            residual[0..stable_order].fill(0.0);

            // Calcular señal residual e[n] para el bloque
            let mut sum_sq_residual = 0.0f64;
            let mut count = 0;

            for n in stable_order..block_size {
                let mut pred = 0.0f32;
                for k in 0..stable_order {
                    pred += a_coefs[k] * block_samples[n - 1 - k];
                }
                let err = block_samples[n] - pred;
                residual[n] = err;
                sum_sq_residual += (err as f64) * (err as f64);
                count += 1;
            }

            if count == 0 {
                continue;
            }

            // Desviación estándar local del error de predicción (ruido de fondo residual)
            let std_dev_residual = (sum_sq_residual / count as f64).sqrt() as f32;
            let local_threshold = std_dev_residual * std_multiplier;

            // Escanear el residuo en busca de anomalías impulsivas
            for n in (stable_order + 1..block_size - 2).step_by(1) {
                let global_idx = block_start + n;
                if (global_idx as isize - last_detected_sample) <= min_gap as isize {
                    continue;
                }

                let val_err = residual[n].abs();
                // 1. ¿El error del predictor supera el umbral estadístico local?
                if val_err > local_threshold && val_err > min_absolute_delta {
                    let delta_physical = (block_samples[n] - block_samples[n - 1]).abs();

                    if delta_physical < min_physical_delta {
                        continue;
                    }

                    // --- [INSERCIÓN DE LA LÓGICA DE COHERENCIA DE FASE] ---
                    // Validación de cambio de dirección de la señal para filtrar 
                    // transitorios musicales (percusión/ataques armónicos)
                    let prev_diff = block_samples[n] - block_samples[n - 1];
                    let next_diff = block_samples[n + 1] - block_samples[n];
                    
                    // Si el signo no cambia, es una rampa (musical), no una discontinuidad (glitch)
                    if sensitivity > 0.9 && prev_diff.signum() == next_diff.signum() {
                        continue; 
                    }
                    // -----------------------------------------------------

                    // 2. FIRMA DE DIRAC (Pico Local Aislado):
                    // El error en el click debe ser masivamente mayor que en sus muestras vecinas inmediatas.
                    let err_prev = residual[n - 1].abs().max(1e-6);
                    let err_next = residual[n + 1].abs().max(1e-6);
                    let ratio_prev = val_err / err_prev;
                    let ratio_next = val_err / err_next;

                    let mut ratio_threshold = 4.0 - (sensitivity * 2.5);
                    if audio_mode == AudioMode::Voice {
                        // Relajar la exigencia de aislamiento en voz (sibilancia y fricativas tienen alto ruido de fondo)
                        ratio_threshold = ratio_threshold.min(1.2); 
                    }
                    if ratio_prev < ratio_threshold || ratio_next < ratio_threshold {
                        continue; // No es un click lo suficientemente aislado, es contenido musical
                    }

                    // 3. Discriminación de notas musicales (Ataques sostenidos de colita larga):
                    let val_err_next2 = residual[n + 2].abs();
                    let mut next2_threshold = 0.3 + (sensitivity * 0.5);
                    if audio_mode == AudioMode::Voice {
                        // Permitir más resonancia para ataques glotales masivos de vocales cortas
                        next2_threshold = next2_threshold.max(1.5);
                    }
                    if val_err_next2 > val_err * next2_threshold {
                        continue; // Energía sostenida, descartar click
                    }

                    // --- VALIDACIÓN HFER ---
                    let frame_idx = (global_idx / 1024).min(stft.num_frames - 1);
                    let k_low = ((2000.0 * 4096.0 / sample_rate as f32).round() as usize).min(stft.num_bins).max(21);
                    let k_high = ((4000.0 * 4096.0 / sample_rate as f32).round() as usize).min(stft.num_bins).max(22);
                    
                    let start_bin = frame_idx * stft.num_bins;
                    let mags = &stft.matrix[start_bin..start_bin + stft.num_bins];
                    let energy_low: f32 = mags[20..k_low].iter().sum();
                    let energy_high: f32 = mags[k_high..stft.num_bins].iter().sum();
                    let hfer = energy_high / energy_low.max(1e-6);

                    // Calcular HFER promedio de los vecinos alejados para evitar auto-filtración por solapamiento
                    let mut neighbor_hfer_sum = 0.0f32;
                    let mut neighbor_count = 0.0f32;
                    for &offset in &[-5, -4, 4, 5] {
                        let n_idx = (frame_idx as isize + offset) as usize;
                        if n_idx < stft.num_frames {
                            let n_start = n_idx * stft.num_bins;
                            let n_mags = &stft.matrix[n_start..n_start + stft.num_bins];
                            let n_low: f32 = n_mags[20..k_low].iter().sum();
                            let n_high: f32 = n_mags[k_high..stft.num_bins].iter().sum();
                            neighbor_hfer_sum += n_high / n_low.max(1e-6);
                            neighbor_count += 1.0;
                        }
                    }
                    let avg_neighbor_hfer = if neighbor_count > 0.0 { neighbor_hfer_sum / neighbor_count } else { 0.0 };

                    let min_hfer = 0.08 - (sensitivity * 0.06);
                    let hfer_neighbor_factor = 3.0 - (sensitivity * 2.2);

                    let is_hfer_valid = hfer > min_hfer && (
                        hfer >= 0.15 || // Evitar descarte por vecinos si hay alto contenido de HF absoluto
                        val_err > local_threshold * 4.0 || // Evitar descarte si el error es masivo
                        avg_neighbor_hfer == 0.0 ||
                        hfer >= avg_neighbor_hfer * hfer_neighbor_factor
                    );

                    if !is_hfer_valid {
                        continue;
                    }

                    // Calcular la duración real del transitorio de forma aisalda a la sensibilidad
                    let mut transient_duration = 1;
                    let mut k = n + 1;
                    let peak_error = val_err; // Capturamos la magnitud exacta del pico actual
                    
                    // Medimos cuántos samples toma caer al 10% de su propia altura máxima
                    while k < block_size - 2 && residual[k].abs() > peak_error * 0.1 {
                        transient_duration += 1;
                        k += 1;
                    }

                    // Si el transitorio dura más de 12 muestras, es un ataque musical o sibilante continuo, no un click
                    if transient_duration > 12 {
                        continue;
                    }

                    // --- NUEVA VERIFICACIÓN DE FIRMA FÍSICA (BÚSQUEDA DE PICO Y DECAIMIENTO ADAPTATIVA) ---
                    let entry_change = block_samples[n] - block_samples[n - 1];
                    let entry_sign = entry_change.signum();
                    
                    let search_limit = if sensitivity > 0.8 { 3 } else { 1 };
                    
                    if search_limit == 1 {
                        // Caso estricto: decaimiento inmediato
                        let exit_change = block_samples[n + transient_duration] - block_samples[n + transient_duration - 1];
                        if entry_change.signum() == exit_change.signum() {
                            continue;
                        }
                    } else {
                        // Caso relajado: buscar pico en ventana y verificar decaimiento posterior
                        let actual_limit = search_limit.min(block_size - 1 - n);
                        let mut peak_offset = 0;
                        let mut peak_val = block_samples[n];
                        for offset in 1..=actual_limit {
                            let val = block_samples[n + offset];
                            if entry_sign > 0.0 {
                                if val > peak_val {
                                    peak_val = val;
                                    peak_offset = offset;
                                }
                            } else {
                                if val < peak_val {
                                    peak_val = val;
                                    peak_offset = offset;
                                }
                            }
                        }

                        // Si el pico está al final de la ventana de búsqueda, es un transitorio lento (musical)
                        if peak_offset == actual_limit {
                            continue;
                        }
                    }

                    // --- [INSERCIÓN SOTA: FILTRO DE COHERENCIA Y PUREZA ESPECTRAL] ---
                    
                    // 1. FILTRO DE COHERENCIA DE FASE
                    // Validamos que el transitorio rompa la dirección de la onda (incoherente)
                    let entry_dir = (block_samples[n] - block_samples[n - 1]).signum();
                    let next_dir = (block_samples[n + 1] - block_samples[n]).signum();
                    
                    let mut is_coherent = entry_dir == next_dir;
                    // Si es Voz y el error LPC es MASIVO, ignoramos la coherencia aparente (ataque glotal)
                    if audio_mode == AudioMode::Voice && is_coherent && residual[n].abs() > local_threshold * 4.0 {
                        is_coherent = false;
                    }
                    
                    if sensitivity < 0.9 && is_coherent {
                        continue; // Es un transitorio musical armónico (coherente), descartar.
                    }

                    // 2. VALIDACIÓN DE PUREZA ESPECTRAL (STFT)
                    // Confirmamos que la energía sea de banda ancha (ruido blanco = glitch)
                    let frame_idx = (global_idx / 1024).min(stft.num_frames - 1);
                    let k_high = ((4000.0 * 4096.0 / sample_rate as f32).round() as usize).min(stft.num_bins).max(22);
                    
                    let start_bin = frame_idx * stft.num_bins;
                    let mags = &stft.matrix[start_bin..start_bin + stft.num_bins];
                    let high_freq_energy: f32 = mags[k_high..stft.num_bins].iter().sum();
                    let total_energy: f32 = mags[20..stft.num_bins].iter().sum();
                    let spectral_whiteness = high_freq_energy / total_energy.max(1e-6);

                    // Si es alta sensibilidad, exigimos blancura espectral para confirmar
                    if audio_mode == AudioMode::Voice {
                        if sensitivity > 0.8 && spectral_whiteness < 0.15 {
                            continue; // Descartar coloreados no sibilantes
                        }
                        // Si la blancura es alta (> 0.25), podría ser sibilancia (/s/).
                        // Exigimos que coexista con un error LPC masivo para confirmarlo como click.
                        if spectral_whiteness >= 0.25 && residual[n].abs() < local_threshold * 4.0 {
                            continue; // Descartar porque probablemente es sibilancia
                        }
                    } else {
                        if sensitivity > 0.8 && spectral_whiteness < 0.25 {
                            continue; // Es percusión coloreada, descartar.
                        }
                    }

                    // --- [NUEVO SISTEMA DE SCORE DE CONFIANZA SOTA] ---
                    // Acumulamos evidencia de que esto es un glitch real
                    let mut confidence_score = 0.0f32;
                    
                    // 1. Evidencia estadística (LPC)
                    if val_err > local_threshold * 2.0 { confidence_score += 0.4; }
                    
                    // 2. Evidencia espectral (Ruido blanco)
                    if spectral_whiteness > 0.3 { confidence_score += 0.3; }
                    
                    // 3. Evidencia de fase (Discontinuidad)
                    if entry_dir != next_dir { confidence_score += 0.3; }

                    // Solo reportamos si el score es >= 0.7
                    if confidence_score < 0.7 {
                        continue; 
                    }
                    // ----------------------------------------------------

                    // Confirmar click / pop según la duración
                    let is_click = transient_duration < 6;

                    events.push(GlitchEvent {
                        sample_index: global_idx,
                        time_secs: global_idx as f64 / sample_rate as f64,
                        amplitude_delta: delta_physical,
                        direction: if block_samples[n] > block_samples[n - 1] { 1 } else { -1 },
                        event_type: if is_click { GlitchType::Click } else { GlitchType::Pop },
                        repaired: false,
                        frequency: None,
                        channel: 0,
                        duration_samples: Some(transient_duration),
                    });

                    last_detected_sample = global_idx as isize;
                }
            }
        }
    }

    events
}

/// Detector de Pops & Low Thumps (Bajas Frecuencias < 150 Hz)
pub fn detectar_pops(
    features: &[FrameFeatures],
    stft: &StftResult,
    sample_rate: u32,
    global_rms: f32,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let num_frames = stft.num_frames;
    let num_bins = stft.num_bins;
    let hop_size = 1024;
    
    // 150 Hz bin boundary
    let k_150 = ((150.0 * 4096.0 / sample_rate as f32).round() as usize).min(num_bins).max(2);
    
    let mut inside_pop = false;
    let mut start_frame = 0;
    
    for t in 0..num_frames {
        let start_bin = t * num_bins;
        let mags = &stft.matrix[start_bin..start_bin + num_bins];
        
        let total_energy: f32 = mags.iter().sum();
        let low_energy: f32 = mags[0..k_150].iter().sum();
        
        let is_low_energy_dominant = total_energy > 1e-6 && (low_energy / total_energy) > 0.8;
        let has_high_crest = features[t].crest_factor > 5.0;
        let has_high_rms = features[t].rms > global_rms * 3.0;
        
        if is_low_energy_dominant && has_high_crest && has_high_rms {
            if !inside_pop {
                inside_pop = true;
                start_frame = t;
            }
        } else {
            if inside_pop {
                inside_pop = false;
                let start_sample = start_frame * hop_size;
                events.push(GlitchEvent {
                    sample_index: start_sample,
                    time_secs: start_sample as f64 / sample_rate as f64,
                    amplitude_delta: features[start_frame].rms,
                    direction: 0,
                    event_type: GlitchType::Pop,
                    repaired: false,
                    frequency: Some(75.0),
                    channel: 0,
                    duration_samples: Some((t - start_frame) * hop_size),
                });
            }
        }
    }
    
    if inside_pop {
        let start_sample = start_frame * hop_size;
        events.push(GlitchEvent {
            sample_index: start_sample,
            time_secs: start_sample as f64 / sample_rate as f64,
            amplitude_delta: features[start_frame].rms,
            direction: 0,
            event_type: GlitchType::Pop,
            repaired: false,
            frequency: Some(75.0),
            channel: 0,
            duration_samples: Some((num_frames - start_frame) * hop_size),
        });
    }
    
    events
}

/// Detector de Clipping (Recorte / Saturación Digital)
pub fn detectar_clipping(
    samples: &[f32],
    sample_rate: u32,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let n = samples.len();
    let limit = 0.99f32;
    let tolerance = 1e-4f32;
    
    let mut i = 0;
    while i < n {
        let val = samples[i].abs();
        if val >= limit {
            let mut j = i + 1;
            while j < n && samples[j].abs() >= limit && (samples[j].abs() - val).abs() <= tolerance {
                j += 1;
            }
            
            let count = j - i;
            if count > 3 {
                events.push(GlitchEvent {
                    sample_index: i,
                    time_secs: i as f64 / sample_rate as f64,
                    amplitude_delta: val,
                    direction: if samples[i] > 0.0 { 1 } else { -1 },
                    event_type: GlitchType::Distortion,
                    repaired: false,
                    frequency: None,
                    channel: 0,
                    duration_samples: Some(count),
                });
                i = j;
                continue;
            }
        }
        i += 1;
    }
    
    events
}

/// Detector de caídas de señal/dropouts (Dominio Temporal)
pub fn detectar_dropouts(
    features: &[FrameFeatures],
    samples: &[f32],
    sample_rate: u32,
    sensitivity: f32,
    global_rms: f32,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let n_samples = samples.len();
    let num_frames = features.len();
    if num_frames < 15 {
        return events;
    }

    let hop_size = 1024;
    let fft_size = 4096;
    let window_frames = 10; // Ventana de promedio móvil (aprox 210ms)
    
    // Umbral de caída relativa en base a la sensibilidad (e.g. del 15% al 50% del promedio móvil)
    let drop_ratio_threshold = 0.15 + (sensitivity * 0.35);
    let mut inside_dropout = false;
    let mut start_idx = 0;

    for t in window_frames..num_frames {
        let feat = &features[t];
        
        // Calcular promedio móvil de RMS de las últimas `window_frames` tramas
        let avg_rms = {
            let sum: f32 = (1..=window_frames).map(|i| features[t - i].rms).sum();
            sum / window_frames as f32
        }.max(1e-6);

        // Para evitar falsos positivos en silencios o pasajes ya muy tenues
        let is_active_region = avg_rms > global_rms * 0.15 && avg_rms > 0.003;

        // Umbral absoluto de caída profunda a -90dBFS (~3.162e-5 de amplitud RMS)
        let threshold_90db = 10.0f32.powf(-90.0 / 20.0);

        // Condición de caída abrupta y baja energía profunda (cercana a -90dBFS)
        let is_dropout_frame = is_active_region && 
                               feat.rms < threshold_90db &&
                               feat.rms < avg_rms * drop_ratio_threshold && 
                               feat.zero_crossing_rate < 0.2;

        if is_dropout_frame {
            if !inside_dropout {
                inside_dropout = true;
                start_idx = t * hop_size;
            }
        } else {
            if inside_dropout {
                inside_dropout = false;
                let end_frame = t;
                let end_idx = (end_frame * hop_size + fft_size).min(n_samples);
                let duration_samples = end_idx - start_idx;
                let duration_ms = (duration_samples as f32 * 1000.0) / sample_rate as f32;

                // Calibración para voces: Un dropout es una interrupción temporal que debe
                // recuperarse. Si la duración es mayor a 250ms, se considera una pausa de voz o frase,
                // no un dropout físico o glitch de señal.
                if duration_ms >= 20.0 && duration_ms <= 250.0 {
                    events.push(GlitchEvent {
                        sample_index: start_idx,
                        time_secs: start_idx as f64 / sample_rate as f64,
                        amplitude_delta: avg_rms - feat.rms,
                        direction: -1,
                        event_type: GlitchType::Dropout,
                        repaired: false,
                        frequency: None,
                        channel: 0,
                        duration_samples: Some(duration_samples),
                    });
                }
            }
        }
    }

    // Eliminado el bloque de cierre al final del archivo: si el silencio llega al final,
    // significa que no hubo recuperación de señal, por ende es un silencio legítimo o fade-out.

    events
}

/// Detector de Hum electromagnético (50/60 Hz + Armónicos en Dominio Espectral)
pub fn detectar_hum(
    _features: &[FrameFeatures],
    stft: &StftResult,
    sample_rate: u32,
    sensitivity: f32,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let num_frames = stft.num_frames;
    let num_bins = stft.num_bins;
    let fft_size = 4096;

    // Frecuencias objetivo
    let target_frequencies = [50.0f32, 60.0f32, 100.0f32, 120.0f32, 150.0f32, 180.0f32];
    let mut hum_bins = Vec::new();

    for &freq in &target_frequencies {
        let bin = (freq * fft_size as f32 / sample_rate as f32).round() as usize;
        if bin < num_bins {
            hum_bins.push((freq, bin));
        }
    }

    // Un pico se define en relación con el espectro circundante.
    // El umbral se reduce a un rango de 1.2x a 2.0x. Incluso con baja sensibilidad (0%),
    // el Hum continuo se detecta gracias a la protección del filtro de duración (1.5 segundos).
    let peak_threshold = 2.0 - (sensitivity * 0.8);

    let mut frame_hum_freq = vec![None; num_frames];

    for t in 0..num_frames {
        let start_bin = t * num_bins;
        let mags = &stft.matrix[start_bin..start_bin + num_bins];
        
        let mut freq_found = None;
        for &(freq, bin) in &hum_bins {
            if bin > 3 && bin < num_bins - 4 {
                // Magnitud del bin evaluado
                let val = mags[bin];
                
                // Promedio de vecinos excluyendo la vecindad de fuga espectral inmediata (bin - 1 y bin + 1)
                let neighbors_avg = (mags[bin - 3] + mags[bin - 2] + mags[bin + 2] + mags[bin + 3]) * 0.25;
                
                if val > neighbors_avg * peak_threshold && val > 0.001 {
                    freq_found = Some(freq);
                    break;
                }
            }
        }
        frame_hum_freq[t] = freq_found;
    }

    // Agrupamos frames continuos con Hum detectado para crear eventos de rango temporal
    let hop_size = 1024;
    let mut inside_hum = false;
    let mut start_frame = 0;
    let mut gap_counter = 0;
    let gap_tolerance = 120; // Tolerar hasta ~2.5 segundos de silencio/enmascaramiento de Hum para consolidar
    let mut current_freq = None;

    for t in 0..num_frames {
        if let Some(f) = frame_hum_freq[t] {
            if !inside_hum {
                inside_hum = true;
                start_frame = t;
                current_freq = Some(f);
            }
            gap_counter = 0; // Resetear contador de huecos
        } else {
            if inside_hum {
                gap_counter += 1;
                if gap_counter > gap_tolerance {
                    // Si superamos la tolerancia, cerramos el evento
                    inside_hum = false;
                    let duration_frames = (t - gap_counter) - start_frame + 1;
                    // Hum estacionario real debe durar al menos 1.5 segundos (~70 frames)
                    // para discriminar notas de paso de instrumentos musicales
                    if duration_frames >= 70 {
                        let start_sample = start_frame * hop_size;
                        events.push(GlitchEvent {
                            sample_index: start_sample,
                            time_secs: start_sample as f64 / sample_rate as f64,
                            amplitude_delta: 0.1,
                            direction: 0,
                            event_type: GlitchType::Hum,
                            repaired: false,
                            frequency: current_freq,
                            channel: 0,
                            duration_samples: Some(duration_frames * hop_size),
                        });
                    }
                }
            }
        }
    }

    // Asegurar la inserción si el Hum llega al final del archivo
    if inside_hum {
        let actual_end = num_frames.saturating_sub(gap_counter);
        if actual_end > start_frame {
            let duration_frames = actual_end - start_frame;
            if duration_frames >= 70 {
                let start_sample = start_frame * hop_size;
                events.push(GlitchEvent {
                    sample_index: start_sample,
                    time_secs: start_sample as f64 / sample_rate as f64,
                    amplitude_delta: 0.1,
                    direction: 0,
                    event_type: GlitchType::Hum,
                    repaired: false,
                    frequency: current_freq,
                    channel: 0,
                    duration_samples: Some(duration_frames * hop_size),
                });
            }
        }
    }

    events
}

/// Detector de Hiss/Soplido de alta frecuencia (Dominio Espectral)
pub fn detectar_hiss(
    features: &[FrameFeatures],
    stft: &StftResult,
    sample_rate: u32,
    sensitivity: f32,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let num_frames = stft.num_frames;
    let num_bins = stft.num_bins;
    let hop_size = 1024;

    // El Hiss usualmente es ruido plano (flatness alta) en altas frecuencias.
    // El umbral de planitud se reduce a un rango de 0.30 a 0.45 para mayor sensibilidad al siseo suave.
    let flatness_threshold = 0.45 - (sensitivity * 0.15);
    let high_freq_start = 5000.0f32;
    let fft_size = 4096;
    let start_bin = (high_freq_start * fft_size as f32 / sample_rate as f32).round() as usize;

    if start_bin >= num_bins {
        return events;
    }

    let mut frame_hiss_detected = vec![false; num_frames];

    for t in 0..num_frames {
        let feat = &features[t];
        let mags_start = t * num_bins;
        let high_mags = &stft.matrix[mags_start + start_bin..mags_start + num_bins];
        
        // Calcular flatness solo de la porción de alta frecuencia
        let (sum_m, sum_ln) = if !high_mags.is_empty() {
            let mut sm = 0.0f32;
            let mut sln = 0.0f32;
            for &mag in high_mags {
                sm += mag;
                sln += (mag + 1e-7).ln();
            }
            (sm, sln)
        } else {
            (0.0, 0.0)
        };

        let local_flatness = if sum_m > 1e-9 && !high_mags.is_empty() {
            let count = high_mags.len() as f32;
            let geom_mean = (sum_ln / count).exp();
            let arith_mean = sum_m / count;
            geom_mean / arith_mean.max(1e-9)
        } else {
            0.0
        };

        // Si es bastante plano y tiene energía audible
        if feat.spectral_flatness > flatness_threshold && local_flatness > flatness_threshold && feat.rms > 0.01 {
            frame_hiss_detected[t] = true;
        }
    }

    let mut inside_hiss = false;
    let mut start_frame = 0;
    let mut gap_counter = 0;
    let gap_tolerance = 150; // Hiss tolera hasta ~3.2 segundos de enmascaramiento para consolidar el siseo constante

    for t in 0..num_frames {
        if frame_hiss_detected[t] {
            if !inside_hiss {
                inside_hiss = true;
                start_frame = t;
            }
            gap_counter = 0;
        } else {
            if inside_hiss {
                gap_counter += 1;
                if gap_counter > gap_tolerance {
                    inside_hiss = false;
                    let duration_frames = (t - gap_counter) - start_frame + 1;
                    // Hiss continuo de soplido de cinta debe durar al menos 2.0 segundos (~90 frames)
                    // para discriminar sibilancias y platillos de batería transitorios
                    if duration_frames >= 90 {
                        let start_sample = start_frame * hop_size;
                        events.push(GlitchEvent {
                            sample_index: start_sample,
                            time_secs: start_sample as f64 / sample_rate as f64,
                            amplitude_delta: 0.05,
                            direction: 0,
                            event_type: GlitchType::Hiss,
                            repaired: false,
                            frequency: Some(8000.0), // Frecuencia representativa para Hiss constante
                            channel: 0,
                            duration_samples: Some(duration_frames * hop_size),
                        });
                    }
                }
            }
        }
    }

    // Asegurar la inserción si el Hiss llega al final del archivo
    if inside_hiss {
        let actual_end = num_frames.saturating_sub(gap_counter);
        if actual_end > start_frame {
            let duration_frames = actual_end - start_frame;
            if duration_frames >= 90 {
                let start_sample = start_frame * hop_size;
                events.push(GlitchEvent {
                    sample_index: start_sample,
                    time_secs: start_sample as f64 / sample_rate as f64,
                    amplitude_delta: 0.05,
                    direction: 0,
                    event_type: GlitchType::Hiss,
                    repaired: false,
                    frequency: Some(8000.0),
                    channel: 0,
                    duration_samples: Some(duration_frames * hop_size),
                });
            }
        }
    }

    events
}

/// Ejecutor mono que analiza un único canal
pub fn ejecutar_analisis_dsp_mono(
    audio: &AudioBuffer,
    stft: &StftResult,
    params: &ScanParams,
    channel: u16,
) -> Vec<GlitchEvent> {
    // 1. Calcular RMS global una sola vez para este canal
    let global_rms = {
        let sum_sq: f64 = audio.samples.iter().map(|&s| (s as f64) * (s as f64)).sum();
        ((sum_sq / audio.samples.len() as f64).sqrt()) as f32
    }.max(0.0001);

    // 2. Extraer features pasando el global_rms
    let features = extract_features(audio, stft, global_rms);

    // 3. Ejecutar detectores en paralelo
    let (mut clicks, (mut dropouts, (mut hum, (mut hiss, mut clipping)))) = rayon::join(
        || {
            if params.clicks {
                let mode = params.audio_mode.clone().unwrap_or(AudioMode::Music);
                let mut c = detectar_clicks(&features, stft, &audio.samples, audio.sample_rate, params.sensitivity, mode);
                let mut p = detectar_pops(&features, stft, audio.sample_rate, global_rms);
                c.append(&mut p);
                c
            } else {
                Vec::new()
            }
        },
        || {
            rayon::join(
                || {
                    if params.dropouts {
                        detectar_dropouts(&features, &audio.samples, audio.sample_rate, params.sensitivity, global_rms)
                    } else {
                        Vec::new()
                    }
                },
                || {
                    rayon::join(
                        || {
                            if params.hum {
                                detectar_hum(&features, stft, audio.sample_rate, params.sensitivity)
                            } else {
                                Vec::new()
                            }
                        },
                        || {
                            rayon::join(
                                || {
                                    if params.hiss {
                                        detectar_hiss(&features, stft, audio.sample_rate, params.sensitivity)
                                    } else {
                                        Vec::new()
                                    }
                                },
                                || {
                                    if params.distortion {
                                        detectar_clipping(&audio.samples, audio.sample_rate)
                                    } else {
                                        Vec::new()
                                    }
                                }
                            )
                        }
                    )
                }
            )
        }
    );

    // 3. Unificar y asignar canal
    let mut todos = Vec::new();
    todos.append(&mut clicks);
    todos.append(&mut dropouts);
    todos.append(&mut hum);
    todos.append(&mut hiss);
    todos.append(&mut clipping);

    for event in &mut todos {
        event.channel = channel;
    }

    todos.sort_by(|a, b| a.time_secs.partial_cmp(&b.time_secs).unwrap());
    consolidar_y_correlacionar_contextualmente(todos)
}

/// Realiza la consolidación y correlación de eventos de múltiples detectores (Dominio Contextual).
/// Filtra falsos positivos causados por interacciones entre fenómenos físicos, por ejemplo:
///   1. Clicks/Pops espurios en los flancos de transitorios de Dropouts (flancos de subida/caída).
///   2. Clicks/Pops redundantes en zonas saturadas (Distortion/Clipping) cuando el detector de distorsión está activo.
pub fn consolidar_y_correlacionar_contextualmente(
    mut events: Vec<GlitchEvent>,
) -> Vec<GlitchEvent> {
    // 1. Extraer intervalos de dropouts y distorsión (clipping)
    let mut dropouts = Vec::new();
    let mut distortions = Vec::new();

    for event in &events {
        match event.event_type {
            GlitchType::Dropout => {
                let start = event.sample_index;
                let duration = event.duration_samples.unwrap_or(0);
                dropouts.push((start, start + duration));
            }
            GlitchType::Distortion => {
                let start = event.sample_index;
                let duration = event.duration_samples.unwrap_or(0);
                distortions.push((start, start + duration));
            }
            _ => {}
        }
    }

    // Si no hay dropouts ni distorsiones, no es necesario filtrar nada
    if dropouts.is_empty() && distortions.is_empty() {
        return events;
    }

    // Ventana de tolerancia al flanco de un dropout (2048 muestras es aprox 46ms a 44.1kHz)
    let margin = 2048;

    events.retain(|event| {
        if event.event_type == GlitchType::Click || event.event_type == GlitchType::Pop {
            let idx = event.sample_index;

            // Regla A: Eliminar clicks/pops que ocurren en los bordes inmediatos de un Dropout (transitorios del flanco)
            for &(drop_start, drop_end) in &dropouts {
                let near_start = idx >= drop_start.saturating_sub(margin) && idx <= drop_start + margin;
                let near_end = idx >= drop_end.saturating_sub(margin) && idx <= drop_end + margin;
                if near_start || near_end {
                    println!(
                        "[DSP CONTEXT] Filtrado Click/Pop en muestra {} por cercanía al flanco de Dropout [{} - {}]",
                        idx, drop_start, drop_end
                    );
                    return false;
                }
            }

            // Regla B: Eliminar clicks/pops que coinciden en el interior de una zona de Distorsión (clipping)
            // porque el evento principal es la saturación digital.
            for &(dist_start, dist_end) in &distortions {
                if idx >= dist_start && idx <= dist_end {
                    println!(
                        "[DSP CONTEXT] Filtrado Click/Pop redundante en muestra {} por solapamiento con Distorsión [{} - {}]",
                        idx, dist_start, dist_end
                    );
                    return false;
                }
            }
        }
        true
    });

    events
}


fn consolidar_canales_glitches(events: Vec<GlitchEvent>) -> Vec<GlitchEvent> {
    if events.is_empty() {
        return events;
    }

    let mut merged: Vec<GlitchEvent> = Vec::new();
    let mut consumed = vec![false; events.len()];

    for i in 0..events.len() {
        if consumed[i] {
            continue;
        }

        let mut current = events[i].clone();

        // Umbral de tiempo para consolidar según el tipo de anomalía:
        // Clicks, pops, dropouts, slips, distorsión son transitorios (50ms).
        // Hum e Hiss son ruidos estacionarios/continuos (250ms).
        let threshold = match current.event_type {
            GlitchType::Hum | GlitchType::Hiss => 0.25,
            _ => 0.05,
        };

        let mut found_match_idx = None;
        for j in (i + 1)..events.len() {
            if consumed[j] {
                continue;
            }
            let other = &events[j];
            if other.event_type == current.event_type
                && other.channel != current.channel
                && (other.time_secs - current.time_secs).abs() < threshold
            {
                found_match_idx = Some(j);
                break;
            }
        }

        if let Some(j) = found_match_idx {
            consumed[j] = true;
            let other = &events[j];

            let start_sample = current.sample_index.min(other.sample_index);
            let current_end = current.sample_index + current.duration_samples.unwrap_or(0);
            let other_end = other.sample_index + other.duration_samples.unwrap_or(0);
            let end_sample = current_end.max(other_end);

            current.sample_index = start_sample;
            current.time_secs = current.time_secs.min(other.time_secs);
            current.duration_samples = Some(end_sample.saturating_sub(start_sample));
            current.amplitude_delta = current.amplitude_delta.max(other.amplitude_delta);
            current.channel = 2; // Ambos
            if current.frequency.is_none() {
                current.frequency = other.frequency;
            }
        }

        merged.push(current);
    }

    merged
}

/// Orquestador paralelo que ejecuta todos los detectores habilitados (soporta Stereo Real)
pub fn ejecutar_analisis_dsp(
    audio: &AudioBuffer,
    stft: &StftResult,
    params: &ScanParams,
) -> Vec<GlitchEvent> {
    let n_channels = audio.channels as usize;
    if n_channels == 1 {
        ejecutar_analisis_dsp_mono(audio, stft, params, 0)
    } else {
        let mut all_events = (0..n_channels)
            .into_par_iter()
            .map(|c| {
                // De-interleave channel c
                let chan_samples: Vec<f32> = audio.samples.iter().skip(c).step_by(n_channels).cloned().collect();
                let chan_audio = AudioBuffer {
                    samples: chan_samples,
                    sample_rate: audio.sample_rate,
                    channels: 1,
                    bit_depth: audio.bit_depth,
                    duration_seconds: audio.duration_seconds,
                };
                // Compute a channel-specific STFT for the detector features
                let chan_stft = compute_stft(&chan_audio.samples, 4096, 1024, "blackman-harris").unwrap();
                ejecutar_analisis_dsp_mono(&chan_audio, &chan_stft, params, c as u16)
            })
            .flatten()
            .collect::<Vec<GlitchEvent>>();
        all_events.sort_by(|a, b| a.time_secs.partial_cmp(&b.time_secs).unwrap());
        consolidar_canales_glitches(all_events)
    }
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

/// Decodifica un archivo de audio WAV, MP3 o FLAC a Float32 nativo usando `symphonia`
pub fn decode_audio_file<P: AsRef<Path>>(path: P) -> Result<AudioBuffer, String> {
    let file = std::fs::File::open(path).map_err(|e| e.to_string())?;
    
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let hint = Hint::new();
    
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .map_err(|e| format!("Error de contenedor: {}", e))?;
        
    let mut format = probed.format;
    
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
        
        match decoded {
            AudioBufferRef::F32(buf) => {
                if buf.frames() > 0 {
                    let num_chans = channels as usize;
                    samples.reserve(buf.frames() * num_chans);
                    for i in 0..buf.frames() {
                        for c in 0..num_chans {
                            samples.push(buf.chan(c)[i]);
                        }
                    }
                }
            }
            AudioBufferRef::S16(buf) => {
                if buf.frames() > 0 {
                    let scale = 1.0 / 32768.0;
                    let num_chans = channels as usize;
                    samples.reserve(buf.frames() * num_chans);
                    for i in 0..buf.frames() {
                        for c in 0..num_chans {
                            samples.push(buf.chan(c)[i] as f32 * scale);
                        }
                    }
                }
            }
            AudioBufferRef::S32(buf) => {
                if buf.frames() > 0 {
                    let scale = 1.0 / 2147483648.0;
                    let num_chans = channels as usize;
                    samples.reserve(buf.frames() * num_chans);
                    for i in 0..buf.frames() {
                        for c in 0..num_chans {
                            samples.push(buf.chan(c)[i] as f32 * scale);
                        }
                    }
                }
            }
            AudioBufferRef::S24(buf) => {
                if buf.frames() > 0 {
                    let scale = 1.0 / 8388608.0;
                    let num_chans = channels as usize;
                    samples.reserve(buf.frames() * num_chans);
                    for i in 0..buf.frames() {
                        for c in 0..num_chans {
                            samples.push(buf.chan(c)[i].inner() as f32 * scale);
                        }
                    }
                }
            }
            _ => {
                return Err("Formato de buffer no soportado directamente.".to_string());
            }
        }
    }
    
    let total_samples = samples.len();
    let duration_seconds = (total_samples / channels as usize) as f64 / sample_rate as f64;
    
    Ok(AudioBuffer {
        samples,
        sample_rate,
        channels,
        bit_depth,
        duration_seconds,
    })
}

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
    } else { // Hann window
        for i in 0..fft_size {
            window[i] = 0.5 * (1.0 - (pi2 * i as f32 / (fft_size - 1) as f32).cos());
        }
    }
    window
}

/// Calcula la STFT usando `realfft` (SIMD SOTA) con frames paralelos via `rayon`.
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
    let window = build_window(fft_size, window_type);

    let mut planner = RealFftPlanner::<f32>::new();
    // ✨ CORRECCIÓN CRÍTICA: plan_fft_forward ya devuelve un Arc nativo. Eliminado Arc::from redundante.
    let r2c = planner.plan_fft_forward(fft_size);

    let window_sum: f32 = window.iter().sum();
    let norm = 1.0 / window_sum.max(1e-9);

    // [OPTIMIZACIÓN ZERO-ALLOCATION]: Pre-asignar plantillas de buffer para reutilizar en hilos de Rayon.
    let input_tpl = r2c.make_input_vec();
    let complex_tpl = r2c.make_output_vec();

    matrix
        .par_chunks_mut(num_bins)
        .enumerate()
        .for_each_with((input_tpl, complex_tpl), |(real_input, complex_output), (f, frame_slice)| {
            let offset = f * hop_size;
            
            // Aplicar ventana a las muestras de entrada reales
            for i in 0..fft_size {
                real_input[i] = samples[offset + i] * window[i];
            }

            // Procesar la FFT de real a complejo, reutilizando los buffers
            r2c.process(real_input, complex_output).unwrap();

            // Calcular magnitud del espectro complejo
            for k in 0..num_bins {
                let mag = complex_output[k].norm() * norm;
                frame_slice[k] = mag;
            }
        });

    Ok(StftResult { matrix, num_frames, num_bins })
}

/// Calcula la STFT multicanal, mezclando/promediando las magnitudes si hay más de 1 canal.
pub fn compute_stft_multichannel(
    samples: &[f32],
    channels: u16,
    fft_size: usize,
    hop_size: usize,
    window_type: &str,
) -> Result<StftResult, String> {
    let n_channels = channels as usize;
    if n_channels == 1 {
        compute_stft(samples, fft_size, hop_size, window_type)
    } else {
        // De-interleave each channel
        let mut channel_stfts = Vec::with_capacity(n_channels);
        for c in 0..n_channels {
            let chan_samples: Vec<f32> = samples.iter().skip(c).step_by(n_channels).cloned().collect();
            let stft = compute_stft(&chan_samples, fft_size, hop_size, window_type)?;
            channel_stfts.push(stft);
        }

        // Combine by taking the maximum magnitude across all channels
        let num_elements = channel_stfts[0].matrix.len();
        let mut combined_matrix = vec![0.0f32; num_elements];
        for i in 0..num_elements {
            let mut max_val = 0.0f32;
            for stft in &channel_stfts {
                max_val = max_val.max(stft.matrix[i]);
            }
            combined_matrix[i] = max_val;
        }

        Ok(StftResult {
            matrix: combined_matrix,
            num_frames: channel_stfts[0].num_frames,
            num_bins: channel_stfts[0].num_bins,
        })
    }
}

/// Serializa un `StftResult` a bytes compactos para transferencia IPC.
/// Formato: [frames: u32 LE][bins: u32 LE][audio_version: u64 LE][matrix: u8 × frames×bins]
pub fn stft_to_binary(stft: &StftResult, audio_version: u64) -> Vec<u8> {
    let payload = stft.num_frames * stft.num_bins;
    let mut buf = Vec::with_capacity(8 + 8 + payload);
    buf.extend_from_slice(&(stft.num_frames as u32).to_le_bytes());
    buf.extend_from_slice(&(stft.num_bins   as u32).to_le_bytes());
    buf.extend_from_slice(&audio_version.to_le_bytes());
    let noise_floor_db = -96.0;
    
    for &mag in &stft.matrix {
        let db = 20.0 * mag.max(1e-6).log10();
        let normalized = (db - noise_floor_db) / -noise_floor_db;
        buf.push((normalized.clamp(0.0, 1.0) * 255.0) as u8);
    }
    buf
}

/// Resuelve un sistema lineal de ecuaciones M * X = B usando la eliminación de Gauss con pivoteo parcial.
fn solve_linear_system(matrix: &mut [Vec<f32>], rhs: &mut [f32]) -> Option<Vec<f32>> {
    let n = matrix.len();
    for i in 0..n {
        // Encontrar el pivote máximo en la columna i
        let mut max_row = i;
        let mut max_val = matrix[i][i].abs();
        for r in (i + 1)..n {
            let val = matrix[r][i].abs();
            if val > max_val {
                max_val = val;
                max_row = r;
            }
        }
        if max_val < 1e-9 {
            return None; // Matriz singular o mal condicionada
        }
        // Intercambiar filas si es necesario
        if max_row != i {
            matrix.swap(i, max_row);
            rhs.swap(i, max_row);
        }
        // Eliminación hacia adelante
        for r in (i + 1)..n {
            let factor = matrix[r][i] / matrix[i][i];
            for c in i..n {
                matrix[r][c] -= factor * matrix[i][c];
            }
            rhs[r] -= factor * rhs[i];
        }
    }
    // Sustitución hacia atrás
    let mut x = vec![0.0f32; n];
    for i in (0..n).rev() {
        let mut sum = 0.0f32;
        for j in (i + 1)..n {
            sum += matrix[i][j] * x[j];
        }
        x[i] = (rhs[i] - sum) / matrix[i][i];
    }
    Some(x)
}

/// Estructura para el filtrado de audio IIR utilizando celdas biquad de segundo orden.
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl Biquad {
    /// Diseña un filtro Notch adaptativo de banda estrecha para rechazo de Hum
    fn new_notch(freq: f32, sample_rate: f32, q: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate;
        let alpha = w0.sin() / (2.0 * q);
        let cos_w0 = w0.cos();
        
        let b0 = 1.0;
        let b1 = -2.0 * cos_w0;
        let b2 = 1.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;
        
        let norm = 1.0 / a0;
        Biquad {
            b0: b0 * norm,
            b1: b1 * norm,
            b2: b2 * norm,
            a1: a1 * norm,
            a2: a2 * norm,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// Diseña un filtro High-Shelf para atenuación de siseo / hiss
    fn new_high_shelf(freq: f32, sample_rate: f32, gain_db: f32, slope: f32) -> Self {
        let w0 = 2.0 * std::f32::consts::PI * freq / sample_rate;
        let a = 10.0f32.powf(gain_db / 40.0);
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        
        let alpha_sq = (a + 1.0 / a) * (1.0 / slope - 1.0) + 2.0;
        let alpha = sin_w0 / 2.0 * alpha_sq.max(0.0).sqrt();
        let two_sqrt_a_alpha = 2.0 * a.sqrt() * alpha;
        
        let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w0 + two_sqrt_a_alpha);
        let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w0);
        let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w0 - two_sqrt_a_alpha);
        let a0 = (a + 1.0) - (a - 1.0) * cos_w0 + two_sqrt_a_alpha;
        let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w0);
        let a2 = (a + 1.0) - (a - 1.0) * cos_w0 - two_sqrt_a_alpha;
        
        let norm = 1.0 / a0;
        Biquad {
            b0: b0 * norm,
            b1: b1 * norm,
            b2: b2 * norm,
            a1: a1 * norm,
            a2: a2 * norm,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    /// Procesa una muestra de audio in-place
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2 - self.a1 * self.y1 - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// Interpolación cúbica Hermite pura sobre una brecha específica
pub fn heal_single_glitch_hermite(
    samples: &mut [f32],
    start_dmg: usize,
    end_dmg: usize,
    tension: f32,
) {
    let n_total = samples.len();
    if start_dmg >= end_dmg || start_dmg < 2 || end_dmg >= n_total - 2 {
        return;
    }
    
    let span = end_dmg - start_dmg + 1;
    let p0 = samples[start_dmg - 1];
    let p1 = samples[end_dmg + 1];

    let p0prev = samples[start_dmg.saturating_sub(2)];
    let p1next = samples[(end_dmg + 2).min(n_total - 1)];
    
    let m0 = (1.0 - tension) * (p0 - p0prev); // Derivada backward en el borde izquierdo modificada por tension
    let m1 = (1.0 - tension) * (p1next - p1); // Derivada forward en el borde derecho modificada por tension

    for i in 0..span {
        let t = if span > 1 { i as f32 / (span - 1) as f32 } else { 0.5 };
        let t2 = t * t;
        let t3 = t2 * t;

        let h00 =  2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 =       t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 =       t3 - t2;

        samples[start_dmg + i] = (h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1).clamp(-1.0, 1.0);
    }
}

/// Representa el cambio de estado de un fragmento de audio modificado (para deshacer/rehacer)
#[derive(Debug, Clone)]
pub struct AudioHistoryState {
    pub channel: u16,
    pub glitch_sample_index: usize,
    pub start_sample: usize,
    pub old_samples: Vec<f32>,
    pub new_samples: Vec<f32>,
}

/// Reparación especializada para Clicks usando interpolación cúbica Hermite temporal rápida
fn heal_click_hermite(
    samples: &mut [f32],
    glitch: &GlitchEvent,
    config: &HermiteConfig,
) -> (usize, usize) {
    let n_total = samples.len();
    let idx = glitch.sample_index;
    if idx >= n_total { return (idx, idx); }
    
    let explicit_dur = glitch.duration_samples.unwrap_or(config.window_size);
    
    let (mut start_dmg, mut end_dmg) = if explicit_dur > 16 {
        // MODO CIRUGÍA MANUAL: El usuario o el fallback definió un ancho masivo.
        // Ignoramos el umbral de derivada y forzamos la ventana para abarcar la selección completa.
        let half = explicit_dur / 2;
        (idx.saturating_sub(half).max(2), (idx + half).min(n_total - 3))
    } else {
        // MODO AUTOMÁTICO: Búsqueda dinámica basada en la duración calculada por el detector (transient_duration)
        // El detector ya midió con precisión matemática cuántas muestras toma el decaimiento.
        // Confiamos en ese número en lugar de intentar adivinar los cruces por cero.
        let dur = explicit_dur.max(4); // Al menos 4 muestras para un micro-click

        let attack = (dur / 3).max(2); // El ataque suele ser muy rápido (1/3 del total)
        let decay = dur.max(3);        // El decaimiento es la cola del click

        (idx.saturating_sub(attack).max(2), (idx + decay).min(n_total - 3))
    };
    
    start_dmg = start_dmg.max(2);
    end_dmg = end_dmg.min(n_total - 3);
    
    heal_single_glitch_hermite(samples, start_dmg, end_dmg, config.tension);
    (start_dmg, end_dmg)
}

/// Reparación especializada para Clipping (Distorsión) tratando picos planos como gaps
/// Implementa una spline Hermite C1-continua suavizada con atenuación de pico del 20%
pub fn heal_distortion_hermite(
    samples: &mut [f32],
    glitch: &GlitchEvent,
) -> (usize, usize) {
    let n_total = samples.len();
    let idx = glitch.sample_index;
    if idx >= n_total { return (idx, idx); }
    let duration = glitch.duration_samples.unwrap_or(4);
    
    let start_dmg = idx.saturating_sub(2).max(2);
    let end_dmg = (idx + duration + 1).min(n_total - 3);
    
    if start_dmg >= end_dmg || start_dmg < 2 || end_dmg >= n_total - 2 {
        return (idx, idx);
    }
    
    let span = end_dmg - start_dmg + 1;
    let l_val = (span + 1) as f32;
    
    // Muestras de anclaje de frontera
    let x0 = samples[start_dmg - 1];
    let x1 = samples[end_dmg + 1];
    
    // Pendientes en las fronteras
    let d0 = samples[start_dmg - 1] - samples[start_dmg - 2];
    let d1 = samples[end_dmg + 2] - samples[end_dmg + 1];
    
    // Coeficiente de atenuación para el pico reconstruido (evita agresividad y recortes)
    let alpha = 0.80f32; 
    
    for i in 0..span {
        let t = if span > 1 { i as f32 / (span - 1) as f32 } else { 0.5 };
        let t2 = t * t;
        let t3 = t2 * t;
        
        // Funciones de base de Hermite
        let h00 =  2.0 * t3 - 3.0 * t2 + 1.0;
        let h10 =       t3 - 2.0 * t2 + t;
        let h01 = -2.0 * t3 + 3.0 * t2;
        let h11 =       t3 - t2;
        
        // Spline Hermite original C1-continua
        let h_val = h00 * x0 + h10 * (l_val * d0) + h01 * x1 + h11 * (l_val * d1);
        
        // Línea base de interpolación lineal
        let line_val = (1.0 - t) * x0 + t * x1;
        
        // Desviación del pico respecto a la recta
        let dev = h_val - line_val;
        
        // Muestra suavizada con pico atenuado
        samples[start_dmg + i] = (line_val + alpha * dev).clamp(-1.0, 1.0);
    }
    
    (start_dmg, end_dmg)
}

/// Reparación para Pops, Dropouts y Slips usando LSAR (Least Squares Autoregressive) con fallback Hermite
fn heal_pop_or_dropout_lsar(
    samples: &mut [f32],
    glitch: &GlitchEvent,
    noise_floor: f32,
) -> (usize, usize) {
    let n_total = samples.len();
    let idx = glitch.sample_index;
    if idx >= n_total { return (idx, idx); }
    
    let mut start_dmg;
    let mut end_dmg;
    
    if let Some(dur) = glitch.duration_samples {
        if dur > 16 {
            let half = dur / 2;
            start_dmg = idx.saturating_sub(half).max(9);
            end_dmg = (idx + half).min(n_total - 10);
        } else {
            start_dmg = idx.saturating_sub(4).max(9);
            end_dmg = (idx + dur + 3).min(n_total - 10);
        }
    } else {
        let max_win = 256.min((glitch.amplitude_delta * 128.0) as usize);
        let dev_thresh = (noise_floor * 3.0).max(0.01);

        start_dmg = idx;
        while start_dmg > 1 && (idx - start_dmg) < max_win {
            if (samples[start_dmg] - samples[start_dmg - 1]).abs() > dev_thresh {
                start_dmg -= 1;
            } else { break; }
        }

        end_dmg = idx;
        while end_dmg < n_total - 2 && (end_dmg - idx) < max_win {
            if (samples[end_dmg] - samples[end_dmg + 1]).abs() > dev_thresh {
                end_dmg += 1;
            } else { break; }
        }
        
        start_dmg = start_dmg.max(9);
        end_dmg = end_dmg.min(n_total - 10);
    }
    
    if start_dmg >= end_dmg { return (idx, idx); }
    
    let span = end_dmg - start_dmg + 1;
    let mut lpc_success = false;

    if span <= 1024 {
        let lpc_order = 16;
        let context_size = 256.max(lpc_order * 4);
        
        let pre_start = start_dmg.saturating_sub(context_size);
        let pre_end = start_dmg;
        let post_start = end_dmg + 1;
        let post_end = (end_dmg + 1 + context_size).min(n_total);
        
        if pre_end > pre_start && post_end > post_start {
            let mut context = Vec::with_capacity((pre_end - pre_start) + (post_end - post_start));
            context.extend_from_slice(&samples[pre_start..pre_end]);
            context.extend_from_slice(&samples[post_start..post_end]);
            
            let mut a_coefs = [0.0f32; 16];
            if let Some(stable_order) = lpc_levinson_durbin_in_place(&context, lpc_order, &mut a_coefs) {
                let mut h = vec![0.0f32; stable_order + 1];
                h[0] = 1.0;
                for k in 0..stable_order {
                    h[k + 1] = -a_coefs[k];
                }
                
                let mut m_matrix = vec![vec![0.0f32; span]; span];
                let mut b_vector = vec![0.0f32; span];
                
                for i in 0..span {
                    let u = start_dmg + i;
                    
                    for j in 0..span {
                        let v = start_dmg + j;
                        
                        let n_start = u.max(v).max(stable_order);
                        let n_end = (u + stable_order).min(v + stable_order).min(n_total - 1);
                        
                        let mut sum_m = 0.0f64;
                        for n in n_start..=n_end {
                            sum_m += (h[n - u] as f64) * (h[n - v] as f64);
                        }
                        m_matrix[i][j] = sum_m as f32;
                    }
                    
                    let n_start = u.max(stable_order);
                    let n_end = (u + stable_order).min(n_total - 1);
                    
                    let mut sum_b = 0.0f64;
                    for n in n_start..=n_end {
                        let idx_u = n - u;
                        
                        let mut sum_known = 0.0f64;
                        let m_start = n.saturating_sub(stable_order);
                        let m_end = n;
                        for m in m_start..=m_end {
                            if m < start_dmg || m > end_dmg {
                                sum_known += (h[n - m] as f64) * (samples[m] as f64);
                            }
                        }
                        sum_b += (h[idx_u] as f64) * sum_known;
                    }
                    b_vector[i] = -sum_b as f32;
                }
                
                if let Some(x_solved) = solve_linear_system(&mut m_matrix, &mut b_vector) {
                    for i in 0..span {
                        samples[start_dmg + i] = x_solved[i].clamp(-1.0, 1.0);
                    }
                    lpc_success = true;
                }
            }
        }
    }
    
    if !lpc_success {
        heal_single_glitch_hermite(samples, start_dmg, end_dmg, 0.0);
    }
    (start_dmg, end_dmg)
}

/// Reparación especializada para Hum eléctrico usando cascada de filtros Notch con crossfades locales
fn heal_hum_notch(
    samples: &mut [f32],
    glitch: &GlitchEvent,
    sample_rate: u32,
) -> (usize, usize) {
    let start = glitch.sample_index;
    let duration = glitch.duration_samples.unwrap_or(2048);
    let n_total = samples.len();
    if start >= n_total { return (start, start); }
    let end = (start + duration).min(n_total);
    
    let f_fund = glitch.frequency.unwrap_or(50.0);
    let mut filters = Vec::new();
    let q = 30.0;
    
    if f_fund > 0.0 && f_fund < sample_rate as f32 / 2.0 {
        filters.push(Biquad::new_notch(f_fund, sample_rate as f32, q));
    }
    if 2.0 * f_fund > 0.0 && 2.0 * f_fund < sample_rate as f32 / 2.0 {
        filters.push(Biquad::new_notch(2.0 * f_fund, sample_rate as f32, q));
    }
    if 3.0 * f_fund > 0.0 && 3.0 * f_fund < sample_rate as f32 / 2.0 {
        filters.push(Biquad::new_notch(3.0 * f_fund, sample_rate as f32, q));
    }
    
    if filters.is_empty() { return (start, start); }
    
    let warmup_len = 1024.min(start);
    let warmup_start = start - warmup_len;
    for i in warmup_start..start {
        let mut x = samples[i];
        for filter in &mut filters {
            x = filter.process(x);
        }
    }
    
    let span = end - start;
    let fade_len = 256.min(span / 4).max(1);
    
    for i in 0..span {
        let idx = start + i;
        let orig = samples[idx];
        let mut x = orig;
        for filter in &mut filters {
            x = filter.process(x);
        }
        
        let (w_orig, w_filt) = if i < fade_len {
            let t = i as f32 / fade_len as f32;
            let angle = t * std::f32::consts::FRAC_PI_2;
            (angle.cos(), angle.sin())
        } else if i >= span - fade_len {
            let t = (span - 1 - i) as f32 / fade_len as f32;
            let angle = t * std::f32::consts::FRAC_PI_2;
            (angle.cos(), angle.sin())
        } else {
            (0.0, 1.0)
        };
        
        samples[idx] = w_orig * orig + w_filt * x;
    }
    (start, end.saturating_sub(1))
}

/// Reparación especializada para Hiss usando un filtro High-Shelf local con crossfades
fn heal_hiss_shelf(
    samples: &mut [f32],
    glitch: &GlitchEvent,
    sample_rate: u32,
) -> (usize, usize) {
    let start = glitch.sample_index;
    let duration = glitch.duration_samples.unwrap_or(2048);
    let n_total = samples.len();
    if start >= n_total { return (start, start); }
    let end = (start + duration).min(n_total);
    
    let mut filter = Biquad::new_high_shelf(5000.0, sample_rate as f32, -12.0, 1.0);
    
    let warmup_len = 1024.min(start);
    let warmup_start = start - warmup_len;
    for i in warmup_start..start {
        let _ = filter.process(samples[i]);
    }
    
    let span = end - start;
    let fade_len = 512.min(span / 4).max(1);
    
    for i in 0..span {
        let idx = start + i;
        let orig = samples[idx];
        let x = filter.process(orig);
        
        let (w_orig, w_filt) = if i < fade_len {
            let t = i as f32 / fade_len as f32;
            let angle = t * std::f32::consts::FRAC_PI_2;
            (angle.cos(), angle.sin())
        } else if i >= span - fade_len {
            let t = (span - 1 - i) as f32 / fade_len as f32;
            let angle = t * std::f32::consts::FRAC_PI_2;
            (angle.cos(), angle.sin())
        } else {
            (0.0, 1.0)
        };
        
        samples[idx] = w_orig * orig + w_filt * x;
    }
    (start, end.saturating_sub(1))
}

/// Helper que despacha cada tipo de glitch a su respectivo algoritmo especializado
pub fn heal_single_glitch_mono(
    samples: &mut [f32],
    glitch: &GlitchEvent,
    noise_floor: f32,
    sample_rate: u32,
    hermite_config: &HermiteConfig,
) -> (usize, usize) {
    let mut adjusted_glitch = glitch.clone();
    if adjusted_glitch.event_type == GlitchType::Click {
        if let Some(dur) = adjusted_glitch.duration_samples {
            if dur > 128 {
                // Acotar el tamaño de la ventana de click manual para evitar dropouts audibles.
                // Un click real transitorio de alta frecuencia rara vez supera los 2-3 ms (~128 muestras).
                adjusted_glitch.duration_samples = Some(64.max(hermite_config.window_size));
            }
        }
    } else if adjusted_glitch.event_type == GlitchType::Pop {
        if let Some(dur) = adjusted_glitch.duration_samples {
            if dur > 1024 {
                // Acotar el tamaño de la ventana de pop manual para evitar dropouts y pánicos.
                // Un pop/thump de baja frecuencia real suele durar 20-30 ms (~1024 muestras).
                adjusted_glitch.duration_samples = Some(1024);
            }
        }
    }

    match adjusted_glitch.event_type {
        GlitchType::Click => {
            if adjusted_glitch.duration_samples.unwrap_or(0) > 32 {
                // Para brechas grandes, la interpolación Cúbica Hermite genera "vacíos" (dropouts) 
                // por falta de altas frecuencias. Redirigimos automáticamente al relleno Autoregresivo (LSAR).
                let (s, e) = heal_pop_or_dropout_lsar(samples, &adjusted_glitch, noise_floor);
                if s < e {
                    (s, e)
                } else {
                    heal_click_hermite(samples, &adjusted_glitch, hermite_config)
                }
            } else {
                heal_click_hermite(samples, &adjusted_glitch, hermite_config)
            }
        }
        GlitchType::Pop | GlitchType::Dropout | GlitchType::Slip => {
            heal_pop_or_dropout_lsar(samples, &adjusted_glitch, noise_floor)
        }
        GlitchType::Hum => {
            heal_hum_notch(samples, &adjusted_glitch, sample_rate)
        }
        GlitchType::Hiss => {
            heal_hiss_shelf(samples, &adjusted_glitch, sample_rate)
        }
        GlitchType::Distortion => {
            heal_distortion_hermite(samples, &adjusted_glitch)
        }
    }
}

/// Repara quirúrgicamente los glitches aplicando algoritmos especializados **in-place** capturando los cambios de estado para Undo/Redo.
pub fn heal_glitches_inplace_with_history(
    samples: &mut [f32],
    channels: u16,
    glitches: &[GlitchEvent],
    noise_floor: f32,
    sample_rate: u32,
    hermite_config: &HermiteConfig,
) -> Vec<AudioHistoryState> {
    let mut history = Vec::new();
    let n_channels = channels as usize;
    if n_channels == 0 || samples.is_empty() {
        return history;
    }
    
    // 1. De-interleave all channels ONCE to avoid quadratic heap allocations
    let mut channels_data = Vec::with_capacity(n_channels);
    for c in 0..n_channels {
        let chan_samples: Vec<f32> = samples.iter().skip(c).step_by(n_channels).cloned().collect();
        channels_data.push(chan_samples);
    }
    
    // Create a reference copy of the original channel samples for extracting the undo history
    let channels_data_orig = channels_data.clone();
    
    // 2. Process each active glitch sequentially on the de-interleaved buffers
    for glitch in glitches {
        if glitch.repaired { continue; }
        
        let channels_to_heal = if glitch.channel == 2 && n_channels >= 2 {
            vec![0, 1]
        } else {
            vec![glitch.channel as usize]
        };
        
        for c in channels_to_heal {
            if c >= n_channels { continue; }
            
            // Alinear dinámicamente el índice del transitorio para el canal c si es Ambos (channel == 2)
            let mut adjusted_glitch = glitch.clone();
            if glitch.channel == 2 && (glitch.event_type == GlitchType::Click || glitch.event_type == GlitchType::Pop || glitch.event_type == GlitchType::Dropout || glitch.event_type == GlitchType::Distortion || glitch.event_type == GlitchType::Slip) {
                let center = glitch.sample_index;
                let search_radius = 512; // ~11ms a 44.1kHz, ideal para ventana de consolidación de 50ms
                let start_search = center.saturating_sub(search_radius).max(1);
                let end_search = (center + search_radius).min(channels_data[c].len());
                
                let mut max_deriv = 0.0f32;
                let mut peak_idx = center;
                for i in start_search..end_search {
                    let deriv = (channels_data[c][i] - channels_data[c][i - 1]).abs();
                    if deriv > max_deriv {
                        max_deriv = deriv;
                        peak_idx = i;
                    }
                }
                if max_deriv > 0.001 {
                    adjusted_glitch.sample_index = peak_idx;
                }
            }
            
            // Ejecutar la reparación sobre el canal correspondiente in-place
            let (start, end) = heal_single_glitch_mono(&mut channels_data[c], &adjusted_glitch, noise_floor, sample_rate, hermite_config);
            
            if start < channels_data[c].len() && end < channels_data[c].len() && start <= end {
                let old_samples = channels_data_orig[c][start..=end].to_vec();
                let new_samples = channels_data[c][start..=end].to_vec();
                
                history.push(AudioHistoryState {
                    channel: c as u16,
                    glitch_sample_index: glitch.sample_index,
                    start_sample: start,
                    old_samples,
                    new_samples,
                });
            }
        }
    }

    // 3. Re-interleave all channels back to the global buffer ONCE
    for c in 0..n_channels {
        for (i, &val) in channels_data[c].iter().enumerate() {
            samples[i * n_channels + c] = val;
        }
    }

    history
}

/// Repara quirúrgicamente los glitches aplicando algoritmos especializados **in-place** (soporta estéreo).
pub fn heal_glitches_inplace(
    samples: &mut [f32],
    channels: u16,
    glitches: &[GlitchEvent],
    noise_floor: f32,
    sample_rate: u32,
) {
    let _ = heal_glitches_inplace_with_history(samples, channels, glitches, noise_floor, sample_rate, &HermiteConfig::default());
}

#[allow(dead_code)]
pub fn heal_glitches(
    samples: &[f32],
    channels: u16,
    glitches: &[GlitchEvent],
    noise_floor: f32,
    sample_rate: u32,
) -> Vec<f32> {
    let mut v = samples.to_vec();
    heal_glitches_inplace(&mut v, channels, glitches, noise_floor, sample_rate);
    v
}

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

    if visible_frames_len <= config.max_texture_width {
        let mut sub_matrix = vec![0.0; visible_frames_len * num_bins];
        let src_start_offset = start * num_bins;
        let src_end_offset = end * num_bins;
        sub_matrix.copy_from_slice(&stft.matrix[src_start_offset..src_end_offset]);
        return StftResult {
            matrix: sub_matrix,
            num_frames: visible_frames_len,
            num_bins,
        };
    }

    let target_width = config.max_texture_width;
    let mut downsampled_matrix = vec![0.0; target_width * num_bins];
    let step = visible_frames_len as f64 / target_width as f64;

    for dest_f in 0..target_width {
        let src_start_f = (start as f64 + dest_f as f64 * step).floor() as usize;
        let src_end_f = (start as f64 + (dest_f + 1) as f64 * step).ceil() as usize;
        let src_end_f = src_end_f.min(end);
        let count = (src_end_f - src_start_f).max(1) as f32;

        let dest_offset = dest_f * num_bins;

        for k in 0..num_bins {
            let mut sum_sq = 0.0;
            for src_f in src_start_f..src_end_f {
                let val = stft.matrix[src_f * num_bins + k];
                sum_sq += val * val;
            }
            downsampled_matrix[dest_offset + k] = (sum_sq / count).sqrt();
        }
    }

    StftResult {
        matrix: downsampled_matrix,
        num_frames: target_width,
        num_bins,
    }
}

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
        _ => { // Fallback to 16-bit
            for &s in samples {
                let i16_val = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
                writer.write_sample(i16_val).map_err(|e| e.to_string())?;
            }
        }
    }

    writer.finalize().map_err(|e| format!("Error finalizando el archivo WAV: {}", e))?;
    Ok(())
}

pub fn update_stft_range_multichannel(
    stft: &mut StftResult,
    samples: &[f32],
    channels: u16,
    start_sample: usize,
    end_sample: usize,
    fft_size: usize,
    hop_size: usize,
    window_type: &str,
) -> Result<(), String> {
    let n_channels = channels as usize;
    let num_bins = fft_size / 2;
    let total_frames = stft.num_frames;

    // 1. Determinar los frames espectrales afectados
    // Un frame f lee muestras desde f * hop_size hasta f * hop_size + fft_size
    // Buscamos los frames que se solapan con [start_sample, end_sample]
    let f_start = start_sample.saturating_sub(fft_size) / hop_size;
    let f_end = ((end_sample + fft_size) / hop_size).min(total_frames.saturating_sub(1));

    if f_start > f_end {
        return Ok(());
    }

    // 2. Preparar el planificador y la ventana
    let window = build_window(fft_size, window_type);
    let mut planner = RealFftPlanner::<f32>::new();
    let r2c = planner.plan_fft_forward(fft_size);
    let window_sum: f32 = window.iter().sum();
    let norm = 1.0 / window_sum.max(1e-9);

    // Muestras de audio para los frames afectados
    // Muestra física inicial en de-interleave
    let sample_start = f_start * hop_size;
    let sample_end = (f_end * hop_size + fft_size).min(samples.len() / n_channels);

    if sample_start >= sample_end || sample_end - sample_start < fft_size {
        return Ok(());
    }

    // 3. De-interleave para los canales en el rango afectado
    let mut channel_local_stfts = Vec::with_capacity(n_channels);
    let local_frames = f_end - f_start + 1;

    for c in 0..n_channels {
        // Extraemos las muestras del canal c en el rango [sample_start, sample_end]
        let mut chan_slice = vec![0.0f32; sample_end - sample_start];
        for i in 0..chan_slice.len() {
            let idx = (sample_start + i) * n_channels + c;
            if idx < samples.len() {
                chan_slice[i] = samples[idx];
            }
        }

        // Computamos la STFT local para este canal
        let mut local_matrix = vec![0.0f32; local_frames * num_bins];
        let mut input = r2c.make_input_vec();
        let mut complex_output = r2c.make_output_vec();

        for local_f in 0..local_frames {
            let offset = local_f * hop_size;
            if offset + fft_size <= chan_slice.len() {
                for i in 0..fft_size {
                    input[i] = chan_slice[offset + i] * window[i];
                }
                if r2c.process(&mut input, &mut complex_output).is_ok() {
                    let dest_offset = local_f * num_bins;
                    for k in 0..num_bins {
                        local_matrix[dest_offset + k] = complex_output[k].norm() * norm;
                    }
                }
            }
        }
        channel_local_stfts.push(local_matrix);
    }

    // 4. Combinar (tomando la magnitud máxima) y escribir en la matriz global de stft
    for local_f in 0..local_frames {
        let global_f = f_start + local_f;
        if global_f >= total_frames {
            break;
        }

        let global_offset = global_f * num_bins;
        let local_offset = local_f * num_bins;

        for k in 0..num_bins {
            let mut max_val = 0.0f32;
            for c in 0..n_channels {
                if local_offset + k < channel_local_stfts[c].len() {
                    max_val = max_val.max(channel_local_stfts[c][local_offset + k]);
                }
            }
            if global_offset + k < stft.matrix.len() {
                stft.matrix[global_offset + k] = max_val;
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_consolidacion_contextual_dropout() {
        // Clic simulado cerca del flanco de inicio de un dropout
        let click_near = GlitchEvent {
            sample_index: 1000,
            time_secs: 1000.0 / 44100.0,
            amplitude_delta: 0.5,
            direction: 1,
            event_type: GlitchType::Click,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(2),
        };

        // Clic lejano (no filtrado)
        let click_far = GlitchEvent {
            sample_index: 5000,
            time_secs: 5000.0 / 44100.0,
            amplitude_delta: 0.5,
            direction: 1,
            event_type: GlitchType::Click,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(2),
        };

        // Dropout de 1100 a 2000 samples
        let dropout = GlitchEvent {
            sample_index: 1100,
            time_secs: 1100.0 / 44100.0,
            amplitude_delta: 0.8,
            direction: -1,
            event_type: GlitchType::Dropout,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(900),
        };

        let events = vec![click_near, click_far, dropout];
        let filtered = consolidar_y_correlacionar_contextualmente(events);

        assert_eq!(filtered.len(), 2);
        assert!(filtered.iter().any(|e| e.event_type == GlitchType::Dropout));
        assert!(filtered.iter().any(|e| e.sample_index == 5000)); // Click lejano
        assert!(!filtered.iter().any(|e| e.sample_index == 1000)); // Click cercano filtrado
    }

    #[test]
    fn test_consolidacion_contextual_distortion() {
        // Clic solapado con distorsión
        let click_overlapping = GlitchEvent {
            sample_index: 1500,
            time_secs: 1500.0 / 44100.0,
            amplitude_delta: 0.5,
            direction: 1,
            event_type: GlitchType::Click,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(2),
        };

        // Distorsión de 1000 a 2000 samples
        let distortion = GlitchEvent {
            sample_index: 1000,
            time_secs: 1000.0 / 44100.0,
            amplitude_delta: 1.0,
            direction: 1,
            event_type: GlitchType::Distortion,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(1000),
        };

        let events = vec![click_overlapping, distortion];
        let filtered = consolidar_y_correlacionar_contextualmente(events);

        assert_eq!(filtered.len(), 1);
        assert!(filtered.iter().any(|e| e.event_type == GlitchType::Distortion));
        assert!(!filtered.iter().any(|e| e.event_type == GlitchType::Click));
    }
}
