use rayon::prelude::*;
use crate::vostok_dsp::types::*;
use crate::vostok_dsp::utils::*;
use crate::dsp::compute_stft;

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
}
