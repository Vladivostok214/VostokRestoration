import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def process_and_eval(filepath, use_decay=False, use_phase=False):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    mags = np.abs(Zxx)
    phases = np.angle(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    bin_100 = int(round(100 * nperseg / sample_rate))
    
    # MVA Core
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
            # Evidence Layers
            confidence = 1.0
            
            if use_decay:
                decay = mags[bin_100, i] / (mags[bin_50, i] + 1e-9)
                if decay > 0.8: confidence *= 0.1 # Musical content often has stronger harmonics
            
            if use_phase:
                p_win = phases[bin_50, i-CV_W:i]
                p_diff = np.diff(p_win)
                p_diff = (p_diff + np.pi) % (2 * np.pi) - np.pi
                p_var = np.var(p_diff)
                if p_var > 2.0: confidence *= 0.1 # Unstable phase
            
            if confidence > 0.5:
                raw_detections[i] = True

    def moving_average(a, n) :
        if len(a) < n: return np.array([0.0])
        ret = np.cumsum(a, dtype=float)
        ret[n:] = ret[n:] - ret[:-n]
        return ret[n - 1:] / n

    return np.any(moving_average(raw_detections, P_W) > T_P)

def run_benchmark(label, use_decay, use_phase):
    test_dir = "../TestSamples"
    samples = ['bateria', 'musicaconmetronomo', 'musicaenvivo', 'musicapesada', 'vozbajacalidad', 'vozenoff']
    modes = ['hum_50hz', 'hum_60hz', 'ground_loop', 'hum_modulado', 'hum_intermitente']
    
    tp, tn, fp, fn = 0, 0, 0, 0
    
    for s in samples:
        path = os.path.join(test_dir, f"{s}.wav")
        # Negativos
        if not process_and_eval(path, use_decay, use_phase): 
            tn += 1
        else: 
            print(f"[{label}] FP detectado en: {s}.wav")
            fp += 1
        
        # Positivos
        for m in modes:
            if process_and_eval(os.path.join(test_dir, f"{s}_{m}.wav"), use_decay, use_phase): tp += 1
            else: fn += 1
            
    p = tp / (tp + fp) if (tp + fp) > 0 else 0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0
    return p, r, f1

def main():
    print(f"{'Configuracion':<25} | {'Precision':<10} | {'Recall':<10} | {'F1':<10}")
    print("-" * 65)
    
    configs = [
        ("MVA (Baseline)", False, False),
        ("MVA + Decay", True, False),
        ("MVA + Phase", False, True),
        ("MVA + Decay + Phase", True, True),
    ]
    
    for label, d, ph in configs:
        p, r, f1 = run_benchmark(label, d, ph)
        print(f"{label:<25} | {p:<10.4f} | {r:<10.4f} | {f1:<10.4f}")

if __name__ == "__main__":
    main()
