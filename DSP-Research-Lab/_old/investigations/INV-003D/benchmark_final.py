import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def process_and_eval(filepath, use_inv_phase=False):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    mags = np.abs(Zxx)
    phases = np.angle(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    bin_60 = int(round(60 * nperseg / sample_rate))
    
    # MVA Core
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
        mag_50 = np.mean(win_50)
        cv_50 = np.std(win_50) / (mag_50 + 1e-9)
        if mag_50 > T_MAG and cv_50 < T_CV: det_50[i] = True
            
        win_60 = mags[bin_60, i-CV_W:i]
        mag_60 = np.mean(win_60)
        cv_60 = np.std(win_60) / (mag_60 + 1e-9)
        if mag_60 > T_MAG and cv_60 < T_CV: det_60[i] = True

    def moving_average(a, n) :
        if len(a) < n: return np.array([0.0])
        ret = np.cumsum(a, dtype=float)
        ret[n:] = ret[n:] - ret[:-n]
        return ret[n - 1:] / n

    ma_50 = moving_average(det_50, P_W) > T_P
    ma_60 = moving_average(det_60, P_W) > T_P
    
    # Local MVA
    detected_local = np.any(ma_50) or np.any(ma_60)
    
    if not use_inv_phase:
        return detected_local
        
    # Confidence Layer: Inverse Phase Coherence
    # Hum is weak and dirty (PhaseVar ~0.1 - 1.5). Synths are perfectly clean (PhaseVar < 0.05).
    detected_global = False
    
    if np.any(ma_50):
        # Medir la varianza de fase global en los frames detectados
        frames_activos = np.where(ma_50)[0]
        p_win = phases[bin_50, frames_activos]
        p_diff = np.diff(p_win)
        p_diff = (p_diff + np.pi) % (2 * np.pi) - np.pi
        p_var = np.var(p_diff) if len(p_diff) > 0 else 0
        
        confidence = 1.0
        if p_var < 0.05: confidence = 0.0 # Too perfect (Synth Bass)
        if p_var > 3.0: confidence = 0.0 # Too noisy
        
        if confidence >= 0.5: detected_global = True

    if np.any(ma_60):
        frames_activos = np.where(ma_60)[0]
        p_win = phases[bin_60, frames_activos]
        p_diff = np.diff(p_win)
        p_diff = (p_diff + np.pi) % (2 * np.pi) - np.pi
        p_var = np.var(p_diff) if len(p_diff) > 0 else 0
        
        confidence = 1.0
        if p_var < 0.05: confidence = 0.0
        if p_var > 3.0: confidence = 0.0
        
        if confidence >= 0.5: detected_global = True
        
    return detected_global

def run_benchmark(label, use_inv_phase):
    test_dir = "../TestSamples"
    samples = ['bateria', 'musicaconmetronomo', 'musicaenvivo', 'musicapesada', 'vozbajacalidad', 'vozenoff']
    modes = ['hum_50hz', 'hum_60hz', 'ground_loop', 'hum_modulado', 'hum_intermitente']
    
    tp, tn, fp, fn = 0, 0, 0, 0
    
    for s in samples:
        path = os.path.join(test_dir, f"{s}.wav")
        if not process_and_eval(path, use_inv_phase): tn += 1
        else: 
            print(f"[{label}] FP: {s}.wav")
            fp += 1
        
        for m in modes:
            if process_and_eval(os.path.join(test_dir, f"{s}_{m}.wav"), use_inv_phase): tp += 1
            else: 
                print(f"[{label}] FN: {s}_{m}.wav")
                fn += 1
            
    p = tp / (tp + fp) if (tp + fp) > 0 else 0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0
    return p, r, f1

def main():
    print(f"{'Configuracion':<30} | {'Precision':<10} | {'Recall':<10} | {'F1':<10}")
    print("-" * 70)
    
    configs = [
        ("MVA Local (Baseline)", False),
        ("MVA + Inverse Phase (E)", True),
    ]
    
    for label, use_inv_phase in configs:
        p, r, f1 = run_benchmark(label, use_inv_phase)
        print(f"{label:<30} | {p:<10.4f} | {r:<10.4f} | {f1:<10.4f}")

if __name__ == "__main__":
    main()
