use std::path::Path;
use rayon::prelude::*;
use symphonia::core::audio::{AudioBufferRef, Signal};
use symphonia::core::codecs::{DecoderOptions, CODEC_TYPE_NULL};
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::FormatOptions;
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;
use symphonia::core::probe::Hint;

use crate::vostok_dsp::types::{AudioBuffer, StftResult};

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

/// Serializa un `StftResult` a bytes compactos para transferencia IPC.
/// Formato: [frames: u32 LE][bins: u32 LE][audio_version: u64 LE][matrix: u8 × frames×bins]
/// P1.3-E: el payload se llena en paralelo con Rayon. Cada elemento es independiente
/// (solo depende de stft.matrix[i]), por lo que no hay condiciones de carrera.
pub fn stft_to_binary(stft: &StftResult, audio_version: u64) -> Vec<u8> {
    let t0 = std::time::Instant::now();
    let payload = stft.num_frames * stft.num_bins;

    // Pre-alocar el buffer completo para permitir escritura paralela por índice.
    // Header: [frames: u32 LE][bins: u32 LE][audio_version: u64 LE] = 16 bytes exactos.
    let mut buf = vec![0u8; 16 + payload];
    buf[0..4].copy_from_slice(&(stft.num_frames as u32).to_le_bytes());
    buf[4..8].copy_from_slice(&(stft.num_bins   as u32).to_le_bytes());
    buf[8..16].copy_from_slice(&audio_version.to_le_bytes());

    let noise_floor_db = -96.0f32;

    // Llenar payload en paralelo: cada hilo escribe su propio rango de bytes sin solapamiento.
    buf[16..]
        .par_iter_mut()
        .zip(stft.matrix.par_iter())
        .for_each(|(out, &mag)| {
            let db = 20.0 * mag.max(1e-6).log10();
            let normalized = (db - noise_floor_db) / -noise_floor_db;
            *out = (normalized.clamp(0.0, 1.0) * 255.0) as u8;
        });

    eprintln!("[PROF] stft_to_binary | frames={}x bins={} | payload_bytes={} ({:.1}KB) | version={} | elapsed={}µs",
        stft.num_frames, stft.num_bins, buf.len(), buf.len() as f64 / 1024.0,
        audio_version, t0.elapsed().as_micros());
    buf
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
