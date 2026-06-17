pub mod dsp;

use std::sync::Mutex;
use dsp::{AudioBuffer, StftResult, GlitchEvent, ViewportConfig};

/// Estado global administrado en la memoria RAM del backend de Tauri
#[derive(Default)]
pub struct AppState {
    /// Datos de audio PCM completos actualmente cargados
    pub audio: Mutex<Option<AudioBuffer>>,
    /// Matriz STFT completa calculada a partir de las muestras
    pub stft: Mutex<Option<StftResult>>,
    /// Sink de reproducción de rodio (Send + Sync)
    pub playback_sink: Mutex<Option<rodio::Sink>>,
    /// Handle de salida de audio de rodio (Send + Sync)
    pub playback_handle: Mutex<Option<rodio::OutputStreamHandle>>,
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
}

/// Comando Tauri: Carga y analiza un archivo de audio.
#[tauri::command]
fn cargar_y_analizar_archivo(
    path: String,
    state: tauri::State<'_, AppState>,
) -> Result<InitialAnalysis, String> {
    // 0. Detener cualquier reproducción previa activa
    if let Some(sink) = state.playback_sink.lock().unwrap().take() {
        sink.stop();
    }

    // 1. Limpiar comillas residuales y normalizar
    let clean_path = path.trim_matches('"').trim();
    let audio_buf = dsp::decode_audio_file(std::path::Path::new(clean_path))?;

    // 2. Detección automática por primera derivada con umbral estático por defecto (0.25)
    let glitches = dsp::detect_glitches(&audio_buf.samples, 0.25, audio_buf.sample_rate);

    // 3. Cómputo STFT completo utilizando rustfft (SIMD)
    let stft_res = dsp::compute_stft(&audio_buf.samples, 4096, 1024, "blackman-harris")?;

    let stft_frames = stft_res.num_frames;
    let stft_bins = stft_res.num_bins;

    // 4. Actualizar el estado global en RAM
    *state.audio.lock().unwrap() = Some(audio_buf.clone());
    *state.stft.lock().unwrap() = Some(stft_res);

    Ok(InitialAnalysis {
        glitches,
        sample_rate: audio_buf.sample_rate,
        channels: audio_buf.channels,
        bit_depth: audio_buf.bit_depth,
        duration_seconds: audio_buf.duration_seconds,
        stft_frames,
        stft_bins,
    })
}

/// Comando Tauri: Obtiene la porción del espectrograma visible en el viewport.
/// Retorna bytes binarios compactos: [u32 frames][u32 bins][u8 magnitudes]
#[tauri::command]
fn obtener_espectrograma_visible(
    config: ViewportConfig,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let stft_lock = state.stft.lock().unwrap();
    if let Some(ref stft) = *stft_lock {
        Ok(dsp::stft_to_binary(&dsp::get_paged_spectrogram(stft, &config)))
    } else {
        Err("No hay ninguna matriz espectral cargada en memoria. Carga un archivo primero.".to_string())
    }
}

/// Comando Tauri: Aplica una reparación de discontinuidades sobre el buffer cargado.
#[tauri::command]
fn aplicar_reparacion_quirurgica(
    glitches: Vec<GlitchEvent>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let mut audio_lock = state.audio.lock().unwrap();
    let mut stft_lock = state.stft.lock().unwrap();

    if let Some(ref mut audio_buf) = *audio_lock {
        let noise_floor = 0.005;

        // 1. Reparar muestras corruptas in-place (sin clonar el buffer completo)
        dsp::heal_glitches_inplace(&mut audio_buf.samples, &glitches, noise_floor);

        // 2. Recalcular la STFT sobre las muestras reparadas
        let stft_res = dsp::compute_stft(&audio_buf.samples, 4096, 1024, "blackman-harris")?;
        *stft_lock = Some(stft_res);

        Ok("Audio reparado y plano espectral recalculado de forma exitosa.".to_string())
    } else {
        Err("No hay datos de audio en memoria sobre los cuales aplicar la reparación.".to_string())
    }
}

/// Comando Tauri: Ejecuta la reparación Hermite de glitches seleccionados y devuelve
/// la sub-matriz espectral optimizada en formato binario compacto para WebGL.
#[tauri::command]
fn reparar_glitches_seleccionados(
    glitches: Vec<GlitchEvent>,
    config: ViewportConfig,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    let mut audio_lock = state.audio.lock().unwrap();
    let mut stft_lock = state.stft.lock().unwrap();

    if let Some(ref mut audio_buf) = *audio_lock {
        let noise_floor = 0.005;

        // 1. Reparar in-place sobre el buffer en RAM (sin clonar ~112 MB)
        dsp::heal_glitches_inplace(&mut audio_buf.samples, &glitches, noise_floor);

        // 2. Recalcular la STFT completa sobre el buffer sanado (paralela con rayon)
        let stft_res = dsp::compute_stft(&audio_buf.samples, 4096, 1024, "blackman-harris")?;
        *stft_lock = Some(stft_res.clone());

        // 3. Serializar la porción visible como bytes binarios y retornar
        Ok(dsp::stft_to_binary(&dsp::get_paged_spectrogram(&stft_res, &config)))
    } else {
        Err("No hay datos de audio en memoria sobre los cuales aplicar la reparación.".to_string())
    }
}

/// Comando Tauri: Alterna la reproducción de audio utilizando `rodio` en segundo plano.
#[tauri::command]
fn toggle_playback(state: tauri::State<'_, AppState>) -> Result<bool, String> {
    let audio_lock = state.audio.lock().unwrap();
    let audio_buf = match &*audio_lock {
        Some(buf) => buf,
        None => return Err("No hay ningún audio cargado en memoria para preescuchar.".to_string()),
    };

    let sink_lock = state.playback_sink.lock().unwrap();

    if let Some(ref sink) = *sink_lock {
        if sink.empty() {
            // La reproducción terminó, debemos iniciarla desde el principio
            drop(sink_lock);
            iniciar_reproduccion_interna(audio_buf, &state)
        } else if sink.is_paused() {
            sink.play();
            Ok(true) // Reproduciendo
        } else {
            sink.pause();
            Ok(false) // Pausado
        }
    } else {
        // Primera reproducción
        drop(sink_lock);
        iniciar_reproduccion_interna(audio_buf, &state)
    }
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

    // Leakeamos la nueva stream para mantenerla activa indefinidamente en un hilo en background
    Box::leak(Box::new(stream));

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

/// Comando Tauri: Detiene la reproducción en curso y libera los recursos de audio.
#[tauri::command]
fn stop_playback(state: tauri::State<'_, AppState>) -> Result<(), String> {
    if let Some(sink) = state.playback_sink.lock().unwrap().take() {
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
    let audio_lock = state.audio.lock().unwrap();
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            cargar_y_analizar_archivo,
            obtener_espectrograma_visible,
            aplicar_reparacion_quirurgica,
            reparar_glitches_seleccionados,
            toggle_playback,
            stop_playback,
            export_repaired_file
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
