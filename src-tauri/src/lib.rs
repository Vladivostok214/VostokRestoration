pub mod dsp;
pub mod vostok_dsp;

use std::sync::Mutex;
use dsp::{AudioBuffer, StftResult, GlitchEvent, ViewportConfig, HermiteConfig, ScanParams, AudioHistoryState, GlitchType, update_stft_range_multichannel};
use rodio::Source;

/// Contenedor seguro para permitir que el OutputStream de rodio cruce hilos en Tauri.
/// Seguro dado que solo se almacena en el Mutex para mantener vivo el hilo de audio del hardware.
pub struct AudioStreamWrapper(pub rodio::OutputStream);
unsafe impl Send for AudioStreamWrapper {}
unsafe impl Sync for AudioStreamWrapper {}

/// Estado global administrado en la memoria RAM del backend de Tauri
#[derive(Default)]
pub struct AppState {
    /// Datos de audio PCM completos actualmente cargados
    pub audio: Mutex<Option<AudioBuffer>>,
    /// Matriz STFT completa calculada a partir de las muestras
    pub stft: Mutex<Option<StftResult>>,
    /// Stream nativo protegido con nuestro wrapper compatible con hilos seguros
    pub playback_stream: Mutex<Option<AudioStreamWrapper>>,
    /// Sink de reproducción de rodio (Send + Sync)
    pub playback_sink: Mutex<Option<rodio::Sink>>,
    /// Handle de salida de audio de rodio (Send + Sync)
    pub playback_handle: Mutex<Option<rodio::OutputStreamHandle>>,
    /// Pila para Deshacer (Undo Stack)
    pub undo_stack: Mutex<Vec<Vec<AudioHistoryState>>>,
    /// Pila para Rehacer (Redo Stack)
    pub redo_stack: Mutex<Vec<Vec<AudioHistoryState>>>,
    /// Versión actual del estado de audio para control de concurrencia
    pub audio_version: Mutex<u64>,
}

/// Metadatos iniciales del análisis de audio retornados al frontend
#[derive(Debug, Clone, serde::Serialize)]
pub struct InitialAnalysis {
    /// Lista de eventos de glitch detectados en el escaneo inicial
    pub glitches: Vec<GlitchEvent>,
    /// Frecuencia de muestreo (ej: 48000 Hz)
    pub sample_rate: u32,
    /// Cantidad de canales (normalmente mono/1 canal para análisis offline)
    pub channels: u16,
    /// Profundidad de bits original (ej: 16, 24, 32 bits)
    pub bit_depth: u16,
    /// Duración total del audio en segundos
    pub duration_seconds: f64,
    /// Total de frames espectrales calculados
    pub stft_frames: usize,
    /// Total de bins de frecuencia por frame
    pub stft_bins: usize,
    /// Envolvente de picos temporales para visualización vectorial superpuesta
    pub waveform_envelope: Vec<f32>,
    /// Versión del audio tras la carga
    pub audio_version: u64,
}

/// Comando Tauri: Carga un archivo de audio y calcula el plano espectral inicial.
#[tauri::command]
fn cargar_y_analizar_archivo(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<InitialAnalysis, String> {
    let app = state.inner();
    if let Some(sink) = app.playback_sink.lock().unwrap().take() {
        sink.stop();
    }

    let clean_path = path.trim_matches('"').trim();
    let audio_buf = dsp::decode_audio_file(std::path::Path::new(clean_path))?;

    // SOTA: Devolvemos un vector vacío de inmediato (Carga diferida / Lazy Analysis)
    let glitches = vec![]; 

    let stft_res = dsp::compute_stft_multichannel(&audio_buf.samples, audio_buf.channels, 4096, 1024, "blackman-harris")?;
    let stft_frames = stft_res.num_frames;
    let stft_bins = stft_res.num_bins;

    // Calcular envolvente de picos temporales de 1000 puntos para la UI overlay
    let env_size = 1000;
    let chunk_size = (audio_buf.samples.len() / env_size).max(1);
    let mut waveform_envelope = Vec::with_capacity(env_size);
    for chunk in audio_buf.samples.chunks(chunk_size) {
        let max_val = chunk.iter().map(|&s| s.abs()).fold(0.0f32, |a, b| a.max(b));
        waveform_envelope.push(max_val);
    }

    *app.audio.lock().unwrap() = Some(audio_buf.clone());
    *app.stft.lock().unwrap() = Some(stft_res);
    app.undo_stack.lock().unwrap().clear();
    app.redo_stack.lock().unwrap().clear();
    
    let mut version = app.audio_version.lock().unwrap();
    *version += 1;
    let current_version = *version;

    Ok(InitialAnalysis {
        glitches,
        sample_rate: audio_buf.sample_rate,
        channels: audio_buf.channels,
        bit_depth: audio_buf.bit_depth,
        duration_seconds: audio_buf.duration_seconds,
        stft_frames,
        stft_bins,
        waveform_envelope,
        audio_version: current_version,
    })
}

/// Comando Tauri: Obtiene la porción del espectrograma visible en el viewport.
#[tauri::command]
fn obtener_espectrograma_visible(
    config: ViewportConfig,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let app = state.inner();
    let audio_version = *app.audio_version.lock().unwrap();
    let stft_lock = app.stft.lock().unwrap();
    if let Some(ref stft) = *stft_lock {
        Ok(dsp::stft_to_binary(&dsp::get_paged_spectrogram(stft, &config), audio_version))
    } else {
        Err("No hay ninguna matriz espectral cargada en memoria. Carga un archivo primero.".to_string())
    }
}

/// Comando Tauri: Obtiene un espectrograma dinámico con resolución adaptativa (FFT variable)
/// según el porcentaje de zoom visible.
#[tauri::command]
fn obtener_espectrograma_dinamico(
    view_start: f64,
    view_end: f64,
    max_width: usize,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let app = state.inner();
    let audio_version = *app.audio_version.lock().unwrap();
    let audio_lock = app.audio.lock().unwrap();
    let audio_buf = match &*audio_lock {
        Some(buf) => buf,
        None => return Err("No hay ningún audio cargado en memoria.".to_string()),
    };

    let n_samples = audio_buf.samples.len();
    let sample_rate = audio_buf.sample_rate as f64;

    // Mapear porcentajes a índices de muestras
    let start_sample = (view_start * n_samples as f64).round() as usize;
    let end_sample = (view_end * n_samples as f64).round() as usize;
    let start_sample = start_sample.min(n_samples);
    let end_sample = end_sample.min(n_samples).max(start_sample);

    let visible_samples = end_sample - start_sample;
    let visible_duration = visible_samples as f64 / sample_rate;

    // Determinar dinámicamente el tamaño de FFT y hop según la duración visible
    // para autoadaptar la resolución.
    let (fft_size, hop_size) = if visible_duration < 0.25 {
        (512, 128)
    } else if visible_duration < 1.0 {
        (1024, 256)
    } else if visible_duration < 4.0 {
        (2048, 512)
    } else {
        (4096, 1024)
    };

    let slice_samples = &audio_buf.samples[start_sample..end_sample];
    if (slice_samples.len() / audio_buf.channels as usize) < fft_size {
        // Fallback si la ventana es extremadamente pequeña
        let global_stft = app.stft.lock().unwrap();
        if let Some(ref stft) = *global_stft {
            let config = ViewportConfig {
                start_frame: (view_start * stft.num_frames as f64) as usize,
                end_frame: (view_end * stft.num_frames as f64) as usize,
                max_texture_width: max_width,
            };
            return Ok(dsp::stft_to_binary(&dsp::get_paged_spectrogram(stft, &config), audio_version));
        }
        return Err("Muestras insuficientes para computar la STFT local.".to_string());
    }

    // Calcular STFT local con el tamaño de FFT autoadaptado
    let stft_res = dsp::compute_stft_multichannel(slice_samples, audio_buf.channels, fft_size, hop_size, "blackman-harris")?;

    // Submuestrear al ancho máximo de textura de la GPU si es necesario
    let config = ViewportConfig {
        start_frame: 0,
        end_frame: stft_res.num_frames,
        max_texture_width: max_width,
    };
    let paged = dsp::get_paged_spectrogram(&stft_res, &config);
    Ok(dsp::stft_to_binary(&paged, audio_version))
}

/// Comando Tauri: Aplica una reparación de discontinuidades sobre el buffer cargado.
#[tauri::command]
fn aplicar_reparacion_quirurgica(
    glitches: Vec<GlitchEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let app = state.inner();
    let mut audio_lock = app.audio.lock().unwrap();
    let mut stft_lock = app.stft.lock().unwrap();

    if let Some(ref mut audio_buf) = *audio_lock {
        let noise_floor = 0.005;

        // Detener reproducción si está activa para liberar el sink con buffer antiguo
        if let Some(sink) = app.playback_sink.lock().unwrap().take() {
            sink.stop();
        }

        let history = dsp::heal_glitches_inplace_with_history(&mut audio_buf.samples, audio_buf.channels, &glitches, noise_floor, audio_buf.sample_rate, &dsp::HermiteConfig::default());
        if !history.is_empty() {
            app.undo_stack.lock().unwrap().push(history.clone());
            app.redo_stack.lock().unwrap().clear();

            if let Some(ref mut stft_res) = *stft_lock {
                let mut min_start = usize::MAX;
                let mut max_end = 0;
                for state in &history {
                    min_start = min_start.min(state.start_sample);
                    max_end = max_end.max(state.start_sample + state.new_samples.len());
                }

                if min_start < max_end {
                    let _ = update_stft_range_multichannel(
                        stft_res,
                        &audio_buf.samples,
                        audio_buf.channels,
                        min_start,
                        max_end,
                        4096,
                        1024,
                        "blackman-harris",
                    );
                }
            } else {
                let stft_res = dsp::compute_stft_multichannel(&audio_buf.samples, audio_buf.channels, 4096, 1024, "blackman-harris")?;
                *stft_lock = Some(stft_res);
            }
        }

        Ok("Audio reparado y plano espectral recalculado de forma exitosa.".to_string())
    } else {
        Err("No hay datos de audio en memoria sobre los cuales aplicar la reparación.".to_string())
    }
}

/// Comando Tauri: Aplica la reparación Hermite de glitches seleccionados y devuelve el espectrograma completo actualizado.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RepairResponse {
    pub spectrogram: Vec<u8>,
    pub waveform_envelope: Vec<f32>,
}

fn calcular_envolvente(samples: &[f32], env_size: usize) -> Vec<f32> {
    let chunk_size = (samples.len() / env_size).max(1);
    let mut waveform_envelope = Vec::with_capacity(env_size);
    for chunk in samples.chunks(chunk_size) {
        let max_val = chunk.iter().map(|&s| s.abs()).fold(0.0f32, |a, b| a.max(b));
        waveform_envelope.push(max_val);
    }
    waveform_envelope
}


/// Comando Tauri: Aplica la reparación Hermite de glitches seleccionados y devuelve el espectrograma completo, la envolvente y los glitches actualizados.
#[tauri::command]
fn reparar_glitches_seleccionados(
    glitches_to_repair: Vec<GlitchEvent>,
    mut all_glitches: Vec<GlitchEvent>,
    config: HermiteConfig,
    is_selection: Option<bool>,
    sensitivity: Option<f32>,
    state: tauri::State<'_, AppState>,
) -> Result<UndoRedoResponse, String> {
    let _ = sensitivity; // Ignoramos explícitamente el parámetro para silenciar el warning sin romper la firma Tauri
    let app = state.inner();
    let mut audio_lock = app.audio.lock().unwrap();
    let mut stft_lock = app.stft.lock().unwrap();

    if let Some(ref mut audio_buf) = *audio_lock {
        let noise_floor = 0.005;

        // Detener reproducción si está activa para liberar el sink con buffer antiguo
        if let Some(sink) = app.playback_sink.lock().unwrap().take() {
            sink.stop();
        }

        let mut repaired_events = Vec::new();
        let mut newly_detected_count = 0;

        if is_selection.unwrap_or(false) && !glitches_to_repair.is_empty() {
            // --- MODO RESTAURACIÓN QUIRÚRGICA: ANALIZAR Y DETECTAR DENTRO DEL RANGO ---
            let selection_event = &glitches_to_repair[0];
            let start_sample = selection_event.sample_index;
            let duration_samples = selection_event.duration_samples.unwrap_or(0);
            let end_sample = start_sample + duration_samples;

            println!(
                "[TAURI reparar_glitches_seleccionados] Selección Manual Recibida. Rango: [{} - {}], Tipo: {:?}, Canales Totales: {}",
                start_sample, end_sample, selection_event.event_type, audio_buf.channels
            );

            // En Modo Quirúrgico, NO corremos el detector automático. Confiamos 100% en la caja del usuario.
            // Pasamos directamente a aplicar la reparación forzada sobre el rango exacto (antiguo fallback).
            let mut selection_history = Vec::new();

                // --- MECANISMO DE FALLBACK ---
                if selection_event.event_type == GlitchType::Click 
                    || selection_event.event_type == GlitchType::Pop 
                    || selection_event.event_type == GlitchType::Dropout
                    || selection_event.event_type == GlitchType::Slip 
                {
                    // FALLBACK TRANSITORIOS (Clicks/Pops): Buscar el pico de derivada en cada canal y repararlo quirúrgicamente
                    for c in 0..audio_buf.channels {
                        let n_channels = audio_buf.channels as usize;
                        let chan_samples: Vec<f32> = audio_buf.samples.iter().skip(c as usize).step_by(n_channels).cloned().collect();
                        let search_start = start_sample.max(1);
                        let search_end = end_sample.min(chan_samples.len());
                        
                        let mut max_delta = 0.0f32;
                        let mut peak_sample_idx = None;
                        
                        for i in search_start..search_end {
                            let delta = (chan_samples[i] - chan_samples[i - 1]).abs();
                            if delta > max_delta {
                                max_delta = delta;
                                peak_sample_idx = Some(i);
                            }
                        }
                        
                        if let Some(peak_idx) = peak_sample_idx {
                            if max_delta > 0.001 {
                                println!(
                                    "[TAURI reparar_glitches_seleccionados] Fallback: Pico transitorio encontrado en Ch {} muestra {} con delta {}",
                                    c, peak_idx, max_delta
                                );
                                
                                let fallback_event = GlitchEvent {
                                    sample_index: peak_idx,
                                    time_secs: peak_idx as f64 / audio_buf.sample_rate as f64,
                                    amplitude_delta: max_delta,
                                    direction: if chan_samples[peak_idx] > chan_samples[peak_idx - 1] { 1 } else { -1 },
                                    event_type: selection_event.event_type.clone(),
                                    repaired: false,
                                    frequency: None,
                                    channel: c,
                                    duration_samples: Some((search_end - search_start).max(4)),
                                };
                                
                                let history = dsp::heal_glitches_inplace_with_history(
                                    &mut audio_buf.samples,
                                    audio_buf.channels,
                                    &[fallback_event.clone()],
                                    noise_floor,
                                    audio_buf.sample_rate,
                                    &config,
                                );
                                
                                selection_history.extend(history);
                                
                                let mut repaired_g = fallback_event;
                                repaired_g.repaired = true;
                                
                                if !all_glitches.iter().any(|item| item.channel == repaired_g.channel && item.sample_index == repaired_g.sample_index) {
                                    all_glitches.push(repaired_g.clone());
                                }
                                
                                repaired_events.push(repaired_g);
                            }
                        }
                    }
                } else if selection_event.event_type == GlitchType::Distortion {
                    // FALLBACK DISTORTION: Buscar picos planos (flat-topped) de cualquier amplitud dentro de la selección
                    let n_channels = audio_buf.channels as usize;
                    for c in 0..audio_buf.channels {
                        let mut chan_samples: Vec<f32> = audio_buf.samples.iter().skip(c as usize).step_by(n_channels).cloned().collect();
                        let search_start = start_sample.max(2);
                        let search_end = end_sample.min(chan_samples.len() - 3);
                        
                        let mut i = search_start;
                        let mut channel_repaired = false;
                        
                        while i < search_end {
                            let val = chan_samples[i].abs();
                            if val > 0.1 { // Evitar silencios
                                let mut j = i + 1;
                                while j < search_end && (chan_samples[j] - chan_samples[i]).abs() < 1e-4 {
                                    j += 1;
                                }
                                
                                let run_len = j - i;
                                if run_len >= 3 {
                                    let fallback_event = GlitchEvent {
                                        sample_index: i,
                                        time_secs: i as f64 / audio_buf.sample_rate as f64,
                                        amplitude_delta: val,
                                        direction: if chan_samples[i] > 0.0 { 1 } else { -1 },
                                        event_type: GlitchType::Distortion,
                                        repaired: false,
                                        frequency: None,
                                        channel: c,
                                        duration_samples: Some(run_len),
                                    };
                                    
                                    let (start, end) = dsp::heal_distortion_hermite(&mut chan_samples, &fallback_event);
                                    
                                    if start < chan_samples.len() && end < chan_samples.len() && start <= end {
                                        let old_chan_samples: Vec<f32> = audio_buf.samples.iter().skip(c as usize).step_by(n_channels).cloned().collect();
                                        selection_history.push(AudioHistoryState {
                                            channel: c,
                                            glitch_sample_index: i,
                                            start_sample: start,
                                            old_samples: old_chan_samples[start..=end].to_vec(),
                                            new_samples: chan_samples[start..=end].to_vec(),
                                        });
                                        channel_repaired = true;
                                    }
                                    
                                    let mut repaired_g = fallback_event;
                                    repaired_g.repaired = true;
                                    if !all_glitches.iter().any(|item| item.channel == repaired_g.channel && item.sample_index == repaired_g.sample_index) {
                                        all_glitches.push(repaired_g.clone());
                                    }
                                    repaired_events.push(repaired_g);
                                    
                                    i = j;
                                    continue;
                                }
                            }
                            i += 1;
                        }
                        
                        if channel_repaired {
                            for (idx, &val) in chan_samples.iter().enumerate() {
                                audio_buf.samples[idx * n_channels + c as usize] = val;
                            }
                        }
                    }
                } else {
                    // FALLBACK CONTINUOS (Hum/Hiss): Aplicar el filtro/proceso sobre todo el rango en todos los canales
                    for c in 0..audio_buf.channels {
                        println!(
                            "[TAURI reparar_glitches_seleccionados] Fallback: Aplicando restauración continua en Ch {} sobre toda la selección ({} samples)",
                            c, duration_samples
                        );
                        
                        let fallback_event = GlitchEvent {
                            sample_index: start_sample,
                            time_secs: start_sample as f64 / audio_buf.sample_rate as f64,
                            amplitude_delta: selection_event.amplitude_delta,
                            direction: selection_event.direction,
                            event_type: selection_event.event_type.clone(),
                            repaired: false,
                            frequency: selection_event.frequency,
                            channel: c,
                            duration_samples: Some(duration_samples),
                        };
                        
                        let history = dsp::heal_glitches_inplace_with_history(
                            &mut audio_buf.samples,
                            audio_buf.channels,
                            &[fallback_event.clone()],
                            noise_floor,
                            audio_buf.sample_rate,
                            &config,
                        );
                        
                        selection_history.extend(history);
                        
                        let mut repaired_g = fallback_event;
                        repaired_g.repaired = true;
                        
                        if !all_glitches.iter().any(|item| item.channel == repaired_g.channel && item.sample_index == repaired_g.sample_index) {
                            all_glitches.push(repaired_g.clone());
                        }
                        
                        repaired_events.push(repaired_g);
                    }
                }

                if !selection_history.is_empty() {
                    app.undo_stack.lock().unwrap().push(selection_history);
                    app.redo_stack.lock().unwrap().clear();
                }
                newly_detected_count = repaired_events.len();
        } else {
            // --- MODO REPARACIÓN ESTÁNDAR: REPARAR DIRECTAMENTE LOS GLITCHES PASADOS ---
            let history = dsp::heal_glitches_inplace_with_history(&mut audio_buf.samples, audio_buf.channels, &glitches_to_repair, noise_floor, audio_buf.sample_rate, &config);
            if !history.is_empty() {
                app.undo_stack.lock().unwrap().push(history);
                app.redo_stack.lock().unwrap().clear();
            }

            // Actualizar el estado 'repaired' en all_glitches
            for r in &glitches_to_repair {
                for g in &mut all_glitches {
                    if g.channel == r.channel && g.sample_index == r.sample_index {
                        g.repaired = true;
                    }
                }
            }
        }

        // Si se reparó algo, actualizamos la STFT parcialmente
        let last_action = app.undo_stack.lock().unwrap().last().cloned();
        if let Some(action) = last_action {
            let mut min_start = usize::MAX;
            let mut max_end = 0;
            for state in &action {
                min_start = min_start.min(state.start_sample);
                max_end = max_end.max(state.start_sample + state.new_samples.len());
            }

            if let Some(ref mut stft_res) = *stft_lock {
                if min_start < max_end {
                    let _ = update_stft_range_multichannel(
                        stft_res,
                        &audio_buf.samples,
                        audio_buf.channels,
                        min_start,
                        max_end,
                        4096,
                        1024,
                        "blackman-harris",
                    );
                }
            } else {
                let full_stft = dsp::compute_stft_multichannel(&audio_buf.samples, audio_buf.channels, 4096, 1024, "blackman-harris")?;
                *stft_lock = Some(full_stft);
            }
        } else {
            let full_stft = dsp::compute_stft_multichannel(&audio_buf.samples, audio_buf.channels, 4096, 1024, "blackman-harris")?;
            *stft_lock = Some(full_stft);
        }

        let stft_res = stft_lock.as_ref().unwrap();

        // Incrementar versión de audio ANTES de serializar para que el espectrograma lleve la versión correcta
        let mut version = app.audio_version.lock().unwrap();
        *version += 1;
        let current_version = *version;

        // Generar espectrograma completo
        let full_viewport = ViewportConfig {
            start_frame: 0,
            end_frame: stft_res.num_frames,
            max_texture_width: 2048,
        };
        let paged_stft = dsp::get_paged_spectrogram(stft_res, &full_viewport);
        let spectrogram = dsp::stft_to_binary(&paged_stft, current_version);
        let waveform_envelope = calcular_envolvente(&audio_buf.samples, 1000);

        // Notificar en consola del backend la cantidad de glitches quirúrgicos reparados
        if is_selection.unwrap_or(false) {
            println!(
                "[TAURI reparar_glitches_seleccionados] Reparación finalizada. Clics corroborados y reparados: {}",
                newly_detected_count
            );
        }

        Ok(UndoRedoResponse {
            spectrogram,
            waveform_envelope,
            glitches: all_glitches,
            audio_version: current_version,
        })
    } else {
        Err("No hay datos de audio en memoria sobre los cuales aplicar la reparación.".to_string())
    }
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct UndoRedoResponse {
    pub spectrogram: Vec<u8>,
    pub glitches: Vec<GlitchEvent>,
    pub waveform_envelope: Vec<f32>,
    pub audio_version: u64,
}

/// Comando Tauri: Deshace la última acción de reparación
#[tauri::command]
fn deshacer_accion(
    mut glitches: Vec<GlitchEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<UndoRedoResponse, String> {
    let t_cmd = std::time::Instant::now();
    let app = state.inner();
    let mut undo_lock = app.undo_stack.lock().unwrap();
    let mut redo_lock = app.redo_stack.lock().unwrap();
    let mut audio_lock = app.audio.lock().unwrap();
    let mut stft_lock = app.stft.lock().unwrap();

    let action = undo_lock.pop().ok_or_else(|| "No hay acciones para deshacer.".to_string())?;

    if let Some(ref mut audio_buf) = *audio_lock {
        if let Some(sink) = app.playback_sink.lock().unwrap().take() {
            sink.stop();
        }

        let n_channels = audio_buf.channels as usize;

        // ETAPA 1: Aplicar muestras antiguas al buffer PCM
        let t1 = std::time::Instant::now();
        let mut total_samples_written = 0usize;
        for state in &action {
            let c = state.channel as usize;
            for g in &mut glitches {
                if (g.channel == state.channel || (g.channel == 2 && (state.channel == 0 || state.channel == 1))) && g.sample_index == state.glitch_sample_index {
                    g.repaired = false;
                }
            }
            for (i, &val) in state.old_samples.iter().enumerate() {
                let interleaved_idx = (state.start_sample + i) * n_channels + c;
                if interleaved_idx < audio_buf.samples.len() {
                    audio_buf.samples[interleaved_idx] = val;
                    total_samples_written += 1;
                }
            }
        }
        eprintln!("[PROF][UNDO] Etapa1_apply_samples | samples_written={} | elapsed={}µs",
            total_samples_written, t1.elapsed().as_micros());

        let mut min_start = usize::MAX;
        let mut max_end = 0;
        for state in &action {
            min_start = min_start.min(state.start_sample);
            max_end = max_end.max(state.start_sample + state.old_samples.len());
        }

        // ETAPA 2: update_stft_range_multichannel (ya instrumentado en stft.rs)
        if let Some(ref mut stft_res) = *stft_lock {
            if min_start < max_end {
                let _ = update_stft_range_multichannel(
                    stft_res,
                    &audio_buf.samples,
                    audio_buf.channels,
                    min_start,
                    max_end,
                    4096,
                    1024,
                    "blackman-harris",
                );
            }
        } else {
            let full_stft = dsp::compute_stft_multichannel(&audio_buf.samples, audio_buf.channels, 4096, 1024, "blackman-harris")?;
            *stft_lock = Some(full_stft);
        }

        let stft_res = stft_lock.as_ref().unwrap();
        redo_lock.push(action);

        let mut version = app.audio_version.lock().unwrap();
        *version += 1;
        let current_version = *version;

        // ETAPA 3: get_paged_spectrogram (ya instrumentado en stft.rs)
        let full_viewport = ViewportConfig {
            start_frame: 0,
            end_frame: stft_res.num_frames,
            max_texture_width: 2048,
        };
        let paged = dsp::get_paged_spectrogram(stft_res, &full_viewport);

        // ETAPA 4: stft_to_binary (ya instrumentado en io.rs)
        let spectrogram = dsp::stft_to_binary(&paged, current_version);

        // ETAPA 5: Envolvente
        let t5 = std::time::Instant::now();
        let waveform_envelope = calcular_envolvente(&audio_buf.samples, 1000);
        eprintln!("[PROF][UNDO] Etapa5_envelope | elapsed={}µs", t5.elapsed().as_micros());

        eprintln!("[PROF][UNDO] TOTAL_CMD | payload_bytes={} | elapsed={}µs",
            spectrogram.len(), t_cmd.elapsed().as_micros());

        Ok(UndoRedoResponse {
            spectrogram,
            glitches,
            waveform_envelope,
            audio_version: current_version,
        })
    } else {
        Err("No hay datos de audio en memoria.".to_string())
    }
}

/// Comando Tauri: Rehace la última acción deshecha
#[tauri::command]
fn rehacer_accion(
    mut glitches: Vec<GlitchEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<UndoRedoResponse, String> {
    let t_cmd = std::time::Instant::now();
    let app = state.inner();
    let mut undo_lock = app.undo_stack.lock().unwrap();
    let mut redo_lock = app.redo_stack.lock().unwrap();
    let mut audio_lock = app.audio.lock().unwrap();
    let mut stft_lock = app.stft.lock().unwrap();

    let action = redo_lock.pop().ok_or_else(|| "No hay acciones para rehacer.".to_string())?;

    if let Some(ref mut audio_buf) = *audio_lock {
        if let Some(sink) = app.playback_sink.lock().unwrap().take() {
            sink.stop();
        }

        let n_channels = audio_buf.channels as usize;

        // ETAPA 1: Aplicar muestras nuevas al buffer PCM
        let t1 = std::time::Instant::now();
        let mut total_samples_written = 0usize;
        for state in &action {
            let c = state.channel as usize;
            for g in &mut glitches {
                if (g.channel == state.channel || (g.channel == 2 && (state.channel == 0 || state.channel == 1))) && g.sample_index == state.glitch_sample_index {
                    g.repaired = true;
                }
            }
            for (i, &val) in state.new_samples.iter().enumerate() {
                let interleaved_idx = (state.start_sample + i) * n_channels + c;
                if interleaved_idx < audio_buf.samples.len() {
                    audio_buf.samples[interleaved_idx] = val;
                    total_samples_written += 1;
                }
            }
        }
        eprintln!("[PROF][REDO] Etapa1_apply_samples | samples_written={} | elapsed={}µs",
            total_samples_written, t1.elapsed().as_micros());

        let mut min_start = usize::MAX;
        let mut max_end = 0;
        for state in &action {
            min_start = min_start.min(state.start_sample);
            max_end = max_end.max(state.start_sample + state.new_samples.len());
        }

        // ETAPA 2: update_stft_range_multichannel (ya instrumentado en stft.rs)
        if let Some(ref mut stft_res) = *stft_lock {
            if min_start < max_end {
                let _ = update_stft_range_multichannel(
                    stft_res,
                    &audio_buf.samples,
                    audio_buf.channels,
                    min_start,
                    max_end,
                    4096,
                    1024,
                    "blackman-harris",
                );
            }
        } else {
            let full_stft = dsp::compute_stft_multichannel(&audio_buf.samples, audio_buf.channels, 4096, 1024, "blackman-harris")?;
            *stft_lock = Some(full_stft);
        }

        let stft_res = stft_lock.as_ref().unwrap();
        undo_lock.push(action);

        let mut version = app.audio_version.lock().unwrap();
        *version += 1;
        let current_version = *version;

        // ETAPA 3: get_paged_spectrogram (ya instrumentado en stft.rs)
        let full_viewport = ViewportConfig {
            start_frame: 0,
            end_frame: stft_res.num_frames,
            max_texture_width: 2048,
        };
        let paged = dsp::get_paged_spectrogram(stft_res, &full_viewport);

        // ETAPA 4: stft_to_binary (ya instrumentado en io.rs)
        let spectrogram = dsp::stft_to_binary(&paged, current_version);

        // ETAPA 5: Envolvente
        let t5 = std::time::Instant::now();
        let waveform_envelope = calcular_envolvente(&audio_buf.samples, 1000);
        eprintln!("[PROF][REDO] Etapa5_envelope | elapsed={}µs", t5.elapsed().as_micros());

        eprintln!("[PROF][REDO] TOTAL_CMD | payload_bytes={} | elapsed={}µs",
            spectrogram.len(), t_cmd.elapsed().as_micros());

        Ok(UndoRedoResponse {
            spectrogram,
            glitches,
            waveform_envelope,
            audio_version: current_version,
        })
    } else {
        Err("No hay datos de audio en memoria.".to_string())
    }
}

/// Comando Tauri: Alterna la reproducción de audio, con capacidad de buscar (seek).
#[tauri::command]
fn toggle_playback(time_secs: Option<f64>, state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let app = state.inner();

    // Si se provee un tiempo, es una operación de 'seek'.
    // Debemos detener y descartar el sink actual para forzar la creación de uno nuevo.
    if time_secs.is_some() {
        if let Some(sink) = app.playback_sink.lock().unwrap().take() {
            sink.stop();
        }
    }

    let sink_lock = app.playback_sink.lock().unwrap();

    if let Some(ref sink) = *sink_lock {
        if sink.is_paused() {
            sink.play();
            Ok(true)
        } else {
            sink.pause();
            Ok(false)
        }
    } else {
        // Si no hay sink, es la primera reproducción o una operación de 'seek'.
        // Extraemos y clonamos los campos necesarios liberando el lock de audio inmediatamente al salir de este bloque.
        let (samples, channels, sample_rate) = {
            let audio_lock = app.audio.lock().unwrap();
            match &*audio_lock {
                Some(buf) => (buf.samples.clone(), buf.channels, buf.sample_rate),
                None => return Err("No hay ningún audio cargado en memoria para preescuchar.".to_string()),
            }
        };
        
        // Liberamos el lock de sink antes de iniciar la reproducción para evitar deadlocks
        drop(sink_lock);
        iniciar_reproduccion_interna(samples, channels, sample_rate, time_secs, app)
    }
}


/// Helper para inicializar el sink y el stream de rodio en la reproducción
fn iniciar_reproduccion_interna(
    samples: Vec<f32>,
    channels: u16,
    sample_rate: u32,
    time_secs: Option<f64>,
    state: &AppState,
) -> Result<bool, String> {
    let mut handle_lock = state.playback_handle.lock().unwrap();

    if handle_lock.is_none() {
        let (stream, stream_handle) = rodio::OutputStream::try_default()
            .map_err(|e| format!("Dispositivo de salida de audio no disponible: {}. Conecta un altavoz o auriculares.", e))?;
        *state.playback_stream.lock().unwrap() = Some(AudioStreamWrapper(stream));
        *handle_lock = Some(stream_handle);
    }
    
    let handle = handle_lock.as_ref().unwrap();
    let sink = match rodio::Sink::try_new(handle) {
        Ok(s) => s,
        Err(e) => {
            println!("[TAURI iniciar_reproduccion_interna] Fallo al instanciar Sink sobre el handle existente: {}. Recreando stream.", e);
            // Liberar stream anterior muerto
            *state.playback_stream.lock().unwrap() = None;
            
            // Reintentar abrir el dispositivo por defecto
            match rodio::OutputStream::try_default() {
                Ok((stream, stream_handle)) => {
                    *state.playback_stream.lock().unwrap() = Some(AudioStreamWrapper(stream));
                    *handle_lock = Some(stream_handle);
                    
                    let handle_new = handle_lock.as_ref().unwrap();
                    match rodio::Sink::try_new(handle_new) {
                        Ok(s) => s,
                        Err(err_sink) => {
                            *handle_lock = None;
                            *state.playback_stream.lock().unwrap() = None;
                            return Err(format!("Dispositivo restablecido, pero falló la creación del Sink: {}", err_sink));
                        }
                    }
                }
                Err(err_stream) => {
                    *handle_lock = None;
                    *state.playback_stream.lock().unwrap() = None;
                    return Err(format!("Dispositivo de salida no disponible tras reconexión: {}", err_stream));
                }
            }
        }
    };

    let source_buffer = rodio::buffer::SamplesBuffer::new(
        channels,
        sample_rate,
        samples,
    );

    if let Some(start_time) = time_secs {
        let source_with_seek = source_buffer.skip_duration(std::time::Duration::from_secs_f64(start_time));
        sink.append(source_with_seek.convert_samples::<f32>());
    } else {
        sink.append(source_buffer.convert_samples::<f32>());
    }
    
    sink.play();
    *state.playback_sink.lock().unwrap() = Some(sink);
    Ok(true)
}

/// Comando Tauri: Detiene la reproducción en curso y libera los recursos de audio.
#[tauri::command]
fn stop_playback(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let app = state.inner();
    if let Some(sink) = app.playback_sink.lock().unwrap().take() {
        sink.stop();
    }
    Ok(())
}

/// Comando Tauri: Exporta el archivo de audio sanado a un archivo WAV PCM nativo.
#[tauri::command]
fn export_repaired_file(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let app = state.inner();
    let audio_lock = app.audio.lock().unwrap();
    if let Some(ref audio_buf) = *audio_lock {
        let clean_path = path.trim_matches('"').trim();
        
        dsp::export_repaired_wav(
            std::path::Path::new(clean_path),
            &audio_buf.samples,
            audio_buf.sample_rate,
            audio_buf.channels,
            audio_buf.bit_depth,
        )?;
        
        Ok(format!("Archivo exportado con éxito en: {}", clean_path))
    } else {
        Err("No hay datos de audio en memoria para exportar.".to_string())
    }
}

/// Comando Tauri: Ejecuta el análisis avanzado de glitches bajo demanda usando múltiples dominios en paralelo
#[tauri::command]
fn ejecutar_analisis_avanzado(
    params: ScanParams,
    loop_start: Option<f64>,
    loop_end: Option<f64>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<GlitchEvent>, String> {
    let app = state.inner();
    let audio_lock = app.audio.lock().unwrap();
    let stft_lock = app.stft.lock().unwrap();
    
    if let (Some(ref audio_buf), Some(ref stft_res)) = (&*audio_lock, &*stft_lock) {
        let mut glitches = dsp::ejecutar_analisis_dsp(audio_buf, stft_res, &params);
        if let Some(start) = loop_start {
            glitches.retain(|g| g.time_secs >= start);
        }
        if let Some(end) = loop_end {
            glitches.retain(|g| g.time_secs <= end);
        }
        Ok(glitches)
    } else {
        Err("No hay audio o plano espectral cargado en memoria para escanear.".to_string())
    }
}

/// Comando Tauri: Escribe en el disco el archivo de reporte generado por el inspector
#[tauri::command]
fn guardar_reporte_auditoria(path: String, content: String) -> Result<(), String> {
    let clean_path = path.trim_matches('"').trim();
    std::fs::write(std::path::Path::new(clean_path), content)
        .map_err(|e| format!("No se pudo escribir el archivo de reporte de auditoría: {}", e))?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            cargar_y_analizar_archivo,
            obtener_espectrograma_visible,
            obtener_espectrograma_dinamico,
            aplicar_reparacion_quirurgica,
            reparar_glitches_seleccionados,
            toggle_playback,
            stop_playback,
            export_repaired_file,
            ejecutar_analisis_avanzado,
            guardar_reporte_auditoria,
            deshacer_accion,
            rehacer_accion
        ])
        .setup(|app| {
            app.handle().plugin(tauri_plugin_dialog::init())?;
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}