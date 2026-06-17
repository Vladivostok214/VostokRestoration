% INV-003B_architecture_benchmark.m
% Benchmark de arquitecturas candidatas para detección de Hum (INV-003B).

clc; clear; close all;

%% 1. Configuración de Simulación
fs = 48000;
fft_size = 4096;
hop_size = 1024;
n = (0:fft_size-1)';
win = 0.5 * (1 - cos(2 * pi * n / (fft_size - 1)));

% Cargar dataset de INV-003
try
    [audio, fs_audio] = audioread('../datasets/corrupted/inv003_hum_test.wav');
catch
    error('Dataset inv003_hum_test.wav no encontrado.');
end

%% 2. Extracción de Capas de Evidencia
num_frames = floor((length(audio) - fft_size) / hop_size) + 1;
num_bins = fft_size / 2 + 1;

mags = zeros(num_frames, num_bins);
phases = zeros(num_frames, num_bins);

for f = 1:num_frames
    start_idx = (f-1) * hop_size + 1;
    frame = audio(start_idx : start_idx + fft_size - 1) .* win;
    X = fft(frame);
    mags(f, :) = abs(X(1:num_bins));
    phases(f, :) = angle(X(1:num_bins));
end

bin_50hz = round(50 * fft_size / fs) + 1;
bin_150hz = round(150 * fft_size / fs) + 1; % 3er armónico

%% 3. Implementación de Arquitecturas (Lógica de Decisión)

% Capas Base
cv_window = 10; % Ventana de 10 frames para calcular CV (~200ms)
cv_mag = zeros(num_frames, 1);
for f = cv_window:num_frames
    window_data = mags(f-cv_window+1:f, bin_50hz);
    cv_mag(f) = std(window_data) / (mean(window_data) + 1e-9);
end

phase_diff = [zeros(1, num_bins); diff(phases, 1, 1)];
phase_stab = zeros(num_frames, 1);
for f = cv_window:num_frames
    phase_stab(f) = var(phase_diff(f-cv_window+1:f, bin_50hz));
end

% Definición de Ground Truth (Segmentos de 5s)
% Seg 1 (Frames 1-230): POSITIVO (Hum)
% Seg 2 (Frames 231-460): POSITIVO (Hum + Harmonics)
% Seg 3 (Frames 461-690): NEGATIVO (Musical Tone)
% Seg 4 (Frames 691-920): POSITIVO (Intermittent)

gt = [ones(460, 1); zeros(230, 1); ones(230, 1)];
if length(gt) > num_frames
    gt = gt(1:num_frames);
elseif length(gt) < num_frames
    gt = [gt; zeros(num_frames - length(gt), 1)];
end

%% 4. Evaluación de Arquitecturas

% thresholds empíricos refinados (STRESS TEST)
T_MAG = 0.005; 
T_CV = 0.05; % Muy estricto
T_PHASE = 3.0; % Muy estricto
T_PERSIST = 0.8; % Requiere alta persistencia

% Arquitectura B: Fundamental + CV
dec_B = (mags(:, bin_50hz) > T_MAG) & (cv_mag < T_CV);

% Arquitectura C: Fundamental + CV + Persist
persist_B = movmean(dec_B, 30);
dec_C = (dec_B) & (persist_B > T_PERSIST);

% Arquitectura D: Fundamental + CV + Persist + Fase
dec_D = (dec_C) & (phase_stab < T_PHASE);

% Arquitectura E: Harmonic + CV + Persist
dec_E_core = (mags(:, bin_50hz) > T_MAG) & (mags(:, bin_150hz) > T_MAG/10) & (cv_mag < T_CV);
dec_E = (dec_E_core) & (movmean(dec_E_core, 10) > T_PERSIST);

% Arquitectura F: Harmonic + CV + Persist + Fase
dec_F = (dec_E) & (phase_stab < T_PHASE);

%% 5. Cálculo de Métricas

function [p, r, f1] = metrics(dec, gt)
    tp = sum(dec & gt);
    fp = sum(dec & ~gt);
    fn = sum(~dec & gt);
    p = tp / (tp + fp + 1e-9);
    r = tp / (tp + fn + 1e-9);
    f1 = 2 * (p * r) / (p + r + 1e-9);
end

[pB, rB, f1B] = metrics(dec_B, gt);
[pC, rC, f1C] = metrics(dec_C, gt);
[pD, rD, f1D] = metrics(dec_D, gt);
[pE, rE, f1E] = metrics(dec_E, gt);
[pF, rF, f1F] = metrics(dec_F, gt);

fprintf('--- Resultados del Benchmark (INV-003B) ---\n');
fprintf('Arch B (F0+CV):        P=%.2f, R=%.2f, F1=%.2f\n', pB, rB, f1B);
fprintf('Arch C (F0+CV+P):      P=%.2f, R=%.2f, F1=%.2f\n', pC, rC, f1C);
fprintf('Arch D (F0+CV+P+Ph):   P=%.2f, R=%.2f, F1=%.2f\n', pD, rD, f1D);
fprintf('Arch E (Har+CV+P):     P=%.2f, R=%.2f, F1=%.2f\n', pE, rE, f1E);
fprintf('Arch F (Har+CV+P+Ph):  P=%.2f, R=%.2f, F1=%.2f\n', pF, rF, f1F);
