use crate::vostok_dsp::types::*;
use crate::vostok_dsp::utils::*;

/// Representa el cambio de estado de un fragmento de audio modificado (para deshacer/rehacer)
#[derive(Debug, Clone)]
pub struct AudioHistoryState {
    pub channel: u16,
    pub glitch_sample_index: usize,
    pub start_sample: usize,
    pub old_samples: Vec<f32>,
    pub new_samples: Vec<f32>,
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