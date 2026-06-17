%% Evaluador Automático de Grid Search INV-001B
clc; clear;

archivo_gt = '../datasets/ground_truth/inv001_ground_truth.csv';
if ~exist(archivo_gt, 'file')
    error('Ground Truth no encontrado.');
end

gt_data = csvread(archivo_gt, 1, 0);
gt_indices = gt_data(:, 1);
tolerancia = 48000 * 0.005; % 5ms

mejor_f1 = 0;
mejor_id = -1;
mejor_metrics = [];

fprintf('Evaluando %d archivos CSV del Grid Search...\n', 60);

for id = 0:59
    archivo_det = sprintf('../exports/inv001b_det_%d.csv', id);
    if ~exist(archivo_det, 'file')
        continue;
    end
    
    det_data = csvread(archivo_det, 1, 0);
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
    
    if f1 > mejor_f1
        mejor_f1 = f1;
        mejor_id = id;
        mejor_metrics = [tp, fp, fn, precision, recall, f1];
    end
end

fprintf('\n--- MEJOR RESULTADO (GRID SEARCH) ---\n');
fprintf('ID Ganador: %d\n', mejor_id);
fprintf('TP: %d\nFP: %d\nFN: %d\n', mejor_metrics(1), mejor_metrics(2), mejor_metrics(3));
fprintf('Precision: %.4f\nRecall: %.4f\nF1 Score: %.4f\n', mejor_metrics(4), mejor_metrics(5), mejor_metrics(6));
