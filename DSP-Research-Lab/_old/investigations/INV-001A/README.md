# INV-001A: Micro-Click Detection Study

## Objetivo
Realizar una comparativa cuantitativa exhaustiva entre distintos algoritmos de detección en el dominio temporal para micro-clicks. Se busca el algoritmo con el mayor F1 Score (inmunidad a transitorios musicales) y el mejor rendimiento computacional.

## Dataset
Se utilizará exactamente el mismo dataset generado en `INV-001` (`datasets/corrupted/inv001_synthetic_corrupted.wav` y `datasets/ground_truth/inv001_ground_truth.csv`).

## Resultados y Conclusión
Esta investigación ha finalizado. El ganador arquitectónico fue el **Candidato D (Predicción Lineal Adaptativa LMS)**, demostrando superioridad total (100% Recall, baja tasa de falsos positivos y consumo inferior al 1% CPU). 

👉 **Puedes leer el reporte final y las métricas completas en:** [reports/INV-001A-Micro-Click-Detection.md](../../reports/INV-001A-Micro-Click-Detection.md)
