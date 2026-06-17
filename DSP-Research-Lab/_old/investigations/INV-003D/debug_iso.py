import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def check_isolation(filepath):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    mags = np.abs(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    
    # Calculate isolation across the file
    iso_scores = []
    for i in range(mags.shape[1]):
        m_50 = mags[bin_50, i]
        # Bins around 50Hz (e.g. 40Hz to 60Hz)
        # bin resolution is ~ 11.7 Hz. 50Hz is bin 4 (46.8Hz).
        # Context bins: bin-2 to bin+2 excluding bin
        if m_50 > 0.005:
            surround = np.concatenate((mags[bin_50-2:bin_50, i], mags[bin_50+1:bin_50+3, i]))
            iso = m_50 / (np.mean(surround) + 1e-9)
            iso_scores.append(iso)
    
    if iso_scores:
        print(f"{os.path.basename(filepath):<35} | Mean Iso: {np.mean(iso_scores):<10.4f} | Max Iso: {np.max(iso_scores):<10.4f}")

check_isolation("../TestSamples/musicapesada.wav")
check_isolation("../TestSamples/musicaenvivo.wav")
check_isolation("../TestSamples/bateria_hum_50hz.wav")
check_isolation("../TestSamples/vozenoff_hum_50hz.wav")
check_isolation("../TestSamples/musicapesada_hum_50hz.wav")
