% INV-001_evaluate.m
% Evalúa las detecciones del DSP vs Ground Truth y calcula métricas
%
% Requisitos:
% - ../datasets/ground_truth/inv001_ground_truth.csv
% - ../exports/inv001_detections.csv (generado por el motor DSP)

clc; clear; close all;

%% 1. Cargar Datos
archivo_gt = '../datasets/ground_truth/inv001_ground_truth.csv';
archivo_det = '../exports/inv001_detections.csv';

if ~exist(archivo_gt, 'file')
    error('No se encuentra el Ground Truth.');
end

% Leer csv omitiendo la cabecera (1 fila)
gt_data = csvread(archivo_gt, 1, 0);
gt_indices = gt_data(:, 1);

% Simular detecciones si el motor DSP aún no ha exportado resultados
if ~exist(archivo_det, 'file')
    warning('Archivo de detecciones no encontrado. Generando métricas falsas para ilustrar el script.');
    % Añadir un poco de error al GT simulando falsos positivos y negativos
    det_indices = [gt_indices(1:end-2); randi([1, 480000], 3, 1)];
else
    det_data = csvread(archivo_det, 1, 0);
    if isempty(det_data)
        det_indices = [];
    else
        det_indices = det_data(:, 1);
    end
end

%% 2. Parámetros de Tolerancia
tolerancia_samples = 256; % Margen de error aceptable en detección de índice

%% 3. Evaluación (Precisión y Recall)
tp = 0; % True Positives
fp = 0; % False Positives
matched_gt = false(length(gt_indices), 1);

for i = 1:length(det_indices)
    det_val = det_indices(i);
    % Encontrar el GT más cercano
    distancias = abs(gt_indices - det_val);
    [min_dist, min_idx] = min(distancias);
    
    if min_dist <= tolerancia_samples && ~matched_gt(min_idx)
        tp = tp + 1;
        matched_gt(min_idx) = true;
    else
        fp = fp + 1;
    end
end

fn = sum(~matched_gt); % False Negatives
tn = 0; % En detección de eventos en tiempo continuo, TN es ambiguo. No se suele usar, pero definimos FPR de otra manera.

% Métricas
precision = tp / (tp + fp + eps);
recall = tp / (tp + fn + eps);
f1_score = 2 * (precision * recall) / (precision + recall + eps);

%% 4. Imprimir Resultados
fprintf('--- RESULTADOS INV-001 CLICK DETECTOR ---\n');
fprintf('True Positives (TP) : %d\n', tp);
fprintf('False Positives (FP): %d\n', fp);
fprintf('False Negatives (FN): %d\n', fn);
fprintf('-----------------------------------------\n');
fprintf('Precision : %.4f\n', precision);
fprintf('Recall    : %.4f\n', recall);
fprintf('F1 Score  : %.4f\n', f1_score);

%% 5. Histogramas y Curvas (Ejemplo visual)
% Aquí se cargarían los features (Crest Factor, Bandwidth) exportados por el DSP
% para cada frame, y se graficarían sus distribuciones empíricas.

% figure;
% hist(crest_factors_clicks, 50, 'r'); hold on;
% hist(crest_factors_clean, 50, 'b');
% title('Distribución de Crest Factor');
% legend('Clicks', 'Audio Limpio');
