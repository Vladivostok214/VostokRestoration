import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def profile_harmonics(filepath):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    mags = np.abs(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    bin_100 = int(round(100 * nperseg / sample_rate))
    bin_150 = int(round(150 * nperseg / sample_rate))
    
    # Solo frames donde 50Hz es detectado (m > 0.005, CV < 0.1)
    frames_activos = []
    CV_W = 10
    for i in range(CV_W, mags.shape[1]):
        win = mags[bin_50, i-CV_W:i]
        m = np.mean(win)
        cv = np.std(win) / (m + 1e-9)
        if m > 0.005 and cv < 0.1:
            frames_activos.append(i)
            
    if not frames_activos: return
    
    # Promedios en frames activos
    m_50 = np.mean(mags[bin_50, frames_activos])
    m_100 = np.mean(mags[bin_100, frames_activos])
    m_150 = np.mean(mags[bin_150, frames_activos])
    
    print(f"{os.path.basename(filepath):<35} | 50Hz: {m_50:<7.4f} | 100Hz: {m_100:<7.4f} (Ratio {m_100/m_50:.2f}) | 150Hz: {m_150:<7.4f} (Ratio {m_150/m_50:.2f})")

print("--- NEGATIVOS (Falsos Positivos) ---")
profile_harmonics("../TestSamples/musicapesada.wav")
profile_harmonics("../TestSamples/musicaenvivo.wav")
print("\n--- POSITIVOS (Hum Puro) ---")
profile_harmonics("../TestSamples/bateria_hum_50hz.wav")
profile_harmonics("../TestSamples/musicapesada_hum_50hz.wav")
print("\n--- POSITIVOS (Ground Loop) ---")
profile_harmonics("../TestSamples/vozenoff_ground_loop.wav")
profile_harmonics("../TestSamples/musicapesada_ground_loop.wav")
