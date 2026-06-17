import re

with open("investigations/INV-003D/dsp_temp.rs", "r", encoding="utf-8") as f:
    content = f.read()

# Define the new detect_artifacts_dynamic function
new_func = """pub fn detect_artifacts_dynamic(
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
"""

pattern = r"pub fn detect_artifacts_dynamic\([^\{]*\{.*?^pub fn detect_pops_dynamic\("
new_content = re.sub(pattern, new_func + "\n\npub fn detect_pops_dynamic(", content, flags=re.MULTILINE | re.DOTALL)

with open("investigations/INV-003D/dsp_temp.rs", "w", encoding="utf-8") as f:
    f.write(new_content)

print("Done")
