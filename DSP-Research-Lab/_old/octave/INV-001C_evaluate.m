%% Evaluador de Mundo Real INV-001C
clc; clear;

test_dir = '../../TestSamples/';
export_dir = '../exports/';

archivos = {
    'bateriacorrupta',
    'musicaconmetronomocorrupta',
    'musicaenvivocorrupta',
    'musicapesadacorrupta',
    'vozbajacalidadcorrupta',
    'vozenoffcorrupta'
};

fprintf('\n=== RESULTADOS INV-001C: VALIDACION EN MUNDO REAL ===\n');
fprintf('%-30s | %-5s | %-5s | %-5s | %-10s | %-10s | %-10s\n', 'Archivo', 'TP', 'FP', 'FN', 'Precision', 'Recall', 'F1 Score');
fprintf(repmat('-', 1, 95));
fprintf('\n');

tolerancia = 48000 * 0.005; % 5ms

for i = 1:length(archivos)
    nombre = archivos{i};
    archivo_gt = fullfile(test_dir, [nombre '_gt.csv']);
    archivo_det = fullfile(export_dir, [nombre '_det.csv']);
    
    if ~exist(archivo_gt, 'file') || ~exist(archivo_det, 'file')
        continue;
    end
    
    gt_data = csvread(archivo_gt, 1, 0);
    if isempty(gt_data)
        gt_indices = [];
    else
        gt_indices = gt_data(:, 1);
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
        if isempty(gt_indices)
            continue;
        end
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
    
    fprintf('%-30s | %-5d | %-5d | %-5d | %-10.4f | %-10.4f | %-10.4f\n', nombre, tp, fp, fn, precision, recall, f1);
end
fprintf('\n');
