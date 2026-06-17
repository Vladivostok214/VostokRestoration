% INV-001_generate_dataset.m
% Generador de dataset sintético para calibración del detector de clicks.
%
% Este script genera un archivo de audio WAV limpio (compuesto de tonos y ruido
% simulando consonantes y transitorios musicales), le inyecta clicks artificiales,
% y exporta el audio corrupto junto con su Ground Truth.

clc; clear; close all;

%% 1. Configuración de Parámetros
fs = 48000;          % Frecuencia de muestreo (Hz)
duracion = 10;       % Duración en segundos
t = (0:duracion*fs-1)' / fs;
N = length(t);

% Carpetas de salida
dir_clean = '../datasets/clean/';
dir_corrupted = '../datasets/corrupted/';
dir_gt = '../datasets/ground_truth/';

%% 2. Generación de Audio Limpio (Señal Base)
% Mezcla de un tono de 440 Hz (Música), ruido blanco filtrado (Consonantes vocales)
% y pulsos de baja frecuencia periódicos (Kicks/Transitorios musicales lícitos).

f_tono = 440;
s_tono = 0.3 * sin(2 * pi * f_tono * t);

% Transitorios lícitos (Kicks a 120 BPM = 2 Hz)
s_kicks = zeros(N, 1);
idx_kicks = 1 : (fs/2) : N;
for i = 1:length(idx_kicks)
    if idx_kicks(i) < N
        s_kicks(idx_kicks(i):min(idx_kicks(i)+1000, N)) = 0.6 * exp(-linspace(0,10, min(1001, N-idx_kicks(i)+1)))';
    end
end

% Consonantes fricativas (ruido blanco en pulsos)
s_fricativas = 0.1 * randn(N, 1) .* (sin(2 * pi * 0.5 * t) > 0.8);

audio_limpio = s_tono + s_kicks + s_fricativas;
audio_limpio = audio_limpio / max(abs(audio_limpio)) * 0.8; % Normalizar al 80%

%% 3. Generación de Clicks Artificiales (Corrupción)
num_clicks = 20;
audio_corrupto = audio_limpio;

% Ground truth
gt_indices = zeros(num_clicks, 1);
gt_tiempos = zeros(num_clicks, 1);

% Inserción aleatoria
rng(42); % Semilla fija para reproducibilidad
posiciones = randperm(N - 100, num_clicks);
posiciones = sort(posiciones);

for i = 1:num_clicks
    pos = posiciones(i);
    % Click sintético (impulso rápido de 1 a 3 muestras)
    ancho_click = randi([1, 3]);
    amplitud_click = 0.5 + 0.5 * rand(); % Amplitud entre 0.5 y 1.0
    signo = sign(randn());
    
    for j = 1:ancho_click
        audio_corrupto(pos + j - 1) = audio_corrupto(pos + j - 1) + signo * amplitud_click;
    end
    
    gt_indices(i) = pos;
    gt_tiempos(i) = pos / fs;
end

% Normalizar corrupto previniendo digital clipping absoluto en el wav si pasara de 1.0, 
% pero idealmente el detector DSP busca >= 0.99 para clipping. 
% Los clicks se dejarán saturar hasta 1.0 si es necesario para simular clicks agresivos.
audio_corrupto = max(min(audio_corrupto, 1.0), -1.0);

%% 4. Exportación
% Guardar WAVs
audiowrite(fullfile(dir_clean, 'inv001_synthetic_clean.wav'), audio_limpio, fs);
audiowrite(fullfile(dir_corrupted, 'inv001_synthetic_corrupted.wav'), audio_corrupto, fs);

% Guardar Ground Truth en CSV
fid = fopen(fullfile(dir_gt, 'inv001_ground_truth.csv'), 'w');
fprintf(fid, 'SampleIndex,TimeSeconds\n');
for i = 1:num_clicks
    fprintf(fid, '%d,%f\n', gt_indices(i), gt_tiempos(i));
end
fclose(fid);

disp('Dataset INV-001 generado con éxito.');
