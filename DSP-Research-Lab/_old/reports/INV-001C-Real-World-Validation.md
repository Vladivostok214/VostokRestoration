# Reporte Final: INV-001C Real-World Validation

**Fecha**: Junio 2026
**Estado**: Completado

## Objetivo
Evaluar empíricamente si el algoritmo de detección de micro-clicks óptimo (LPC Orden 2, Umbral 6.0, Ventana 256 + Clustering), calibrado mediante la investigación `INV-001B`, es capaz de mantener su Recall del 100% y una tasa baja de Falsos Positivos al enfrentarse a audios del mundo real en lugar de tonos sintéticos.

## Metodología (Data Augmentation)
Para garantizar un Ground Truth preciso, se utilizó un script en Python (`degradar_audio.py`) que inyecta aberraciones digitales puras (Drops, Clicks, Slips) en pistas comerciales reales. 
Se evaluaron 6 audios representativos de distintos escenarios acústicos (grabaciones de estudio, baterías, música pesada y voces).

## Resultados Cuantitativos (Octave Evaluator)

| Archivo                        | TP    | FP    | FN    | Precision  | Recall     | F1 Score  |
|--------------------------------|-------|-------|-------|------------|------------|-----------|
| bateriacorrupta                | 13    | 593   | 3     | 0.0215     | 0.8125     | 0.0418    |
| musicaconmetronomocorrupta     | 11    | 1051  | 5     | 0.0104     | 0.6875     | 0.0204    |
| musicaenvivocorrupta           | 12    | 441   | 4     | 0.0265     | 0.7500     | 0.0512    |
| musicapesadacorrupta           | 11    | 411   | 5     | 0.0261     | 0.6875     | 0.0502    |
| vozbajacalidadcorrupta         | 14    | 106   | 2     | 0.1167     | 0.8750     | 0.2059    |
| vozenoffcorrupta               | 13    | 698   | 3     | 0.0183     | 0.8125     | 0.0358    |

## Análisis de Falla Crítica (Overfitting)
El algoritmo ha fallado catastróficamente la validación de mundo real:
1. **Pérdida de Recall:** El sistema dejó escapar fallas genuinas (entre 2 y 5 falsos negativos por pista), rompiendo la promesa arquitectónica del 100% lograda en el laboratorio.
2. **Avalancha de Falsos Positivos:** El detector se vuelve inestable ante transitorios naturales (bombos, platillos, sibilancia bucal). Disparó más de 1,000 alarmas falsas en audios rítmicos.

**Diagnóstico DSP:** El umbral fijo multiplicador de RMS (`6.0`) asume un fondo estacionario. En audios fuertemente dinámicos, el filtro adaptativo experimenta picos de error inmensos ante transitorios que no puede predecir matemáticamente, interpretándolos como clics digitales. 

## Conclusión
La investigación certifica un caso severo de **Overfitting** al dataset sintético.
El algoritmo LPC temporal puro con umbrales fijos no es apto para entornos de producción. Será imperativo explorar cruces de dominio (ej. validación espectral cruzada) o redes neuronales especializadas para lograr inmunidad frente a la música compleja.
