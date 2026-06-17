import os
import numpy as np
from scipy.io import wavfile
from scipy.signal import stft

sample_rate, audio = wavfile.read("../TestSamples/musicapesada.wav")
if audio.dtype == np.int16: audio = audio.astype(np.float32) / 32768.0
if audio.ndim > 1: audio = audio[:, 0]

nperseg = 4096
noverlap = 4096 - 1024
f, t, Zxx = stft(audio, fs=sample_rate, window="hann", nperseg=nperseg, noverlap=noverlap)
mags = np.abs(Zxx)
phases = np.angle(Zxx)

bin_50 = int(round(50 * nperseg / sample_rate))
bin_100 = int(round(100 * nperseg / sample_rate))

T_MAG = 0.005
CV_W = 10
T_CV = 0.1
P_W = 40

for i in range(CV_W, mags.shape[1]):
    win = mags[bin_50, i-CV_W:i]
    m = np.mean(win)
    cv = np.std(win) / (m + 1e-9)
    if m > T_MAG and cv < T_CV:
        decay = mags[bin_100, i] / (mags[bin_50, i] + 1e-9)
        p_win = phases[bin_50, i-CV_W:i]
        p_diff = np.diff(p_win)
        p_diff = (p_diff + np.pi) % (2 * np.pi) - np.pi
        p_var = np.var(p_diff)
        print(f"Frame {i}: CV={cv:.4f}, Decay={decay:.4f}, PhaseVar={p_var:.4f}")
