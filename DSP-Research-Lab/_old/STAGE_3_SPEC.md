# Vostok Restoration V1 - Stage 3 Technical Specification
*Advanced DSP & Infinite Canvas Architecture*

## Overview
Stage 3 represents the "Holy Grail" of spectral editing for Vostok. It transitions the application from a standard STFT viewer into a forensic-grade, scientific audio analysis tool capable of handling infinitely long audio files with sub-pixel precision.

This phase is considered **High Effort / High Risk** as it fundamentally rewrites the core DSP loop and memory management model in Rust.

## 1. Multi-Resolution STFT (Wavelet-like / CQT Approximation)
Currently, Vostok forces a compromise: high temporal resolution (1k FFT for Transients) OR high spectral resolution (4k FFT for Hum).

### Implementation Strategy (Rust):
*   Abandon the fixed `fft_size` paradigm.
*   Implement a cascaded STFT approach or a Constant-Q Transform (CQT).
*   **Low Frequencies (0 - 1kHz):** Processed with large windows (e.g., 8192) to pinpoint exact Hz values of Hum.
*   **High Frequencies (1kHz - 20kHz):** Processed with small windows (e.g., 512) to capture sharp transients and sibilance without temporal smearing.
*   **Fusion:** Merge the resulting bins into a single unified matrix before sending it to WebGL, mapping them onto a logarithmic or Bark scale natively.

## 2. Reassignment Method (Método de Reasignación)
The STFT inherently suffers from the Gabor uncertainty principle (smearing). The Reassignment Method calculates the derivative of the phase to vector the diffuse energy back to its exact center of gravity in time and frequency.

### Implementation Strategy (Rust):
*   Compute standard STFT.
*   Simultaneously compute two additional STFTs using time-weighted and frequency-weighted windows.
*   Use the phase derivatives from these auxiliary transforms to calculate the precise $(t, f)$ coordinates.
*   Reallocate the energy of each bin to the new exact coordinates.
*   **Visual Result:** Hum lines become 1-pixel thin razor edges. Clicks become perfect vertical lines.

## 3. "Infinite Canvas" Tile Server
Currently, Vostok decodes the entire audio file into a single monolithic `Uint8Array` matrix (`SPECTROGRAM_STORAGE`). This limits the maximum file duration before V8 (JavaScript engine) runs out of heap memory.

### Implementation Strategy (Rust -> React):
*   **Backend Storage:** The raw STFT matrix stays 100% in Rust RAM (or disk-backed DB like RocksDB/Sled for massive files).
*   **Tile Generation:** Rust acts as an internal HTTP/IPC Tile Server (similar to Google Maps).
*   **Dynamic Fetching:** As the user pans/zooms in WebGL, React requests specific tiles (e.g., `get_tile(z=2, x=4, y=0)`).
*   **WebGL Updates:** `SpectrogramGL.jsx` maintains a fixed-size texture ring-buffer, only updating the sub-regions (`glTexSubImage2D`) that just scrolled into view.
*   **Benefit:** Memory consumption becomes constant $O(1)$, completely decoupled from the audio file length. Vostok could analyze a 2-hour podcast without crashing.

## Roadmap de Implementación Pendiente
1. **[COMPLETO] Infraestructura Base Tile Server:** Backend `AppState` y Comando Tauri `get_tile_data` (PoC memoria) e interfaz frontend `useTileLoader` diseñados.
2. **[PENDIENTE] Integración Frontend Final:** Finalizar la integración de `useTileLoader` en `SpectrogramGL.jsx` para el renderizado WebGL por tiles.
3. **[PENDIENTE] Motor DSP Multirresolución:** Implementar lógica de banco de filtros en `compute_stft` para procesar bandas separadas según `MultiResolutionConfig`.
4. **[PENDIENTE] Implementación de Reasignación:** Desarrollar los kernels SIMD en Rust para el cálculo de las derivadas de fase y la reasignación de energía.
5. **[PENDIENTE] Persistencia:** Integrar `sled` en el `TileProvider` para almacenamiento en disco de tiles.