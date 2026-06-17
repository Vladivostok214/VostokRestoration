% INV-003_generate_dataset.m
% Generador de dataset para caracterización de Hum (INV-003).
%
% Genera señales de prueba para evaluar la capacidad de discriminación 
% del detector de Hum entre interferencia eléctrica real y contenido musical.

clc; clear; close all;

%% 1. Configuración de Parámetros
fs = 48000;
segment_dur = 5; % segundos por segmento
t_seg = (0:segment_dur*fs-1)' / fs;
N_seg = length(t_seg);

dir_corrupted = '../datasets/corrupted/';
dir_gt = '../datasets/ground_truth/';

%% 2. Generación de Segmentos

% Segmento 1: Pure Grid Hum (50Hz)
s1 = 0.05 * sin(2 * pi * 50 * t_seg);

% Segmento 2: Dirty Grid Hum (50Hz + Harmonics + Noise)
s2 = 0.05 * sin(2 * pi * 50 * t_seg) + ...
     0.02 * sin(2 * pi * 150 * t_seg) + ...
     0.01 * sin(2 * pi * 250 * t_seg) + ...
     0.005 * randn(N_seg, 1);

% Segmento 3: Musical Tone (False Positive Candidate)
% 50Hz con vibrato (2Hz) y tremolo (4Hz)
vibrato = 0.5 * sin(2 * pi * 2 * t_seg); % +/- 0.5 Hz
tremolo = 0.8 + 0.2 * sin(2 * pi * 4 * t_seg);
s3 = 0.05 * tremolo .* sin(2 * pi * (50 + vibrato) .* t_seg);

% Segmento 4: Intermittent Hum (1s ON, 1s OFF)
pulse = mod(t_seg, 2) < 1; % 1 segundo ON, 1 segundo OFF
s4 = 0.05 * pulse .* sin(2 * pi * 50 * t_seg);

% Combinar todo
audio_inv003 = [s1; s2; s3; s4];
t_total = (0:length(audio_inv003)-1)' / fs;

%% 3. Exportación
audiowrite(fullfile(dir_corrupted, 'inv003_hum_test.wav'), audio_inv003, fs);

% Ground Truth (Marcando tipos de evento)
fid = fopen(fullfile(dir_gt, 'inv003_ground_truth_hum.csv'), 'w');
fprintf(fid, 'StartTime,EndTime,Label\n');
fprintf(fid, '0,5,PureHum\n');
fprintf(fid, '5,10,DirtyHum\n');
fprintf(fid, '10,15,MusicalTone_FP\n');
fprintf(fid, '15,20,IntermittentHum\n');
fclose(fid);

disp('Dataset INV-003 generado con éxito en datasets/corrupted/inv003_hum_test.wav');
