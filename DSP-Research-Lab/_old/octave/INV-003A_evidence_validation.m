% INV-003A_evidence_validation.m
% Script de validación de evidencias para Hum (INV-003A).
% Evalúa: Magnitud, Estabilidad Armónica, Flux y Coherencia de Fase.

clc; clear; close all;

%% 1. Configuración
fs = 48000;
fft_size = 4096; % HumMasteringMode
hop_size = 1024;
% Hann window pura
n = (0:fft_size-1)';
win = 0.5 * (1 - cos(2 * pi * n / (fft_size - 1)));

% Cargar dataset generado en INV-003
try
    [audio, fs_audio] = audioread('../datasets/corrupted/inv003_hum_test.wav');
catch
    error('Dataset inv003_hum_test.wav no encontrado. Ejecutar INV-003_generate_dataset.m primero.');
end

%% 2. Procesamiento STFT Manual (para control total de fase)
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

%% 3. Cálculo de Evidencias

% Evidencia C: Spectral Flux (Distancia Euclídea entre frames)
flux = sum((mags(2:end, :) - mags(1:end-1, :)).^2, 2);

% Evidencia F: Coherencia de Fase (Delta Phase)
% Calculamos la diferencia de fase y la normalizamos
phase_diff = diff(phases, 1, 1);
phase_stability = var(phase_diff, 0, 1); % Varianza de la fase por bin a lo largo del tiempo

% Segmentos definidos en INV-003 (5s cada uno)
% Seg 1: Pure Hum (0-5s) -> Frames ~ 1 a 230
% Seg 2: Dirty Hum (5-10s) -> Frames ~ 231 a 460
% Seg 3: Musical Tone (10-15s) -> Frames ~ 461 a 690
% Seg 4: Intermittent (15-20s) -> Frames ~ 691 a 920

frames_per_seg = floor(5 * fs / hop_size);

%% 4. Análisis de Separabilidad en 50Hz (Bin ~5)
bin_50hz = round(50 * fft_size / fs) + 1;

fprintf('--- Validación de Evidencias (Bin %d: 50Hz) ---\n', bin_50hz);

% Comparar Hum Puro (Seg 1) vs Musical (Seg 3)
hum_mag = mags(1:frames_per_seg, bin_50hz);
mus_mag = mags(2*frames_per_seg+1:3*frames_per_seg, bin_50hz);

fprintf('Magnitud Media (Hum): %.4f\n', mean(hum_mag));
fprintf('Magnitud Media (Music): %.4f\n', mean(mus_mag));
fprintf('Variabilidad Mag (Hum CV): %.4f\n', std(hum_mag)/mean(hum_mag));
fprintf('Variabilidad Mag (Music CV): %.4f\n', std(mus_mag)/mean(mus_mag));

% Estabilidad de Fase (Varianza de la diferencia de fase)
hum_phase_var = var(phase_diff(1:frames_per_seg-1, bin_50hz));
mus_phase_var = var(phase_diff(2*frames_per_seg+1:3*frames_per_seg-1, bin_50hz));

fprintf('Varianza de Fase (Hum): %.4f\n', hum_phase_var);
fprintf('Varianza de Fase (Music): %.4f\n', mus_phase_var);

%% 5. Visualización (Omitido para evitar errores de sistema)
% figure;
% subplot(2,1,1);
% plot(mags(:, bin_50hz));
% title('Magnitud en 50Hz a lo largo del tiempo');
% ylabel('Amplitud');
% grid on;
% 
% subplot(2,1,2);
% plot(abs(phase_diff(:, bin_50hz)));
% title('Diferencia de Fase (Consecutiva) en 50Hz');
% ylabel('|Delta Phase|');
% grid on;
% 
% saveas(gcf, 'investigations/INV-003A/evidence_analysis.png');

fprintf('\nAnálisis completado.\n');
