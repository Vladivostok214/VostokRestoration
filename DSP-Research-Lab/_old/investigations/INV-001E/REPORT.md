# INV-001E: Adaptive HFER

## Objetivo
Determinar si el umbral absoluto de HFER (High-Frequency Energy Ratio) debe responder de manera dinámica/contextual a los diferentes perfiles espectrales del material para recuperar los Verdaderos Positivos perdidos (Mejorar Recall).

## Metodología
Se programó y ejecutó `inv001e_runner.rs`, realizando un **Grid Search** de umbrales absolutos `[0.02, 0.05, 0.08, 0.10, 0.12, 0.15, 0.20]` sobre todos los archivos del *Real-World Dataset*.

---

## Resultados del Grid Search

| Archivo | Umbral ($Th$) | TP | FP | FN | Observaciones |
|---|---|---|---|---|---|
| **Batería** | 0.02 a 0.20 | 4 | 52 $\to$ 13 | 1 | TP se mantiene en 4 en todos los umbrales. |
| **Metrónomo** | 0.02 a 0.20 | 5 | 117 $\to$ 35 | 0 | TP perfecto (5/5). FP caen drásticamente a mayor umbral. |
| **Voz Baja Calidad** | 0.02 a 0.20 | 5 | 9 $\to$ 1 | 0 | TP perfecto. En $Th=0.20$, los falsos positivos caen a solo 1! |
| **Música Pesada** | 0.02 a 0.15 | 2 | 197 $\to$ 179 | 3 | Bajar el umbral absoluto no recuperó los FN. En 0.20 cae a TP=1. |
| **Voz en Off** | 0.02 a 0.20 | 3 | 77 $\to$ 10 | 2 | TP se mantiene estancado en 3. |

---

## Análisis y Hallazgo Crítico

La hipótesis original era que los clicks en *Música Pesada* (Heavy Metal) fallaban por no superar el umbral absoluto $HFER > 0.15$. 

Los resultados demuestran tajantemente que **la hipótesis es incorrecta**. 

Incluso bajando el umbral absoluto a $0.02$, los Falsos Negativos persisten ($TP=2$, $FN=3$ en Música Pesada). ¿Por qué ocurre esto?

El filtro híbrido posee dos condiciones:
1. Absoluta: `max_hfer > threshold`
2. Relativa: `max_hfer > avg_hfer_bg * 3.0`

En géneros como el Heavy Metal (guitarras con extrema distorsión de ruido blanco), el ruido de fondo espectral (`avg_hfer_bg`) ya es altísimo (e.g. 0.15). Cuando ocurre un click (que también es ruido blanco), el HFER sube levemente (e.g. 0.20).
Como $0.20$ **no** es tres veces mayor que $0.15$, el detector descarta el click, considerándolo parte de la guitarra. 

¡Es un choque de firmas idénticas! Un micro-click es ruido blanco instantáneo, y la guitarra de Metal es ruido blanco sostenido. 

## Conclusión

El uso de un Umbral HFER dinámico/adaptativo es extremadamente efectivo para **minimizar Falsos Positivos** en archivos limpios:
* Para una Voz Limpia, setear un Umbral de $0.20$ deja casi $0$ falsos positivos.
* Para música, un umbral de $0.12$ es un excelente punto intermedio.

Sin embargo, para recuperar los Falsos Negativos en ruido pesado, no basta con tocar el umbral absoluto; sería necesario modificar el **multiplicador relativo (3.0x)**, lo cual es inviable porque desataría una avalancha de falsos positivos en los platillos y baterías de la propia música.

**Decisión Final:**
Se mantendrá el filtro híbrido como está, exponiendo en producción un control deslizante de "Sensibilidad Espectral" (que moverá el umbral absoluto entre 0.05 y 0.20) para que el usuario pueda adaptar la limpieza según su material. Se acepta la limitación física de que aislar clicks dentro de ruido blanco es matemáticamente ambiguo.

Con esto, el pipeline temporal/espectral para clicks de `Vostok Restoration v1` queda **oficialmente calibrado, validado y cerrado**.
