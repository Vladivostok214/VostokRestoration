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
    
    T_MAG = 0.005
    CV_W = 10
    T_CV = 0.1
    P_W = 40
    T_P = 0.5
    
    num_frames = mags.shape[1]
    raw_detections = np.zeros(num_frames, dtype=bool)
    
    for i in range(CV_W, num_frames):
        win = mags[bin_50, i-CV_W:i]
        m = np.mean(win)
        cv = np.std(win) / (m + 1e-9)
        if m > T_MAG and cv < T_CV:
            raw_detections[i] = True

    def moving_average(a, n) :
        if len(a) < n: return np.array([0.0])
        ret = np.cumsum(a, dtype=float)
        ret[n:] = ret[n:] - ret[:-n]
        return ret[n - 1:] / n

    persisted = moving_average(raw_detections, P_W) > T_P
    
    # Global Persistence Score
    global_pers = np.sum(persisted) / num_frames if num_frames > 0 else 0
    
    return np.any(persisted), global_pers

test_dir = "../TestSamples"
samples = ['musicaconmetronomo', 'musicaenvivo', 'musicapesada', 'vozbajacalidad', 'vozenoff']
modes = ['hum_50hz', 'ground_loop', 'hum_intermitente']

print(f"{'Archivo':<35} | {'Global Persist':<10}")
print("-" * 50)
for s in ['musicapesada', 'musicaenvivo']:
    detected, gp = process_and_eval(os.path.join(test_dir, f"{s}.wav"))
    print(f"{s+'.wav (Neg)':<35} | {gp:<10.4f}")

for s in ['bateria', 'vozbajacalidad']:
    for m in modes:
        detected, gp = process_and_eval(os.path.join(test_dir, f"{s}_{m}.wav"))
        print(f"{s+'_'+m+'.wav (Pos)':<35} | {gp:<10.4f}")
