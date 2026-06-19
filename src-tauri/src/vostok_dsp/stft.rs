use realfft::RealFftPlanner;
use rayon::prelude::*;
use crate::vostok_dsp::types::*;

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



pub fn get_paged_spectrogram(
    stft: &StftResult,
    config: &ViewportConfig,
) -> StftResult {
    let t0 = std::time::Instant::now();
    let num_bins = stft.num_bins;
    let total_frames = stft.num_frames;

    let start = config.start_frame.min(total_frames);
    let end = config.end_frame.min(total_frames).max(start);
    let visible_frames_len = end - start;

    if visible_frames_len == 0 {
        eprintln!("[PROF] get_paged_spectrogram | mode=EMPTY | in_frames={} in_bins={} | elapsed={}µs",
            total_frames, num_bins, t0.elapsed().as_micros());
        return StftResult { matrix: Vec::new(), num_frames: 0, num_bins };
    }

    if visible_frames_len <= config.max_texture_width {
        let mut sub_matrix = vec![0.0; visible_frames_len * num_bins];
        let src_start_offset = start * num_bins;
        let src_end_offset = end * num_bins;
        sub_matrix.copy_from_slice(&stft.matrix[src_start_offset..src_end_offset]);
        let result = StftResult { matrix: sub_matrix, num_frames: visible_frames_len, num_bins };
        eprintln!("[PROF] get_paged_spectrogram | mode=SLICE | in={}x{} out={}x{} | input_mb={:.2} output_mb={:.2} | elapsed={}µs",
            total_frames, num_bins, result.num_frames, num_bins,
            (total_frames * num_bins * 4) as f64 / 1_048_576.0,
            (result.num_frames * num_bins * 4) as f64 / 1_048_576.0,
            t0.elapsed().as_micros());
        return result;
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

    let result = StftResult { matrix: downsampled_matrix, num_frames: target_width, num_bins };
    eprintln!("[PROF] get_paged_spectrogram | mode=DOWNSAMPLE | in={}x{} out={}x{} step={:.3} | input_mb={:.2} output_mb={:.2} | elapsed={}µs",
        total_frames, num_bins, result.num_frames, num_bins, step,
        (total_frames * num_bins * 4) as f64 / 1_048_576.0,
        (result.num_frames * num_bins * 4) as f64 / 1_048_576.0,
        t0.elapsed().as_micros());
    result
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
    let t0 = std::time::Instant::now();
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

    let affected_frames = f_end.saturating_sub(f_start) + 1;
    eprintln!("[PROF] update_stft_range_multichannel | channels={} | sample_range=[{}-{}] | frames_affected={} | total_frames={} | bins={} | elapsed={}µs",
        n_channels, start_sample, end_sample, affected_frames, stft.num_frames, num_bins,
        t0.elapsed().as_micros());
    Ok(())
}


#[cfg(test)]
mod tests {
    use super::*;
    use crate::vostok_dsp::detectors::consolidar_y_correlacionar_contextualmente;

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
