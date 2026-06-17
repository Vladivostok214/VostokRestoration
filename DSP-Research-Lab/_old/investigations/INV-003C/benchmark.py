import os
import sys
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

def process_file(filepath):
    sample_rate, audio = wavfile.read(filepath)
    if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
    if audio.ndim > 1: audio = audio[:, 0]

    nperseg = 4096
    noverlap = 4096 - 1024
    
    f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
    mags = np.abs(Zxx)
    
    bin_50 = int(round(50 * nperseg / sample_rate))
    bin_60 = int(round(60 * nperseg / sample_rate))
    
    T_MAG = 0.005
    CV_W = 10
    T_CV = 0.1
    
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

    P_W = 40
    T_P = 0.5
    
    def moving_average(a, n) :
        ret = np.cumsum(a, dtype=float)
        ret[n:] = ret[n:] - ret[:-n]
        return ret[n - 1:] / n

    final_50 = np.any(moving_average(det_50, P_W) > T_P) if len(det_50) >= P_W else False
    final_60 = np.any(moving_average(det_60, P_W) > T_P) if len(det_60) >= P_W else False

    return final_50 or final_60

def main():
    test_dir = "../TestSamples"
    samples = ['bateria', 'musicaconmetronomo', 'musicaenvivo', 'musicapesada', 'vozbajacalidad', 'vozenoff']
    modes = ['hum_50hz', 'hum_60hz', 'ground_loop', 'hum_modulado', 'hum_intermitente']
    
    fp = 0
    tn = 0
    print("--- Evaluando Originales (Negativos) ---")
    for s in samples:
        path = os.path.join(test_dir, f"{s}.wav")
        try:
            detected = process_file(path)
            if detected:
                print(f"[FP] Falso Positivo en: {s}.wav")
                fp += 1
            else:
                tn += 1
        except Exception as e:
            print(f"Error procesando {s}.wav: {e}")
            
    tp = 0
    fn = 0
    print("\n--- Evaluando Degradados (Positivos) ---")
    for s in samples:
        for m in modes:
            path = os.path.join(test_dir, f"{s}_{m}.wav")
            try:
                detected = process_file(path)
                if detected:
                    tp += 1
                else:
                    print(f"[FN] Falso Negativo en: {s}_{m}.wav")
                    fn += 1
            except Exception as e:
                print(f"Error procesando {s}_{m}.wav: {e}")

    print("\n--- RESULTADOS DEL BENCHMARK ---")
    print(f"TP: {tp} | TN: {tn} | FP: {fp} | FN: {fn}")
    
    p = tp / (tp + fp) if (tp + fp) > 0 else 0
    r = tp / (tp + fn) if (tp + fn) > 0 else 0
    f1 = 2 * p * r / (p + r) if (p + r) > 0 else 0
    
    print(f"Precision: {p:.4f} | Recall: {r:.4f} | F1-Score: {f1:.4f}")

if __name__ == "__main__":
    main()
