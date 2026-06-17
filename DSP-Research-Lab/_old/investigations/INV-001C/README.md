# INV-001C: Real-World Validation

## Objetivo
Validar la robustez del detector de clicks (LPC de Orden 2 + Clustering) frente al mayor riesgo técnico en DSP: **El sobreajuste (Overfitting) al dataset sintético**. Se busca responder empírica y cualitativamente: ¿Sigue funcionando la detección en escenarios de audio reales y sucios?

## Dataset
Se recolectó audios reales de estudio, percusión, metal y voces, pasados por el degradador artificial para asegurar ground truth de fallas.

## Resultados y Conclusión
Esta investigación ha finalizado. Se descubrió un **Severo Overfitting**. El detector no es apto para audio del mundo real debido a explosiones de falsos positivos en transitorios.

👉 **Puedes leer el diagnóstico completo y las métricas en:** [reports/INV-001C-Real-World-Validation.md](../../reports/INV-001C-Real-World-Validation.md)
