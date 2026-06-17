pub mod dsp;

use std::sync::{Mutex, Arc};
use dsp::{AudioBuffer, AnalyticalSpectrogram, AnalyticalRegionRequest, GlitchEvent, ViewportConfig};

/// Wrapper seguro para forzar Send + Sync sobre el OutputStream de rodio (necesario en Windows/WASAPI)
pub struct SafeOutputStream(pub rodio::OutputStream);
unsafe impl Send for SafeOutputStream {}
unsafe impl Sync for SafeOutputStream {}

/// Estado global administrado en la memoria RAM del backend de Tauri
#[derive(Default)]
pub struct AppState {
    /// Ruta del archivo cargado actualmente en memoria
    pub current_path: Mutex<Option<String>>,
    /// Datos de audio PCM completos actualmente cargados
    pub audio: Mutex<Option<Arc<AudioBuffer>>>,
    /// Matriz STFT completa calculada a partir de las muestras
    pub stft: Mutex<Option<Arc<AnalyticalSpectrogram>>>,
    /// Stream principal de rodio (Send + Sync)
    pub playback_stream: Mutex<Option<SafeOutputStream>>,
    /// Sink de reproducción de rodio (Send + Sync)
    pub playback_sink: Mutex<Option<rodio::Sink>>,
    /// Handle de salida de audio de rodio (Send + Sync)
    pub playback_handle: Mutex<Option<rodio::OutputStreamHandle>>,
}

/// Metadatos iniciales del análisis de audio retornados al frontend
#[derive(Debug, Clone, serde::Serialize)]
pub struct InitialAnalysis {
    /// Lista unificada de eventos segregados en el escaneo inicial
    pub glitches: dsp::DetectionResult,
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
    /// Umbral recomendado calculado dinámicamente según el noise floor del archivo
    pub recommended_threshold: f32,
}

/// Comando Tauri: Carga y analiza un archivo de audio con un umbral dinámico de glitching.
#[tauri::command]
async fn cargar_y_analizar_archivo(
    path: String,
    threshold: f32,
    profile: Option<dsp::ResolutionProfile>,
    state: tauri::State<'_, AppState>,
) -> Result<InitialAnalysis, String> {
    // 1. Limpiar comillas residuales y normalizar
    let clean_path = path.trim_matches('"').trim().to_string();

    // Comprobar si el archivo solicitado ya está cargado en memoria RAM
    let is_already_loaded = {
        let path_lock = state.current_path.lock().unwrap();
        let audio_lock = state.audio.lock().unwrap();
        path_lock.as_ref().map(|p| p == &clean_path).unwrap_or(false) && audio_lock.is_some()
    };

    if is_already_loaded {
        // Recuperar del estado RAM sin bloquear por mucho tiempo
        let audio_buf = {
            let audio_lock = state.audio.lock().unwrap();
            audio_lock.as_ref().unwrap().clone()
        };
        
        let (stft_frames, stft_bins) = {
            let stft_lock = state.stft.lock().unwrap();
            if let Some(ref stft) = *stft_lock {
                (stft.num_frames, stft.num_bins)
            } else {
                (0, 0)
            }
        };

        // Ejecutar cálculo ligero fuera de locks de Tokio usando spawn_blocking
        let res = tauri::async_runtime::spawn_blocking(move || {
            let noise_floor = dsp::estimate_noise_floor(&audio_buf.samples);
            let rec_threshold = if threshold < 0.0 {
                (noise_floor * 3.5).clamp(0.005, 0.25)
            } else {
                threshold
            };
            
            InitialAnalysis {
                glitches: dsp::DetectionResult { transients: Vec::new(), stationaries: Vec::new() },
                sample_rate: audio_buf.sample_rate,
                channels: audio_buf.channels,
                bit_depth: audio_buf.bit_depth,
                duration_seconds: audio_buf.duration_seconds,
                stft_frames,
                stft_bins,
                recommended_threshold: rec_threshold,
            }
        }).await.map_err(|e| e.to_string())?;

        return Ok(res);
    }

    // 0. Detener cualquier reproducción previa activa
    if let Some(sink) = {
        let mut sink_lock = state.playback_sink.lock().unwrap();
        sink_lock.take()
    } {
        sink.stop();
    }

    let cp = clean_path.clone();
    let res = tauri::async_runtime::spawn_blocking(move || {
        let audio_buf = dsp::decode_audio_file(std::path::Path::new(&cp))?;
        
        let noise_floor = dsp::estimate_noise_floor(&audio_buf.samples);
        let rec_threshold = if threshold < 0.0 {
            (noise_floor * 3.5).clamp(0.005, 0.25)
        } else {
            threshold
        };

        let (fft_size, hop_size) = match profile.unwrap_or(dsp::ResolutionProfile::HumMasteringMode) {
            dsp::ResolutionProfile::TransientMode => (1024, 256),
            dsp::ResolutionProfile::HumMasteringMode => (4096, 1024),
        };
        let stft_res = dsp::compute_stft(&audio_buf.samples, audio_buf.sample_rate, fft_size, hop_size, "hann")?;

        Ok::<(AudioBuffer, dsp::DetectionResult, AnalyticalSpectrogram, f32), String>((audio_buf, dsp::DetectionResult { transients: Vec::new(), stationaries: Vec::new() }, stft_res, rec_threshold))
    }).await.map_err(|e| e.to_string())?;

    let (audio_buf, glitches, stft_res, rec_threshold) = res?;

    let stft_frames = stft_res.num_frames;
    let stft_bins = stft_res.num_bins;
    let audio_buf_arc = Arc::new(audio_buf);

    {
        *state.audio.lock().unwrap() = Some(audio_buf_arc.clone());
    }
    {
        *state.stft.lock().unwrap() = Some(Arc::new(stft_res));
    }
    {
        *state.current_path.lock().unwrap() = Some(clean_path);
    }

    Ok(InitialAnalysis {
        glitches,
        sample_rate: audio_buf_arc.sample_rate,
        channels: audio_buf_arc.channels,
        bit_depth: audio_buf_arc.bit_depth,
        duration_seconds: audio_buf_arc.duration_seconds,
        stft_frames,
        stft_bins,
        recommended_threshold: rec_threshold,
    })
}

/// Comando Tauri: Obtiene la porción del espectrograma visible en el viewport.
#[tauri::command]
async fn obtener_espectrograma_visible(
    config: ViewportConfig,
    state: tauri::State<'_, AppState>,
) -> Result<dsp::PagedStftResult, String> {
    let stft = {
        let stft_lock = state.stft.lock().unwrap();
        if let Some(ref stft) = *stft_lock {
            stft.clone()
        } else {
            return Err("No hay ninguna matriz espectral cargada en memoria. Carga un archivo primero.".to_string());
        }
    };

    // Sub-muestreo se ejecuta de forma asíncrona bloqueante en hilo dedicado
    tauri::async_runtime::spawn_blocking(move || {
        dsp::get_paged_spectrogram(&stft, &config)
    }).await.map_err(|e| e.to_string())
}

/// Comando Tauri: Recalcula el espectrograma basado en un ResolutionProfile para el audio cargado.
#[tauri::command]
async fn calcular_espectrograma(
    profile: dsp::ResolutionProfile,
    state: tauri::State<'_, AppState>,
) -> Result<InitialAnalysis, String> {
    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        match &*audio_lock {
            Some(buf) => buf.clone(),
            None => return Err("No hay datos de audio cargados en memoria.".to_string()),
        }
    };

    let res = tauri::async_runtime::spawn_blocking(move || {
        let (fft_size, hop_size) = match profile {
            dsp::ResolutionProfile::TransientMode => (1024, 256),
            dsp::ResolutionProfile::HumMasteringMode => (4096, 1024),
        };
        
        let stft_res = dsp::compute_stft(&audio_buf.samples, audio_buf.sample_rate, fft_size, hop_size, "hann")?;
        
        let noise_floor = dsp::estimate_noise_floor(&audio_buf.samples);
        let rec_threshold = (noise_floor * 3.5).clamp(0.005, 0.25);
        let glitches = dsp::detect_glitches(&audio_buf.samples, rec_threshold, audio_buf.sample_rate);
        
        Ok::<(dsp::DetectionResult, AnalyticalSpectrogram, f32), String>((dsp::DetectionResult { transients: glitches, stationaries: Vec::new() }, stft_res, rec_threshold))
    }).await.map_err(|e| e.to_string())??;

    let (glitches, stft_res, rec_threshold) = res;
    let stft_frames = stft_res.num_frames;
    let stft_bins = stft_res.num_bins;

    *state.stft.lock().unwrap() = Some(Arc::new(stft_res));

    let audio_buf_ref = {
        let audio_lock = state.audio.lock().unwrap();
        audio_lock.as_ref().unwrap().clone()
    };

    Ok(InitialAnalysis {
        glitches,
        sample_rate: audio_buf_ref.sample_rate,
        channels: audio_buf_ref.channels,
        bit_depth: audio_buf_ref.bit_depth,
        duration_seconds: audio_buf_ref.duration_seconds,
        stft_frames,
        stft_bins,
        recommended_threshold: rec_threshold,
    })
}

/// Comando Tauri: Aplica una reparación de discontinuidades sobre el buffer cargado.
#[tauri::command]
async fn aplicar_reparacion_quirurgica(
    glitches: Vec<GlitchEvent>,
    profile: Option<dsp::ResolutionProfile>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut audio_arc = {
        let mut audio_lock = state.audio.lock().unwrap();
        if let Some(a) = audio_lock.take() {
            a
        } else {
            return Err("No hay datos de audio en memoria sobre los cuales aplicar la reparación.".to_string());
        }
    };

    let stft_res = tauri::async_runtime::spawn_blocking(move || {
        let noise_floor = 0.005;
        let updated_audio = Arc::make_mut(&mut audio_arc);
        dsp::heal_glitches(updated_audio, &glitches, noise_floor);
        let (fft_size, hop_size) = match profile.unwrap_or(dsp::ResolutionProfile::HumMasteringMode) {
            dsp::ResolutionProfile::TransientMode => (1024, 256),
            dsp::ResolutionProfile::HumMasteringMode => (4096, 1024),
        };
        let stft = dsp::compute_stft(&updated_audio.samples, updated_audio.sample_rate, fft_size, hop_size, "hann");
        (audio_arc, stft)
    }).await.map_err(|e| e.to_string())?;

    let (audio_arc, stft_res_result) = stft_res;
    let stft_res = stft_res_result?;

    *state.audio.lock().unwrap() = Some(audio_arc);
    *state.stft.lock().unwrap() = Some(Arc::new(stft_res));

    Ok("Audio reparado y plano espectral recalculado de forma exitosa.".to_string())
}

/// Comando Tauri: Ejecuta la reparación Hermite de glitches seleccionados y devuelve
/// la sub-matriz espectral optimizada para el viewport actual.
#[tauri::command]
async fn reparar_glitches_seleccionados(
    glitches: Vec<GlitchEvent>,
    config: ViewportConfig,
    profile: Option<dsp::ResolutionProfile>,
    state: tauri::State<'_, AppState>,
) -> Result<dsp::PagedStftResult, String> {
    let mut audio_arc = {
        let mut audio_lock = state.audio.lock().unwrap();
        if let Some(a) = audio_lock.take() {
            a
        } else {
            return Err("No hay datos de audio en memoria sobre los cuales aplicar la reparación.".to_string());
        }
    };

    let result = tauri::async_runtime::spawn_blocking(move || {
        let noise_floor = 0.005;
        let updated_audio = Arc::make_mut(&mut audio_arc);
        dsp::heal_glitches(updated_audio, &glitches, noise_floor);
        let (fft_size, hop_size) = match profile.unwrap_or(dsp::ResolutionProfile::HumMasteringMode) {
            dsp::ResolutionProfile::TransientMode => (1024, 256),
            dsp::ResolutionProfile::HumMasteringMode => (4096, 1024),
        };
        let stft_res = dsp::compute_stft(&updated_audio.samples, updated_audio.sample_rate, fft_size, hop_size, "hann")?;
        let paged = dsp::get_paged_spectrogram(&stft_res, &config);
        Ok::<(Arc<AudioBuffer>, AnalyticalSpectrogram, dsp::PagedStftResult), String>((audio_arc, stft_res, paged))
    }).await.map_err(|e| e.to_string())?;

    let (audio_arc, stft_res, paged) = result?;

    *state.audio.lock().unwrap() = Some(audio_arc);
    *state.stft.lock().unwrap() = Some(Arc::new(stft_res));

    Ok(paged)
}

/// Helper para inicializar el sink y el stream de rodio en la reproducción
fn iniciar_reproduccion_interna(
    audio_buf: &AudioBuffer,
    state: &AppState,
) -> Result<bool, String> {
    let mut handle_lock = state.playback_handle.lock().unwrap();

    // 1. Intentar reproducir usando el handle guardado si existe
    if let Some(ref handle) = *handle_lock {
        match rodio::Sink::try_new(handle) {
            Ok(sink) => {
                let source = rodio::buffer::SamplesBuffer::new(
                    audio_buf.channels,
                    audio_buf.sample_rate,
                    audio_buf.samples.clone(),
                );
                sink.append(source);
                sink.play();
                *state.playback_sink.lock().unwrap() = Some(sink);
                return Ok(true);
            }
            Err(_) => {
                // El dispositivo asociado al handle anterior ya no está disponible
                // Limpiamos el handle para forzar una reinicialización del dispositivo por defecto
                *handle_lock = None;
            }
        }
    }

    // 2. Si no hay handle o el anterior falló (dispositivo desconectado),
    // volvemos a invocar OutputStream::try_default() para engancharnos al nuevo dispositivo activo
    let (stream, stream_handle) = rodio::OutputStream::try_default()
        .map_err(|e| format!("Dispositivo de salida de audio no disponible: {}. Conecta un altavoz o auriculares.", e))?;

    *state.playback_stream.lock().unwrap() = Some(SafeOutputStream(stream));
    *handle_lock = Some(stream_handle.clone());

    let sink = rodio::Sink::try_new(&stream_handle)
        .map_err(|e| format!("Error al instanciar Sink con el nuevo dispositivo: {}", e))?;

    let source = rodio::buffer::SamplesBuffer::new(
        audio_buf.channels,
        audio_buf.sample_rate,
        audio_buf.samples.clone(),
    );

    sink.append(source);
    sink.play();

    *state.playback_sink.lock().unwrap() = Some(sink);

    Ok(true) // Reproduciendo
}

/// Comando Tauri: Alterna la reproducción de audio utilizando `rodio` en segundo plano.
#[tauri::command]
async fn toggle_playback(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    // 1. Si ya hay un sink activo y no está vacío, pausar o reanudar
    let sink_lock = state.playback_sink.lock().unwrap();
    if let Some(ref sink) = *sink_lock {
        if !sink.empty() {
            if sink.is_paused() {
                sink.play();
                return Ok(true); // Está reproduciendo
            } else {
                sink.pause();
                return Ok(false); // Está pausado
            }
        }
    }
    // Liberamos el lock para permitir que iniciar_reproduccion_interna lo reclame
    drop(sink_lock);

    // 2. Si no hay sink o terminó, inicializar desde el principio
    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        match &*audio_lock {
            Some(buf) => buf.clone(),
            None => return Err("No hay ningún audio cargado en memoria para preescuchar.".to_string()),
        }
    };

    // La inicialización y play de Rodio se ejecuta en el threadpool de tokio
    iniciar_reproduccion_interna(&audio_buf, &*state)
}

/// Comando Tauri: Preescucha 1.5s antes y después de un glitch
#[tauri::command]
async fn preview_glitch_region(
    time_secs: f64,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        if let Some(ref buf) = *audio_lock {
            buf.clone()
        } else {
            return Err("No hay ningún audio cargado en memoria.".to_string());
        }
    };

    let sample_rate = audio_buf.sample_rate as f64;
    let center_sample = (time_secs * sample_rate) as usize;
    let half_window = (1.5 * sample_rate) as usize;

    let start = center_sample.saturating_sub(half_window);
    let end = (center_sample + half_window).min(audio_buf.samples.len());

    let region = audio_buf.samples[start..end].to_vec();

    let temp_buf = dsp::AudioBuffer {
        samples: region,
        sample_rate: audio_buf.sample_rate,
        channels: audio_buf.channels,
        bit_depth: audio_buf.bit_depth,
        duration_seconds: 3.0,
        original_channels: audio_buf.original_channels,
        raw_bytes: None,
        data_offset: None,
    };

    iniciar_reproduccion_interna(&temp_buf, &*state)
}

/// Inicia la reproducción de audio a partir de un segundo específico (Seeking).
#[tauri::command]
async fn play_from_position(
    time_secs: f64,
    state: tauri::State<'_, AppState>,
) -> Result<bool, String> {
    if let Some(sink) = {
        let mut sink_lock = state.playback_sink.lock().unwrap();
        sink_lock.take()
    } {
        sink.stop();
    }

    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        match &*audio_lock {
            Some(buf) => buf.clone(),
            None => return Err("No hay datos de audio cargados en memoria.".to_string()),
        }
    };

    let skip_samples = ((time_secs * audio_buf.sample_rate as f64) as usize * audio_buf.channels as usize).min(audio_buf.samples.len());

    let mut handle_lock = state.playback_handle.lock().unwrap();

    if handle_lock.is_none() {
        let (stream, stream_handle) = rodio::OutputStream::try_default()
            .map_err(|e| format!("Dispositivo de salida de audio no disponible: {}", e))?;
        *state.playback_stream.lock().unwrap() = Some(SafeOutputStream(stream));
        *handle_lock = Some(stream_handle);
    }

    let handle = handle_lock.as_ref().unwrap();
    let sink = rodio::Sink::try_new(handle)
        .map_err(|e| format!("Error al instanciar Sink: {}", e))?;

    let source = rodio::buffer::SamplesBuffer::new(
        audio_buf.channels,
        audio_buf.sample_rate,
        audio_buf.samples[skip_samples..].to_vec(),
    );

    sink.append(source);
    sink.play();

    *state.playback_sink.lock().unwrap() = Some(sink);

    Ok(true)
}

/// Comando Tauri: Detiene la reproducción en curso y libera los recursos de audio.
#[tauri::command]
async fn stop_playback(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let sink = {
        let mut sink_lock = state.playback_sink.lock().unwrap();
        sink_lock.take()
    };
    if let Some(s) = sink {
        s.stop();
    }
    Ok(())
}

/// Comando Tauri: Recalcula y retorna la lista de glitches utilizando el umbral dinámico
/// sobre el buffer de audio ya decodificado en memoria RAM, sin tocar el disco.
#[tauri::command]
async fn actualizar_umbral_detector(
    threshold: f32,
    active_filters: std::collections::HashMap<String, bool>,
    time_start: f64,
    time_end: f64,
    state: tauri::State<'_, AppState>,
) -> Result<dsp::DetectionResult, String> {
    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        if let Some(ref audio_buf) = *audio_lock {
            audio_buf.clone()
        } else {
            return Err("No hay ningún audio cargado en memoria para re-analizar.".to_string());
        }
    };
    let stft = {
        let stft_lock = state.stft.lock().unwrap();
        stft_lock.as_ref().cloned()
    };

    let stft_data = stft.ok_or_else(|| "No hay datos espectrales cargados en memoria.".to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let (fft_size, hop_size) = if stft_data.num_bins == 512 {
            (1024, 256)
        } else if stft_data.num_bins == 2048 {
            (4096, 1024)
        } else {
            (8192, 512)
        };

        let mut thresholds = dsp::DetectorThresholds::default();
        thresholds.spectral_sensitivity = threshold;

        let events = dsp::detect_artifacts_dynamic(
            &audio_buf.samples,
            &stft_data,
            fft_size,
            hop_size,
            audio_buf.sample_rate,
            &active_filters,
            time_start,
            time_end,
            &thresholds,
        );
        Ok(events)
    }).await.map_err(|e| e.to_string())?
}

/// Comando Tauri: Exporta el archivo de audio sanado a un archivo WAV PCM nativo.
#[tauri::command]
async fn export_repaired_file(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        if let Some(ref audio_buf) = *audio_lock {
            audio_buf.clone()
        } else {
            return Err("No hay datos de audio en memoria para exportar.".to_string());
        }
    };

    let clean_path = path.trim_matches('"').trim().to_string();
    let cp = clean_path.clone();
    
    tauri::async_runtime::spawn_blocking(move || {
        dsp::export_repaired_wav(
            std::path::Path::new(&cp),
            &audio_buf,
        )
    }).await.map_err(|e| e.to_string())??;
    
    Ok(format!("Archivo exportado con éxito en: {}", clean_path))
}

/// Comando Tauri: Detección manual de glitches y devuelve la lista de eventos.
#[tauri::command]
async fn ejecutar_deteccion_glitches(
    active_filters: std::collections::HashMap<String, bool>,
    time_start: f64,
    time_end: f64,
    state: tauri::State<'_, AppState>,
) -> Result<dsp::DetectionResult, String> {
    println!("[Rust Debug] ejecutar_deteccion_glitches: time_start = {}, time_end = {}", time_start, time_end);
    let audio_buf = {
        let audio_lock = state.audio.lock().unwrap();
        match &*audio_lock {
            Some(buf) => buf.clone(),
            None => return Err("No hay datos de audio cargados en memoria.".to_string()),
        }
    };
    let stft = {
        let stft_lock = state.stft.lock().unwrap();
        match &*stft_lock {
            Some(s) => s.clone(),
            None => return Err("No hay datos espectrales cargados en memoria.".to_string()),
        }
    };

    tauri::async_runtime::spawn_blocking(move || {
        let (fft_size, hop_size) = if stft.num_bins == 512 {
            (1024, 256)
        } else if stft.num_bins == 2048 {
            (4096, 1024)
        } else {
            (8192, 512)
        };

        let events = dsp::detect_artifacts_dynamic(
            &audio_buf.samples,
            &stft,
            fft_size,
            hop_size,
            audio_buf.sample_rate,
            &active_filters,
            time_start,
            time_end,
            &dsp::DetectorThresholds::default(),
        );
        Ok(events)
    }).await.map_err(|e| e.to_string())?
}

/// Comando Tauri: Obtiene una región analítica sin compresión del espectrograma (solo datos raw, en Float32)
#[tauri::command]
async fn obtener_region_analitica(
    req: AnalyticalRegionRequest,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<Vec<f32>>, String> {
    let stft_arc = {
        let stft_lock = state.stft.lock().unwrap();
        stft_lock.as_ref().cloned().ok_or_else(|| "Espectrograma no disponible".to_string())?
    };

    tauri::async_runtime::spawn_blocking(move || {
        dsp::obtener_region_analitica(&stft_arc, req)
    })
    .await
    .map_err(|e| format!("Error en spawn_blocking: {}", e))?
}

/// Comando Tauri: Guarda un reporte de auditoría en texto plano en la ruta seleccionada.
#[tauri::command]
async fn guardar_reporte_auditoria(
    path: String,
    content: String,
) -> Result<String, String> {
    let clean_path = path.trim_matches('"').trim().to_string();
    let cp = clean_path.clone();
    
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(std::path::Path::new(&cp), content)
            .map_err(|e| format!("Error al escribir el archivo de reporte: {}", e))
    }).await.map_err(|e| e.to_string())??;

    Ok(format!("Reporte guardado con éxito en: {}", clean_path))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            cargar_y_analizar_archivo,
            actualizar_umbral_detector,
            obtener_espectrograma_visible,
            calcular_espectrograma,
            aplicar_reparacion_quirurgica,
            reparar_glitches_seleccionados,
            toggle_playback,
            stop_playback,
            play_from_position,
            export_repaired_file,
            preview_glitch_region,
            ejecutar_deteccion_glitches,
            obtener_region_analitica,
            guardar_reporte_auditoria
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
