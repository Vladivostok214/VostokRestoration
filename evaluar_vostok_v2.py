#!/usr/bin/env python3
"""
Vostok Restoration — DSP Evaluation Engine V2 (LAB-BENCHMARK-V2)
Cruza el Ground Truth v2 (.csv) con el Reporte de Vostok v2 (.txt) soportando
métricas avanzadas por tipo de artefacto, detección de eventos continuos (IoU)
y eventos puntuales (±50ms).
"""

import sys
import csv
import re
from pathlib import Path

# Margen de tolerancia para eventos puntuales (50ms)
PUNCTUAL_TOLERANCE = 0.05
# Tolerancia especial para Pops basados en STFT debido al retardo de ventana (~85ms esperado)
POP_TOLERANCE = 0.10

# Umbral de solapamiento para considerar un MATCH en eventos continuos
# IoU >= 0.20 o solapamiento parcial >= 30% del intervalo del GT o Vostok
IoU_THRESHOLD = 0.20
OVERLAP_PERCENT_THRESHOLD = 0.30

def canonical_type(t_str):
    """Mapea tipos de artefactos a categorías canónicas unificadas."""
    t_str = t_str.lower().strip()
    if "click" in t_str:
        return "Click"
    elif "pop" in t_str:
        return "Pop"
    elif "hum" in t_str:
        return "Hum"
    elif "hiss" in t_str:
        return "Hiss"
    elif "dropout" in t_str:
        return "Dropout"
    elif "clipping" in t_str or "distortion" in t_str:
        return "Clipping"
    return "Other"

def is_continuous_type(c_type):
    """Determina si un tipo de anomalía es continua o puntual por naturaleza."""
    return c_type in ["Hum", "Hiss", "Dropout"]

def parse_single_time(t_str):
    """Convierte un timestamp (segundos o MM:SS.mmm) a float de segundos."""
    t_str = t_str.strip()
    if ":" in t_str:
        parts = t_str.split(":")
        if len(parts) == 2:
            return float(parts[0]) * 60 + float(parts[1])
        elif len(parts) == 3:
            return float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2])
    return float(t_str)

def parse_vostok_time(time_str):
    """Parsea el formato de tiempo de Vostok que puede ser puntual o rango."""
    time_str = time_str.strip()
    if "->" in time_str:
        parts = time_str.split("->")
        return parse_single_time(parts[0]), parse_single_time(parts[1])
    else:
        t = parse_single_time(time_str)
        return t, t

def cargar_ground_truth(ruta):
    """Lee el Ground Truth V2 CSV."""
    eventos = []
    with open(ruta, mode='r', encoding='utf-8') as f:
        # Detectar delimitador leyendo la primera línea
        first_line = f.readline()
        f.seek(0)
        delimiter = ';' if ';' in first_line else ','
        
        reader = csv.reader(f)
        header = next(reader)
        
        # Mapeo de columnas por nombre o por índice si no hay coincidencia exacta
        h_lower = [h.lower().strip() for h in header]
        
        col_start = h_lower.index("starttime") if "starttime" in h_lower else 0
        col_end = h_lower.index("endtime") if "endtime" in h_lower else 1
        col_type = h_lower.index("artifacttype") if "artifacttype" in h_lower else 2
        col_mag = h_lower.index("magnitude") if "magnitude" in h_lower else 3
        col_meta = h_lower.index("metadata") if "metadata" in h_lower else 4
        
        for idx, row in enumerate(reader):
            if not row or len(row) <= max(col_start, col_end, col_type):
                continue
            try:
                start = float(row[col_start])
                end = float(row[col_end])
                raw_type = row[col_type]
                c_type = canonical_type(raw_type)
                
                eventos.append({
                    "id": f"GT-{idx+1:03d}",
                    "start": start,
                    "end": end,
                    "raw_type": raw_type,
                    "type": c_type,
                    "matched": False,
                    "matched_with": None,
                    "misclassified": False
                })
            except Exception as e:
                # Saltar líneas mal formateadas
                continue
    return eventos

def cargar_vostok_txt(ruta):
    """Parsea el reporte visual de Vostok de tipo v2."""
    eventos = []
    # Expresión regular para capturar la línea del reporte de Vostok
    # Ejemplo: [01] PENDIENTE | 02:00.442 -> 02:04.343 | HISS | Canal: Ambos | ...
    pattern = re.compile(r"\[(\d+)\]\s+(PENDIENTE|REPARADO)\s*\|\s*([^|]+)\|\s*([^|]+)")
    
    with open(ruta, mode='r', encoding='utf-8') as f:
        for idx, line in enumerate(f):
            match = pattern.search(line)
            if match:
                idx_str = match.group(1)
                time_segment = match.group(3).strip()
                raw_type = match.group(4).strip()
                
                try:
                    start, end = parse_vostok_time(time_segment)
                    c_type = canonical_type(raw_type)
                    
                    eventos.append({
                        "id": f"VOS-{idx_str}",
                        "start": start,
                        "end": end,
                        "raw_type": raw_type,
                        "type": c_type,
                        "matched": False,
                        "matched_with": None,
                        "misclassified": False
                    })
                except Exception as e:
                    continue
    return eventos

def calcular_iou_y_overlap(s1, e1, s2, e2):
    """Calcula IoU y el porcentaje de solapamiento sobre los dos intervalos."""
    intersection = max(0.0, min(e1, e2) - max(s1, s2))
    if intersection <= 0:
        return 0.0, 0.0, 0.0
    
    union = max(e1, e2) - min(s1, s2)
    len1 = e1 - s1
    len2 = e2 - s2
    
    iou = intersection / union if union > 0 else 0.0
    overlap_pct1 = intersection / len1 if len1 > 0 else 0.0
    overlap_pct2 = intersection / len2 if len2 > 0 else 0.0
    
    return iou, overlap_pct1, overlap_pct2

def evaluar_vostok_v2(ruta_gt, ruta_vostok):
    gt_events = cargar_ground_truth(ruta_gt)
    vos_events = cargar_vostok_txt(ruta_vostok)
    
    # --- FASE 1: Cruce de Mismo Tipo Canónico (Matches Exactos) ---
    for gt in gt_events:
        best_match = None
        best_score = -1.0
        
        for vos in vos_events:
            if vos["matched"] or vos["type"] != gt["type"]:
                continue
            
            # Un evento se considera continuo en la práctica si ambos tienen duración significativa (>50ms).
            # Si uno es de corta duración o se reportó como puntual, se evalúa por proximidad temporal.
            gt_duration = gt["end"] - gt["start"]
            vos_duration = vos["end"] - vos["start"]
            is_continuous = is_continuous_type(gt["type"]) and gt_duration > 0.05 and vos_duration > 0.05
            
            if is_continuous:
                # Caso Continuo: Solapamiento
                iou, o_gt, o_vos = calcular_iou_y_overlap(gt["start"], gt["end"], vos["start"], vos["end"])
                if iou >= IoU_THRESHOLD or o_gt >= OVERLAP_PERCENT_THRESHOLD or o_vos >= OVERLAP_PERCENT_THRESHOLD:
                    score = max(iou, o_gt, o_vos)
                    if score > best_score:
                        best_score = score
                        best_match = vos
            else:
                # Caso Puntual: Proximidad temporal
                # Medimos la distancia entre sus tiempos de inicio
                dist = abs(gt["start"] - vos["start"])
                tolerance = POP_TOLERANCE if gt["type"] == "Pop" else PUNCTUAL_TOLERANCE
                if dist <= tolerance:
                    score = 1.0 - (dist / tolerance)
                    if score > best_score:
                        best_score = score
                        best_match = vos
                        
        if best_match is not None:
            gt["matched"] = True
            gt["matched_with"] = best_match["id"]
            best_match["matched"] = True
            best_match["matched_with"] = gt["id"]

    # --- FASE 2: Detección de Eventos Mal Clasificados (Mismo tiempo, distinto tipo) ---
    for gt in gt_events:
        if gt["matched"]:
            continue
            
        best_match = None
        best_score = -1.0
        
        for vos in vos_events:
            if vos["matched"]:
                continue
            
            gt_duration = gt["end"] - gt["start"]
            vos_duration = vos["end"] - vos["start"]
            is_continuous = (is_continuous_type(gt["type"]) or is_continuous_type(vos["type"])) and gt_duration > 0.05 and vos_duration > 0.05
            
            # Buscamos superposición física sin importar el tipo
            if is_continuous:
                iou, o_gt, o_vos = calcular_iou_y_overlap(gt["start"], gt["end"], vos["start"], vos["end"])
                if iou >= IoU_THRESHOLD or o_gt >= OVERLAP_PERCENT_THRESHOLD or o_vos >= OVERLAP_PERCENT_THRESHOLD:
                    score = max(iou, o_gt, o_vos)
                    if score > best_score:
                        best_score = score
                        best_match = vos
            else:
                dist = abs(gt["start"] - vos["start"])
                tolerance = POP_TOLERANCE if (gt["type"] == "Pop" or vos["type"] == "Pop") else PUNCTUAL_TOLERANCE
                if dist <= tolerance:
                    score = 1.0 - (dist / tolerance)
                    if score > best_score:
                        best_score = score
                        best_match = vos
                        
        if best_match is not None:
            gt["matched"] = True  # Marcado como "procesado" en la clasificación
            gt["misclassified"] = True
            gt["matched_with"] = f"{best_match['id']} (Tipo real: {gt['type']}, Detectado: {best_match['type']})"
            
            best_match["matched"] = True
            best_match["misclassified"] = True
            best_match["matched_with"] = f"{gt['id']} (Tipo real: {gt['type']}, Detectado: {best_match['type']})"

    # --- FASE 3: Clasificación Final y Métricas ---
    tipos = ["Click", "Pop", "Hum", "Hiss", "Dropout", "Clipping"]
    metricas = {t: {"TP": 0, "FP": 0, "FN": 0, "MC": 0} for t in tipos}
    metricas["Global"] = {"TP": 0, "FP": 0, "FN": 0, "MC": 0}
    
    omitidos = []
    falsos = []
    mal_clasificados = []
    
    # Procesar GT (TPs, FNs y Mal Clasificados)
    for gt in gt_events:
        t = gt["type"]
        if t not in metricas:
            continue
            
        if gt["matched"] and not gt["misclassified"]:
            metricas[t]["TP"] += 1
            metricas["Global"]["TP"] += 1
        elif gt["misclassified"]:
            metricas[t]["FN"] += 1  # No se detectó el tipo correcto
            metricas[t]["MC"] += 1
            metricas["Global"]["FN"] += 1
            metricas["Global"]["MC"] += 1
            mal_clasificados.append(gt)
        else:
            metricas[t]["FN"] += 1
            metricas["Global"]["FN"] += 1
            omitidos.append(gt)
            
    # Procesar Vostok (FPs y Falsos Positivos puros)
    for vos in vos_events:
        t = vos["type"]
        if t not in metricas:
            continue
            
        if not vos["matched"]:
            metricas[t]["FP"] += 1
            metricas["Global"]["FP"] += 1
            falsos.append(vos)
        elif vos["misclassified"]:
            metricas[t]["FP"] += 1  # Cuenta como una falsa alarma del tipo detectado
            # Ya se agregó a mal_clasificados a través de gt

    # Imprimir Reporte de Laboratorio
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("            VOSTOK DSP BENCHMARK V2            ")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    
    # Resumen Global
    tp_g = metricas["Global"]["TP"]
    fp_g = metricas["Global"]["FP"]
    fn_g = metricas["Global"]["FN"]
    mc_g = metricas["Global"]["MC"]
    
    total_injected = len(gt_events)
    total_detected = len(vos_events)
    
    print("📊 RESUMEN GLOBAL")
    print(f"  • Inyectados (Ground Truth) : {total_injected}")
    print(f"  • Reportados por Vostok     : {total_detected}")
    print(f"  • Aciertos Netos (TP)       : {tp_g}")
    print(f"  • Errores de Tipo (MC)      : {mc_g}")
    print(f"  • Omisiones Totales (FN)    : {fn_g - mc_g}")
    print(f"  • Alarmas Falsas (FP)       : {fp_g}\n")
    
    # Métricas Globales
    precision_g = tp_g / (tp_g + fp_g) if (tp_g + fp_g) > 0 else 0.0
    recall_g = tp_g / (tp_g + fn_g) if (tp_g + fn_g) > 0 else 0.0
    f1_g = 2 * precision_g * recall_g / (precision_g + recall_g) if (precision_g + recall_g) > 0 else 0.0
    
    print("⚡ MÉTRICAS GLOBALES")
    print(f"  • Precision : {precision_g*100:.2f}%")
    print(f"  • Recall    : {recall_g*100:.2f}%")
    print(f"  • F1 Score  : {f1_g*100:.2f}%\n")
    
    # Tabla de métricas por detector
    print("🔬 MÉTRICAS POR DETECTOR")
    print("┌──────────┬──────────┬──────────┬──────────┬──────────┬──────────┐")
    print("│ Detector │    TP    │    FP    │    FN    │ Precision│  Recall  │")
    print("├──────────┼──────────┼──────────┼──────────┼──────────┼──────────┤")
    
    ranking_data = []
    for t in tipos:
        tp = metricas[t]["TP"]
        fp = metricas[t]["FP"]
        fn = metricas[t]["FN"]
        
        prec = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        rec = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1 = 2 * prec * rec / (prec + rec) if (prec + rec) > 0 else 0.0
        
        ranking_data.append((t, f1, prec, rec))
        print(f"│ {t:<8} │ {tp:^8} │ {fp:^8} │ {fn:^8} │ {prec*100:6.1f}% │ {rec*100:6.1f}% │")
        
    print("└──────────┴──────────┴──────────┴──────────┴──────────┴──────────┘\n")
    
    # Ranking de Detectores (por F1-Score)
    ranking_data.sort(key=lambda x: x[1], reverse=True)
    print("🏆 RANKING DE DETECTORES (Por F1-Score)")
    for pos, (t, f1, prec, rec) in enumerate(ranking_data, 1):
        print(f"  {pos}. {t:<8} : F1={f1*100:5.1f}%  [Prec={prec*100:5.1f}%, Rec={rec*100:5.1f}%]")
    print()
    
    # Detalle de errores
    if omitidos:
        print("❌ EVENTOS OMITIDOS (Falsos Negativos puros)")
        for gt in omitidos[:15]:
            print(f"  • [{gt['id']}] {gt['type']} | {gt['start']:.3f}s -> {gt['end']:.3f}s")
        if len(omitidos) > 15:
            print(f"  ... y {len(omitidos) - 15} omisiones más.")
        print()
        
    if mal_clasificados:
        print("⚠️ EVENTOS MAL CLASIFICADOS (Error de Tipo)")
        for gt in mal_clasificados[:15]:
            print(f"  • [{gt['id']}] {gt['matched_with']}")
        if len(mal_clasificados) > 15:
            print(f"  ... y {len(mal_clasificados) - 15} clasificaciones incorrectas más.")
        print()
        
    if falsas_alarmas := [f for f in falsos if f['type'] in tipos]:
        print("👻 EVENTOS FALSOS (Falsos Positivos puros)")
        for vos in falsas_alarmas[:15]:
            print(f"  • [{vos['id']}] {vos['type']} | {vos['start']:.3f}s -> {vos['end']:.3f}s")
        if len(falsas_alarmas) > 15:
            print(f"  ... y {len(falsas_alarmas) - 15} alarmas falsas más.")
        print()

if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except Exception:
            pass

    if len(sys.argv) < 3:
        print("💡 Uso: python evaluar_vostok_v2.py <GROUND_TRUTH.csv> <VOSTOK_REPORT.txt>")
        sys.exit(1)
        
    ruta_gt = Path(sys.argv[1].strip("\"'")).resolve()
    ruta_vostok = Path(sys.argv[2].strip("\"'")).resolve()
    
    if not ruta_gt.exists() or not ruta_vostok.exists():
        print("❌ Error: Uno o ambos archivos no existen en las rutas especificadas.")
        sys.exit(1)
        
    evaluar_vostok_v2(ruta_gt, ruta_vostok)
