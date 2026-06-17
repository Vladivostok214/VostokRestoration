import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def compute_evidences(filepath):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    f_axis, t_axis, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    
    mags = np.abs(Zxx)
    phases = np.angle(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    
    # 1. Phase Coherence (Evidencia A)
    # Varianza de la diferencia de fase consecutiva en el bin de 50Hz
    phase_diff = np.diff(phases[bin_50, :])
    # Envolvemos la fase para que esté en [-pi, pi]
    phase_diff = (phase_diff + np.pi) % (2 * np.pi) - np.pi
    phase_stability = np.var(phase_diff)
    
    # 2. Harmonic Consistency (Evidencia B)
    # Buscamos si hay picos en los armónicos 100, 150, 200 Hz
    harmonics = [100, 150, 200, 250]
    harmonic_bins = [int(round(h * nperseg / sample_rate)) for h in harmonics]
    
    harmonic_matches = 0
    for h_bin in harmonic_bins:
        # Un armónico es "consistente" si su CV es bajo (< 0.2) y su magnitud es > 0.001
        h_win = mags[h_bin, :]
        h_mag = np.mean(h_win)
        h_cv = np.std(h_win) / (h_mag + 1e-9)
        if h_mag > 0.001 and h_cv < 0.2:
            harmonic_matches += 1
    
    # 3. Harmonic Energy Decay (Evidencia C)
    # El Hum suele decaer suavemente. Música puede tener armónicos más fuertes que la fundamental.
    mag_f0 = np.mean(mags[bin_50, :])
    mag_h1 = np.mean(mags[harmonic_bins[0], :]) # 100Hz
    decay_ratio = mag_h1 / (mag_f0 + 1e-9)
    
    # 4. Temporal Spectral Stability (Evidencia D)
    # CV promedio de los primeros 3 armónicos
    cv_sum = 0
    valid_h = 0
    for h_bin in [bin_50] + harmonic_bins[:2]:
        h_win = mags[h_bin, :]
        h_mag = np.mean(h_win)
        if h_mag > 1e-5:
            cv_sum += np.std(h_win) / h_mag
            valid_h += 1
    avg_cv = cv_sum / valid_h if valid_h > 0 else 1.0

    return {
        "phase_var": phase_stability,
        "harmonic_matches": harmonic_matches,
        "decay_ratio": decay_ratio,
        "avg_harmonic_cv": avg_cv
    }

def main():
    test_dir = "../TestSamples"
    positives = [
        "bateria_hum_50hz.wav",
        "musicapesada_hum_50hz.wav",
        "vozenoff_ground_loop.wav"
    ]
    negatives = [
        "musicapesada.wav",
        "musicaenvivo.wav",
        "vozbajacalidad.wav"
    ]
    
    print(f"{'Archivo':<30} | {'PhaseVar':<10} | {'HarmMatch':<10} | {'Decay':<10} | {'AvgHCV':<10}")
    print("-" * 80)
    
    for f in positives:
        path = os.path.join(test_dir, f)
        if not os.path.exists(path): continue
        ev = compute_evidences(path)
        print(f"{f:<30} | {ev['phase_var']:<10.4f} | {ev['harmonic_matches']:<10} | {ev['decay_ratio']:<10.4f} | {ev['avg_harmonic_cv']:<10.4f}")

    print("-" * 80)
    for f in negatives:
        path = os.path.join(test_dir, f)
        if not os.path.exists(path): continue
        ev = compute_evidences(path)
        print(f"{f:<30} | {ev['phase_var']:<10.4f} | {ev['harmonic_matches']:<10} | {ev['decay_ratio']:<10.4f} | {ev['avg_harmonic_cv']:<10.4f}")

if __name__ == "__main__":
    main()
