%% Evaluador INV-001A: Micro-Click Detection Study
clc; clear;

archivo_gt = '../datasets/ground_truth/inv001_ground_truth.csv';
archivos_det = {
    '../exports/inv001a_det_A.csv',
    '../exports/inv001a_det_B.csv',
    '../exports/inv001a_det_C.csv',
    '../exports/inv001a_det_D.csv',
    '../exports/inv001a_det_E.csv'
};
nombres = {'Candidato A (Naive)', 'Candidato B (Robust)', 'Candidato C (Z-Score)', 'Candidato D (LPC)', 'Candidato E (LPC+ZScore)'};

if ~exist(archivo_gt, 'file')
    error('Ground Truth no encontrado.');
end

gt_data = csvread(archivo_gt, 1, 0);
gt_indices = gt_data(:, 1);

fprintf('\n=== RESULTADOS INV-001A: COMPARATIVA F1 SCORE ===\n');
fprintf('%-25s | %-5s | %-5s | %-5s | %-10s | %-10s | %-10s\n', 'Algoritmo', 'TP', 'FP', 'FN', 'Precision', 'Recall', 'F1 Score');
fprintf(repmat('-', 1, 90));
fprintf('\n');

tolerancia = 48000 * 0.005; % 5ms

for i = 1:length(archivos_det)
    if ~exist(archivos_det{i}, 'file')
        continue;
    end
    
    det_data = csvread(archivos_det{i}, 1, 0);
    if isempty(det_data)
        det_indices = [];
    else
        det_indices = det_data(:, 1);
    end
    
    tp = 0;
    gt_detectados = false(size(gt_indices));
    for d = 1:length(det_indices)
        idx_det = det_indices(d);
        diffs = abs(gt_indices - idx_det);
        [min_diff, idx_gt] = min(diffs);
        
        if min_diff <= tolerancia && ~gt_detectados(idx_gt)
            tp = tp + 1;
            gt_detectados(idx_gt) = true;
        end
    end
    
    fp = length(det_indices) - tp;
    fn = length(gt_indices) - tp;
    
    precision = tp / (tp + fp + eps);
    recall = tp / (tp + fn + eps);
    f1 = 2 * (precision * recall) / (precision + recall + eps);
    
    fprintf('%-25s | %-5d | %-5d | %-5d | %-10.4f | %-10.4f | %-10.4f\n', nombres{i}, tp, fp, fn, precision, recall, f1);
end
fprintf('\n');
