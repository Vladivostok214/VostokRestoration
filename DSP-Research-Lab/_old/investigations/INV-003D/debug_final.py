import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def process_and_eval(filepath):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    mags = np.abs(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    bin_60 = int(round(60 * nperseg / sample_rate))
    bin_100 = int(round(100 * nperseg / sample_rate))
    bin_120 = int(round(120 * nperseg / sample_rate))
    
    T_MAG = 0.005
    CV_W = 10
    T_CV = 0.1
    P_W = 40
    T_P = 0.5
    
    num_frames = mags.shape[1]
    det_50 = np.zeros(num_frames, dtype=bool)
    det_60 = np.zeros(num_frames, dtype=bool)
    
    for i in range(CV_W, num_frames):
        win_50 = mags[bin_50, i-CV_W:i]
        m50 = np.mean(win_50)
        cv50 = np.std(win_50) / (m50 + 1e-9)
        # Evidencia C: Harmonic Decay
        decay_50 = mags[bin_100, i] / (mags[bin_50, i] + 1e-9)
        if m50 > T_MAG and cv50 < T_CV and decay_50 < 0.8:
            det_50[i] = True
            
        win_60 = mags[bin_60, i-CV_W:i]
        m60 = np.mean(win_60)
        cv60 = np.std(win_60) / (m60 + 1e-9)
        decay_60 = mags[bin_120, i] / (mags[bin_60, i] + 1e-9)
        if m60 > T_MAG and cv60 < T_CV and decay_60 < 0.8:
            det_60[i] = True

    def moving_average(a, n) :
        if len(a) < n: return np.array([0.0])
        ret = np.cumsum(a, dtype=float)
        ret[n:] = ret[n:] - ret[:-n]
        return ret[n - 1:] / n

    ma_50 = moving_average(det_50, P_W) > T_P
    ma_60 = moving_average(det_60, P_W) > T_P
    
    # Global Persistence
    gp_50 = np.sum(ma_50) / num_frames if num_frames > 0 else 0
    gp_60 = np.sum(ma_60) / num_frames if num_frames > 0 else 0
    
    # Confidence: Needs at least 2% global persistence
    detected_global = False
    if np.any(ma_50) and gp_50 >= 0.02: detected_global = True
    if np.any(ma_60) and gp_60 >= 0.02: detected_global = True
    
    return detected_global

test_dir = "../TestSamples"
samples = ['bateria', 'musicaconmetronomo', 'musicaenvivo', 'musicapesada', 'vozbajacalidad', 'vozenoff']
modes = ['hum_50hz', 'hum_60hz', 'ground_loop', 'hum_modulado', 'hum_intermitente']

tp, tn, fp, fn = 0, 0, 0, 0

for s in samples:
    if not process_and_eval(os.path.join(test_dir, f"{s}.wav")): tn += 1
    else: 
        print(f"[FP] {s}.wav")
        fp += 1
    
    for m in modes:
        if process_and_eval(os.path.join(test_dir, f"{s}_{m}.wav")): tp += 1
        else: 
            print(f"[FN] {s}_{m}.wav")
            fn += 1

print(f"\nTP: {tp} | TN: {tn} | FP: {fp} | FN: {fn}")
