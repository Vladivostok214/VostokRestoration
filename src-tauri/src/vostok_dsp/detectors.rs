use rayon::prelude::*;
use crate::vostok_dsp::types::*;
use crate::vostok_dsp::utils::*;
use crate::vostok_dsp::stft::compute_stft;

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

        let avg_delta = {
            let mut sum_d = 0.0f32;
            for i in 1..block_samples.len() {
                sum_d += (block_samples[i] - block_samples[i - 1]).abs();
            }
            sum_d / (block_samples.len() - 1) as f32
        };

        // Estimar coeficientes AR mediante Levinson-Durbin in-place
        if let Some(stable_order) = lpc_levinson_durbin_in_place(block_samples, lpc_order, &mut a_coefs) {
            // Limpiar únicamente la porción no calculada del residuo
            residual[0..stable_order].fill(0.0);

            // Calcular señal residual e[n] para el bloque
            let mut count = 0;

            for n in stable_order..block_size {
                let mut pred = 0.0f32;
                for k in 0..stable_order {
                    pred += a_coefs[k] * block_samples[n - 1 - k];
                }
                let err = block_samples[n] - pred;
                residual[n] = err;
                count += 1;
            }

            if count == 0 {
                continue;
            }

            // Estimación robusta de la desviación estándar usando MAD (Median Absolute Deviation)
            let mut abs_residuals: Vec<f32> = residual[stable_order..block_size]
                .iter()
                .map(|&r| r.abs())
                .collect();
            let count_res = abs_residuals.len();
            if count_res == 0 {
                continue;
            }
            abs_residuals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median = if count_res % 2 == 0 {
                (abs_residuals[count_res / 2 - 1] + abs_residuals[count_res / 2]) * 0.5
            } else {
                abs_residuals[count_res / 2]
            };
            let std_dev_residual = (1.4826 * median).max(1e-6);
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
                    let min_relative_delta = avg_delta * (2.5 + (1.0 - sensitivity) * 4.5);

                    if delta_physical < min_physical_delta || delta_physical < min_relative_delta {
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
                        // Aumentado de 1.2 a 1.6 en voz para exigir un decaimiento real de la discontinuidad
                        ratio_threshold = ratio_threshold.min(1.6); 
                    }
                    if ratio_prev < ratio_threshold || ratio_next < ratio_threshold {
                        continue; // No es un click lo suficientemente aislado, es contenido musical
                    }

                    // 3. Discriminación de notas musicales (Ataques sostenidos de colita larga):
                    let val_err_next2 = residual[n + 2].abs();
                    let mut next2_threshold = 0.3 + (sensitivity * 0.5);
                    if audio_mode == AudioMode::Voice {
                        // En voz exigimos decaimiento a 0.85 en lugar de permitir resonancia masiva (1.5x)
                        next2_threshold = next2_threshold.min(0.85);
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

                    let mut min_hfer = 0.08 - (sensitivity * 0.06);
                    let ratio_lpc = val_err / local_threshold.max(1e-6);
                    if ratio_lpc > 2.5 {
                        let floor = 0.01f32;
                        min_hfer = floor + (min_hfer - floor) * (-(ratio_lpc - 2.5)).exp();
                    }
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
                            let ratio = entry_change.abs() / exit_change.abs().max(1e-6);
                            if ratio <= 10.0 {
                                continue;
                            }
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

/// Detector de Pops & Low Thumps (Bajas Frecuencias < 120 Hz)
pub fn detectar_pops(
    features: &[FrameFeatures],
    stft: &StftResult,
    sample_rate: u32,
    _global_rms: f32,
    sensitivity: f32,
    audio_mode: AudioMode,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let num_frames = stft.num_frames;
    let num_bins = stft.num_bins;
    let hop_size = 1024;
    
    // 120 Hz bin boundary (excluyendo el bin DC 0 para evitar offset de continua)
    let k_120 = ((120.0 * 4096.0 / sample_rate as f32).round() as usize).min(num_bins).max(3);
    
    let mut inside_pop = false;
    let mut start_frame = 0;
    let context_size = 8; // Ventana de contexto precedente de ~185ms
    
    for t in context_size..num_frames {
        let start_bin = t * num_bins;
        let mags = &stft.matrix[start_bin..start_bin + num_bins];
        
        // Calcular energía en baja frecuencia (20-120 Hz), omitiendo bin 0
        let low_energy: f32 = mags[1..k_120].iter().sum();
        
        // Calcular promedio de energía en baja frecuencia en los frames precedentes
        let mut prev_low_energy_sum = 0.0f32;
        for i in 1..=context_size {
            let prev_start_bin = (t - i) * num_bins;
            let prev_mags = &stft.matrix[prev_start_bin..prev_start_bin + num_bins];
            prev_low_energy_sum += prev_mags[1..k_120].iter().sum::<f32>();
        }
        let avg_prev_low_energy = prev_low_energy_sum / context_size as f32;
        
        // Ratio de incremento relativo
        let energy_ratio = if avg_prev_low_energy > 1e-5 {
            low_energy / avg_prev_low_energy
        } else {
            1.0
        };
        
        // [EXP-POP-01] Sensibilidad dinámica para umbrales de energía y ratio
        let pop_ratio_threshold = 3.0 + ((1.0 - sensitivity) * 2.0);
        let pop_min_rms = 0.002 + ((1.0 - sensitivity) * 0.004);
        let pop_min_low_energy = 0.02 + ((1.0 - sensitivity) * 0.03);
        
        // Un pop es un incremento rápido y transitorio de energía subsónica/baja
        let is_pop_frame = energy_ratio > pop_ratio_threshold 
            && low_energy > pop_min_low_energy 
            && features[t].rms > pop_min_rms;
        
        if is_pop_frame {
            // [EXP-POP-02] Diferenciación Voice/Music para descartar plosivas
            let mut reject_pop = false;
            if audio_mode == AudioMode::Voice {
                // Las plosivas (P, B, T) liberan aire de alta frecuencia al explotar.
                // Evaluamos el Zero Crossing Rate.
                let zcr = features[t].zero_crossing_rate;
                let zcr_threshold = 0.15 - (sensitivity * 0.05);
                if zcr > zcr_threshold {
                    reject_pop = true; // Probable sibilancia o liberación de aire del tracto vocal
                }
            }

            if !inside_pop && !reject_pop {
                inside_pop = true;
                start_frame = t;
            }
        } else {
            if inside_pop {
                inside_pop = false;
                let duration_frames = t - start_frame;
                
                // Los pops de cinta o de impacto físico son transitorios muy breves (15ms - 60ms).
                // Con saltos de 23.2ms, deben durar entre 1 y 3 frames de la STFT.
                // Si duran más, es un bajo sostenido, bombo o hum largo, no un pop.
                if duration_frames >= 1 && duration_frames <= 3 {
                    let start_sample = start_frame * hop_size;
                    events.push(GlitchEvent {
                        sample_index: start_sample,
                        time_secs: start_sample as f64 / sample_rate as f64,
                        amplitude_delta: features[start_frame].rms,
                        direction: 0,
                        event_type: GlitchType::Pop,
                        repaired: false,
                        frequency: Some(40.0), // Frecuencia representativa central del Thump
                        channel: 0,
                        duration_samples: Some(duration_frames * hop_size),
                    });
                }
            }
        }
    }
    
    // Si termina en estado de pop pero cumple la duración
    if inside_pop {
        let duration_frames = num_frames - start_frame;
        if duration_frames >= 1 && duration_frames <= 3 {
            let start_sample = start_frame * hop_size;
            events.push(GlitchEvent {
                sample_index: start_sample,
                time_secs: start_sample as f64 / sample_rate as f64,
                amplitude_delta: features[start_frame].rms,
                direction: 0,
                event_type: GlitchType::Pop,
                repaired: false,
                frequency: Some(40.0),
                channel: 0,
                duration_samples: Some(duration_frames * hop_size),
            });
        }
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
    let window_size = sample_rate as usize;
    
    // Configuración de Consolidación Temporal (100 ms)
    let gap_samples = (sample_rate as f32 * 0.100).round() as usize;
    
    // Estado de la región actual
    let mut region_start: Option<usize> = None;
    let mut region_end: usize = 0;
    let mut region_max_val: f32 = 0.0;
    let mut region_direction: i8 = 0;
    
    let mut start_idx = 0;
    while start_idx < n {
        let end_idx = usize::min(start_idx + window_size, n);
        let window_samples = &samples[start_idx..end_idx];
        
        // Calcular el peak absoluto local de la ventana actual
        let local_peak = window_samples.iter().fold(0.0f32, |max, &x| f32::max(max, x.abs()));
        
        // [EXP-CLIP-02] Umbral Híbrido por ventana
        let limit = f32::max(0.70, local_peak * 0.95);
        let tolerance = 0.015f32;
        
        let mut i = 0;
        let window_len = window_samples.len();
        
        while i < window_len {
            let val = window_samples[i].abs();
            if val >= limit {
                let mut j = i + 1;
                while j < window_len && window_samples[j].abs() >= limit && (window_samples[j].abs() - val).abs() <= tolerance {
                    j += 1;
                }
                
                let count = j - i;
                // Si hay 2 o más muestras consecutivas (meseta plana), es clipping
                if count >= 2 {
                    let candidate_start = start_idx + i;
                    let candidate_end = start_idx + j;
                    
                    if let Some(start) = region_start {
                        if candidate_start.saturating_sub(region_end) <= gap_samples {
                            // El gap es menor o igual al tolerado -> extender región_actual
                            region_end = candidate_end;
                            if val > region_max_val {
                                region_max_val = val;
                                region_direction = if window_samples[i] > 0.0 { 1 } else { -1 };
                            }
                        } else {
                            // El gap es superado -> emitir evento consolidado
                            events.push(GlitchEvent {
                                sample_index: start,
                                time_secs: start as f64 / sample_rate as f64,
                                amplitude_delta: region_max_val,
                                direction: region_direction,
                                event_type: GlitchType::Distortion,
                                repaired: false,
                                frequency: None,
                                channel: 0,
                                duration_samples: Some(region_end - start),
                            });
                            
                            // Iniciar nueva región
                            region_start = Some(candidate_start);
                            region_end = candidate_end;
                            region_max_val = val;
                            region_direction = if window_samples[i] > 0.0 { 1 } else { -1 };
                        }
                    } else {
                        // Primera región
                        region_start = Some(candidate_start);
                        region_end = candidate_end;
                        region_max_val = val;
                        region_direction = if window_samples[i] > 0.0 { 1 } else { -1 };
                    }
                    
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
        
        start_idx += window_size;
    }
    
    // Emitir la última región si quedó abierta
    if let Some(start) = region_start {
        events.push(GlitchEvent {
            sample_index: start,
            time_secs: start as f64 / sample_rate as f64,
            amplitude_delta: region_max_val,
            direction: region_direction,
            event_type: GlitchType::Distortion,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(region_end - start),
        });
    }
    
    events
}

/// Detector de caídas de señal/dropouts (Dominio Temporal)
pub fn detectar_dropouts(
    _features: &[FrameFeatures],
    samples: &[f32],
    sample_rate: u32,
    sensitivity: f32,
    global_rms: f32,
) -> Vec<GlitchEvent> {
    let mut events = Vec::new();
    let n_samples = samples.len();

    // Ventanas temporales
    let block_len = ((sample_rate as f32 * 0.0025).round() as usize).max(8); // 2.5 ms
    let step_size = ((sample_rate as f32 * 0.0010).round() as usize).max(4); // 1.0 ms
    let context_len = ((sample_rate as f32 * 0.150).round() as usize).max(100); // 150 ms

    if n_samples < context_len + block_len {
        return events;
    }

    // Calcular suma acumulada de cuadrados para consulta O(1) de RMS
    let mut sq_sum = vec![0.0f64; n_samples + 1];
    for i in 0..n_samples {
        sq_sum[i + 1] = sq_sum[i] + (samples[i] as f64) * (samples[i] as f64);
    }

    let drop_ratio_threshold = 0.03 + (sensitivity * 0.07); // 3% a 10% de caída relativa
    let mut inside_dropout = false;
    let mut start_idx = 0;

    let mut i = context_len;
    while i < n_samples - block_len {
        // Contexto: Ventana precedente de 150 ms
        let context_start = i.saturating_sub(context_len);
        let context_end = i;
        let context_samples = context_end - context_start;
        let context_rms = if context_samples > 0 {
            ((sq_sum[context_end] - sq_sum[context_start]) / context_samples as f64).sqrt() as f32
        } else {
            0.0
        };

        // Bloque actual: Ventana de 2.5 ms
        let block_start = i;
        let block_end = i + block_len;
        let block_rms = ((sq_sum[block_end] - sq_sum[block_start]) / block_len as f64).sqrt() as f32;

        // Comprobación de silencio legítimo en el contexto
        let is_active_region = context_rms > global_rms * 0.10 && context_rms > 0.0025;

        // Condición de caída abrupta profunda
        let is_dropout_block = is_active_region 
            && block_rms < context_rms * drop_ratio_threshold 
            && block_rms < 0.001;

        if is_dropout_block {
            if !inside_dropout {
                inside_dropout = true;
                start_idx = block_start;
            }
        } else {
            if inside_dropout {
                inside_dropout = false;
                let end_idx = block_start;
                let duration_samples = end_idx - start_idx;
                let duration_ms = (duration_samples as f32 * 1000.0) / sample_rate as f32;

                if duration_ms >= 4.0 && duration_ms <= 150.0 {
                    events.push(GlitchEvent {
                        sample_index: start_idx,
                        time_secs: start_idx as f64 / sample_rate as f64,
                        amplitude_delta: context_rms - block_rms,
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

        i += step_size;
    }

    // Manejar caso si el archivo termina dentro del dropout
    if inside_dropout {
        let end_idx = n_samples;
        let duration_samples = end_idx - start_idx;
        let duration_ms = (duration_samples as f32 * 1000.0) / sample_rate as f32;
        
        let guard_band_samples = (sample_rate as f32 * 0.150).round() as usize;
        let samples_to_eof = n_samples - start_idx;

        if samples_to_eof > guard_band_samples && duration_ms >= 4.0 && duration_ms <= 150.0 {
            let context_start = start_idx.saturating_sub(context_len);
            let context_end = start_idx;
            let context_samples = context_end - context_start;
            let context_rms = if context_samples > 0 {
                ((sq_sum[context_end] - sq_sum[context_start]) / context_samples as f64).sqrt() as f32
            } else {
                0.1
            };

            events.push(GlitchEvent {
                sample_index: start_idx,
                time_secs: start_idx as f64 / sample_rate as f64,
                amplitude_delta: context_rms,
                direction: -1,
                event_type: GlitchType::Dropout,
                repaired: false,
                frequency: None,
                channel: 0,
                duration_samples: Some(duration_samples),
            });
        }
    }

    events
}

/// Detector de Hum electromagnético (50/60 Hz + Armónicos en Dominio Espectral)
pub fn detectar_hum(
    _features: &[FrameFeatures],
    stft: &StftResult,
    sample_rate: u32,
    sensitivity: f32,
    audio_mode: AudioMode,
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

    // [EXP-HUM-02] peak_threshold elevado de [1.2x–2.0x] a [3.0x–6.0x].
    // Justificación: Un hum electromagnético real (sinusoide pura, Hann) supera en
    // 8x–20x a sus vecinos espectrales. El contenido musical en bajos raramente supera
    // 3x–4x. El umbral anterior (mín 1.2x = +1.6 dB) era indistinguible del ruido musical.
    // Nuevo rango: 3.0x (+9.5 dB) a 6.0x (+15.6 dB) sobre vecinos.
    let peak_threshold = 6.0 - (sensitivity * 3.0);

    let mut frame_hum_data = vec![None; num_frames];

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
                    freq_found = Some((freq, val));
                    break;
                }
            }
        }
        frame_hum_data[t] = freq_found;
    }

    // Agrupamos frames continuos con Hum detectado para crear eventos de rango temporal
    let hop_size = 1024;
    let mut inside_hum = false;
    let mut start_frame = 0;
    let mut gap_counter = 0;
    let gap_tolerance = 15; // [EXP-HUM-01] Reducido de 120 a 15 frames (~348ms). Hipótesis: gap_tolerance excesivo era la causa principal de eventos inflados hasta la duración total del archivo.
    let mut current_freq = None;
    let mut mags_history = Vec::new();

    for t in 0..num_frames {
        if let Some((f, mag)) = frame_hum_data[t] {
            if !inside_hum {
                inside_hum = true;
                start_frame = t;
                current_freq = Some(f);
                mags_history.clear();
            }
            mags_history.push(mag);
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
                        // [EXP-HUM-03] Filtro de estabilidad frecuencial para voz
                        let mut reject_hum = false;
                        if audio_mode == AudioMode::Voice && !mags_history.is_empty() {
                            let max_mag = mags_history.iter().copied().fold(0.0f32, f32::max);
                            let min_mag = mags_history.iter().copied().fold(f32::MAX, f32::min);
                            // La voz varía su amplitud naturalmente (vibrato/dinámica). 
                            // Un hum real es estático.
                            let stability_ratio = if max_mag > 0.0 { min_mag / max_mag } else { 0.0 };
                            let required_stability = 0.25 + (sensitivity * 0.15); // Exigir 25% a 40% de estabilidad mínima
                            if stability_ratio < required_stability {
                                reject_hum = true; // Demasiada variación, es una vocal, no ruido eléctrico
                            }
                        }

                        if !reject_hum {
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
    }

    // Asegurar la inserción si el Hum llega al final del archivo
    if inside_hum {
        let actual_end = num_frames.saturating_sub(gap_counter);
        if actual_end > start_frame {
            let duration_frames = actual_end - start_frame;
            if duration_frames >= 70 {
                let mut reject_hum = false;
                if audio_mode == AudioMode::Voice && !mags_history.is_empty() {
                    let max_mag = mags_history.iter().copied().fold(0.0f32, f32::max);
                    let min_mag = mags_history.iter().copied().fold(f32::MAX, f32::min);
                    let stability_ratio = if max_mag > 0.0 { min_mag / max_mag } else { 0.0 };
                    let required_stability = 0.25 + (sensitivity * 0.15);
                    if stability_ratio < required_stability {
                        reject_hum = true;
                    }
                }

                if !reject_hum {
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
    let gap_tolerance = 30; // Hiss tolera hasta ~696ms de enmascaramiento para consolidar el siseo constante

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
                let mut c = detectar_clicks(&features, stft, &audio.samples, audio.sample_rate, params.sensitivity, mode.clone());
                let mut p = detectar_pops(&features, stft, audio.sample_rate, global_rms, params.sensitivity, mode);
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
                                let mode = params.audio_mode.clone().unwrap_or(AudioMode::Music);
                                detectar_hum(&features, stft, audio.sample_rate, params.sensitivity, mode)
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
    let clipping_margin = 4096; // 92ms para absorber precursores de saturación masiva

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
                if idx >= dist_start.saturating_sub(clipping_margin) && idx <= dist_end + clipping_margin {
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
            
            let is_compatible_type = if (current.event_type == GlitchType::Click || current.event_type == GlitchType::Pop) 
                && (other.event_type == GlitchType::Click || other.event_type == GlitchType::Pop) {
                true
            } else {
                other.event_type == current.event_type
            };

            let is_cross_channel = other.channel != current.channel;
            
            // Intra-channel Click/Pop consolidation: mismo canal, casi mismo tiempo, Click vs Pop
            let is_intra_channel_click_pop = other.channel == current.channel 
                && is_compatible_type 
                && current.event_type != other.event_type
                && (other.time_secs - current.time_secs).abs() < 0.005;

            if is_compatible_type && (is_cross_channel || is_intra_channel_click_pop) {
                let is_match = match current.event_type {
                    GlitchType::Hum | GlitchType::Hiss | GlitchType::Dropout => {
                        let current_start = current.sample_index;
                        let current_end = current_start + current.duration_samples.unwrap_or(0);
                        let other_start = other.sample_index;
                        let other_end = other_start + other.duration_samples.unwrap_or(0);
                        current_start.max(other_start) <= current_end.min(other_end)
                    }
                    _ => {
                        (other.time_secs - current.time_secs).abs() < threshold
                    }
                };

                if is_match {
                    found_match_idx = Some(j);
                    break;
                }
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
            
            if current.channel != other.channel {
                current.channel = 2; // Ambos
            }
            
            if current.event_type == GlitchType::Pop && other.event_type == GlitchType::Click {
                current.event_type = GlitchType::Click;
            }

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
        assert!(!filtered.iter().any(|e| e.sample_index == 1000)); // Click cercano filtrado
    }

    #[test]
    fn test_vos_17_y_25_consolidation() {
        // VOS-17: Pop preceding a Distortion by 48ms
        let pop_vos17 = GlitchEvent {
            sample_index: 1000,
            time_secs: 30.883,
            amplitude_delta: 0.5,
            direction: 1,
            event_type: GlitchType::Pop,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(2),
        };
        let dist_vos17 = GlitchEvent {
            sample_index: 1000 + 2000, // < 46ms later (margin is 2048)
            time_secs: 30.931,
            amplitude_delta: 0.8,
            direction: -1,
            event_type: GlitchType::Distortion,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(900),
        };
        let events = vec![pop_vos17, dist_vos17];
        let filtered = consolidar_y_correlacionar_contextualmente(events);
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].event_type, GlitchType::Distortion);

        // VOS-25: Click and Pop in different channels at same time
        let click_l = GlitchEvent {
            sample_index: 2000,
            time_secs: 59.746,
            amplitude_delta: 0.9,
            direction: 1,
            event_type: GlitchType::Click,
            repaired: false,
            frequency: None,
            channel: 0,
            duration_samples: Some(5),
        };
        let pop_r = GlitchEvent {
            sample_index: 2000,
            time_secs: 59.746,
            amplitude_delta: 0.8,
            direction: 1,
            event_type: GlitchType::Pop,
            repaired: false,
            frequency: None,
            channel: 1,
            duration_samples: Some(6),
        };
        let events2 = vec![click_l, pop_r];
        let consolidated = consolidar_canales_glitches(events2);
        assert_eq!(consolidated.len(), 1);
        assert_eq!(consolidated[0].event_type, GlitchType::Click);
        assert_eq!(consolidated[0].channel, 2);
    }

    #[test]
    fn test_forensic_gt032_and_vos17() {
        let path = std::path::Path::new("C:/Users/WLADI/Vostok Plugins/DesktopApps/Vostok Restoration V1/TestSamples/vozbajacalidad_DEGRADADO.wav");
        if !path.exists() {
            return;
        }
        let mut reader = hound::WavReader::open(path).unwrap();
        let spec = reader.spec();
        let interleaved: Vec<f32> = reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
        
        let mut samples_l = Vec::new();
        let mut samples_r = Vec::new();
        for i in (0..interleaved.len()).step_by(spec.channels as usize) {
            samples_l.push(interleaved[i]);
            if spec.channels > 1 {
                samples_r.push(interleaved[i+1]);
            }
        }
        
        let stft_l = compute_stft(&samples_l, 4096, 1024, "blackman-harris").unwrap();
        let stft_r = compute_stft(&samples_r, 4096, 1024, "blackman-harris").unwrap();
        
        let audio_l = AudioBuffer { samples: samples_l.clone(), sample_rate: spec.sample_rate, channels: 1, bit_depth: spec.bits_per_sample, duration_seconds: 0.0 };
        let audio_r = AudioBuffer { samples: samples_r.clone(), sample_rate: spec.sample_rate, channels: 1, bit_depth: spec.bits_per_sample, duration_seconds: 0.0 };
        
        let mut p = ScanParams { clicks: true, hum: false, hiss: false, dropouts: false, distortion: false, sensitivity: 0.0, audio_mode: Some(AudioMode::Voice) };
        let ev_l = ejecutar_analisis_dsp_mono(&audio_l, &stft_l, &p, 0);
        let ev_r = ejecutar_analisis_dsp_mono(&audio_r, &stft_r, &p, 1);
        
        println!("--- GT-032 (74.051s) ---");
        let mut gt032_events = Vec::new();
        for e in ev_l.iter().chain(ev_r.iter()) {
            if (e.time_secs - 74.051).abs() < 0.1 {
                println!("{:?} L{} t={:.3} d={:?}", e.event_type, e.channel, e.time_secs, e.duration_samples);
                gt032_events.push(e.clone());
            }
        }
        gt032_events.sort_by(|a, b| a.time_secs.partial_cmp(&b.time_secs).unwrap());
        let cons = consolidar_canales_glitches(gt032_events);
        for e in cons {
            println!("Consolidado: {:?} L{} t={:.3}", e.event_type, e.channel, e.time_secs);
        }

        println!("--- VOS-17 (30.883s) ---");
        p.distortion = true;
        p.clicks = false;
        let ev2_l = ejecutar_analisis_dsp_mono(&audio_l, &stft_l, &p, 0);
        let ev2_r = ejecutar_analisis_dsp_mono(&audio_r, &stft_r, &p, 1);
        
        for e in ev2_l.iter().chain(ev2_r.iter()) {
            if (e.time_secs - 30.9).abs() < 0.5 {
                println!("{:?} L{} t={:.3} idx={}", e.event_type, e.channel, e.time_secs, e.sample_index);
            }
        }
    }

    #[test]
    fn test_clipping_e2e_p17f() {
        let mut params = ScanParams {
            clicks: false,
            hum: false,
            hiss: false,
            dropouts: false,
            distortion: true,
            sensitivity: 0.0,
            audio_mode: Some(AudioMode::Voice),
        };
        
        let path = std::path::Path::new("C:/Users/WLADI/Vostok Plugins/DesktopApps/Vostok Restoration V1/TestSamples/vozbajacalidad_DEGRADADO.wav");
        if !path.exists() {
            println!("Test skipped, file not found: {:?}", path);
            return;
        }
        
        let mut reader = hound::WavReader::open(path).unwrap();
        let spec = reader.spec();
        let interleaved: Vec<f32> = reader.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect();
        let mut samples = Vec::new();
        for i in (0..interleaved.len()).step_by(spec.channels as usize) {
            samples.push(interleaved[i]);
        }
        
        let audio = AudioBuffer {
            samples,
            sample_rate: spec.sample_rate,
            channels: 1,
            bit_depth: spec.bits_per_sample,
            duration_seconds: 0.0,
        };
        let stft = compute_stft(&audio.samples, 4096, 1024, "blackman-harris").unwrap();
        
        let global_rms = 0.05;
        let features = extract_features(&audio, &stft, global_rms);
        
        println!("Running detectar_clicks...");
        let clicks = detectar_clicks(&features, &stft, &audio.samples, audio.sample_rate, 0.5, AudioMode::Voice);
        
        for c in clicks {
            if c.time_secs > 16.0 && c.time_secs < 16.3 {
                println!("FOUND CLICK: {:.3}s (idx {}) delta: {}", c.time_secs, c.sample_index, c.amplitude_delta);
            }
        }
    }
}
