# INV-001B: LPC Detector Optimization

## Objetivo
Optimizar los parámetros y la lógica de agrupamiento del detector ganador (LPC / Predicción Lineal LMS) de la `INV-001A`. El objetivo principal era reducir los Falsos Positivos de ~104 a `< 20`, manteniendo el **Recall en ~100%**.

## Dataset
Se utilizó exactamente el mismo dataset `inv001_synthetic_corrupted.wav` y su respectivo Ground Truth.

## Resultados y Conclusión
La investigación ha finalizado con éxito rotundo. El algoritmo de Clustering eliminó el 70% de los falsos positivos (ringing). El barrido paramétrico demostró que un filtro LPC de bajo orden (Order=2) generaliza mejor y evita sobre-ajustarse a los clicks.

**Objetivos cumplidos:**
- Recall: 100%
- Falsos Positivos: 19 (< 20)
- F1 Score: 0.6780

👉 **Puedes leer el reporte final, métricas completas y la configuración óptima en:** [reports/INV-001B-LPC-Optimization.md](../../reports/INV-001B-LPC-Optimization.md)
