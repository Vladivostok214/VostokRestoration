import re

with open("C:/Users/WLADI/Vostok Plugins/vostok-apps-web/Vostok Restoration V1/src-tauri/src/dsp.rs", "r", encoding="utf-8") as f:
    content = f.read()

# 1. HFER Tuning: Relax the multiplier to let Clicks pass through Hiss
old_hfer = """    // Dynamic HFER multiplier
    let mut dynamic_hfer_multiplier = 3.0;
    if hiss_rms_avg > 0.005 {
        dynamic_hfer_multiplier = (3.0 - (hiss_rms_avg * 100.0)).max(1.5);
    }"""
new_hfer = """    // Dynamic HFER multiplier (Tuned for PROD-005 to survive heavy hiss)
    let mut dynamic_hfer_multiplier = 3.0;
    if hiss_rms_avg > 0.005 {
        dynamic_hfer_multiplier = (3.0 - (hiss_rms_avg * 80.0)).max(1.1); // More permissive to recover masked clicks
    }"""
content = content.replace(old_hfer, new_hfer)

# 2. Dropout Tuning: Ignore noise floor absolute constraint if decay is catastrophic
old_dropout = r"let is_dropping = decay_rate < -1500\.0 && rms < n_floor \* 0\.5 && prev_rms > 0\.002;\s*let is_very_low = rms < n_floor \* 0\.2;"
new_dropout = r"""let is_dropping = decay_rate < -1500.0 && (rms < n_floor * 0.5 || decay_rate < -2500.0) && prev_rms > 0.002;
            let is_very_low = rms < n_floor * 0.2 || (in_dropout && decay_rate < -100.0);"""
content = re.sub(old_dropout, new_dropout, content, flags=re.MULTILINE)

# 3. Local Dynamic Clipping Ceiling
# We replace the global hist calculation with a local sliding window.
old_clipping_logic = r"let mut hist = \[0usize; 1024\];.*?let clip_tol = 0\.015; // Suavizado para ruido"
new_clipping_logic = r"""// Sliding Window Dynamic Ceiling (2 seconds)
        let window_size_samples = (sample_rate * 2) as usize;
        let mut local_ceilings = Vec::with_capacity(end_sample - start_sample);
        
        let mut i_win = start_sample;
        while i_win < end_sample {
            let win_end = (i_win + window_size_samples).min(end_sample);
            let mut hist = [0usize; 1024];
            for &s in &samples[i_win..win_end] {
                let bin = ((s.abs() * 1023.0) as usize).min(1023);
                hist[bin] += 1;
            }
            
            let mut local_c = thresholds.clip_threshold;
            let win_len = (win_end - i_win) as f64;
            if win_len > 1000.0 {
                for bin in (512..1023).rev() {
                    if hist[bin] > (win_len * 0.0005) as usize {
                        let mut sum_above = 0;
                        for b in (bin + 1)..1024 { sum_above += hist[b]; }
                        if sum_above < (win_len * 0.00005) as usize {
                            local_c = bin as f32 / 1023.0;
                            break;
                        }
                    }
                }
            }
            for _ in i_win..win_end {
                local_ceilings.push(local_c.max(0.5));
            }
            i_win = win_end;
        }

        let clip_tol = 0.015; // Suavizado para ruido"""

content = re.sub(old_clipping_logic, new_clipping_logic, content, flags=re.MULTILINE | re.DOTALL)

# And update the while loop to use the local ceiling
old_while_clip = r"if val >= \(dynamic_ceiling - clip_tol\) \{.*?if \(smoothed_next - val\)\.abs\(\) < clip_tol && smoothed_next >= \(dynamic_ceiling - clip_tol\) \{"
new_while_clip = r"""let dyn_ceil = local_ceilings[i - start_sample];
            if val >= (dyn_ceil - clip_tol) {
                let mut count = 0;
                while i + count < end_sample - 1 {
                    let dyn_ceil_local = local_ceilings[i + count - start_sample];
                    let smoothed_next = (samples[i+count-1].abs() + samples[i+count].abs() + samples[i+count+1].abs()) / 3.0;
                    if (smoothed_next - val).abs() < clip_tol && smoothed_next >= (dyn_ceil_local - clip_tol) {"""
content = re.sub(old_while_clip, new_while_clip, content, flags=re.MULTILINE | re.DOTALL)

old_residual = r"let spline_residual_factor = \(delta_peak / dynamic_ceiling\)\.min\(1\.0\);"
new_residual = r"let spline_residual_factor = (delta_peak / local_ceilings[start_idx - start_sample]).min(1.0);"
content = content.replace(old_residual, new_residual)

with open("C:/Users/WLADI/Vostok Plugins/vostok-apps-web/Vostok Restoration V1/src-tauri/src/dsp.rs", "w", encoding="utf-8") as f:
    f.write(content)

print("Backend dsp.rs calibrated.")
