# Auditoría Técnica: Consolidación de Canales Estéreo (`consolidar_canales_glitches`)
## Vostok Restoration DSP Engine — Investigación LAB-CONSOLIDATION-001

---

### 1. Resumen Ejecutivo

Esta auditoría técnica evalúa el comportamiento de la función `consolidar_canales_glitches` encargada de correlacionar y agrupar anomalías detectadas en canales independientes (Izquierdo `channel=0` y Derecho `channel=1`) para representarlas como eventos estéreo lógicos unificados (`channel=2`). 

El análisis demuestra que el criterio actual de proximidad de inicio temporal ($\Delta t < \text{threshold}$) es intrínsecamente inadecuado para eventos de naturaleza continua (Hiss, Hum, Dropouts prolongados). Esta limitación explica la falta de consolidación del caso real observado en Hiss (desfase de $697\text{ ms}$ en el inicio), resultando en reportes duplicados de la misma anomalía física.

---

### 2. Funcionamiento de la Arquitectura Actual

El algoritmo actual utiliza una estrategia lineal basada en búsqueda secuencial y ventanas fijas:

1. **Clasificación del Umbral de Coincidencia (`threshold`)**:
   * Eventos continuos (`Hum`, `Hiss`): **$250\text{ ms}$**.
   * Eventos transitorios/impulsivos (`Click`, `Pop`, `Distortion`, etc.): **$50\text{ ms}$**.
2. **Procedimiento de Búsqueda**:
   * Para cada evento no consumido $E_i$ (canal $C_A$), busca el primer evento sucesivo $E_j$ (canal $C_B$) del mismo tipo, de canal diferente, cuyo tiempo de inicio difiera en menos del `threshold`:
     $$\left| T_{\text{start}}(E_j) - T_{\text{start}}(E_i) \right| < \text{threshold}$$
3. **Fusión Lógica**:
   * Si se cumple la condición, marca $E_j$ como consumido y modifica $E_i$ para abarcar el rango de ambos:
     * $\text{sample\_index} = \min(\text{index}_i, \text{index}_j)$
     * $\text{time\_secs} = \min(T_i, T_j)$
     * $\text{duration\_samples} = \max(\text{end}_i, \text{end}_j) - \min(\text{index}_i, \text{index}_j)$
     * $\text{channel} = 2$ (Ambos / Estéreo)

---

### 3. Anatomía del Fallo Observado en Hiss

En el caso real documentado, el Hiss estéreo se manifiesta de la siguiente manera:
* **HISS [R]**: $120.442\text{ s} \to 124.343\text{ s}$ (Inicio temprano en canal derecho)
* **HISS [L]**: $121.139\text{ s} \to 124.343\text{ s}$ (Inicio retardado en canal izquierdo)

#### Análisis del Fallo:
* La diferencia entre los inicios de ambos canales es:
  $$\Delta T = 121.139\text{ s} - 120.442\text{ s} = 0.697\text{ s} \quad (697\text{ ms})$$
* Dado que $\Delta T = 697\text{ ms} > 250\text{ ms}$ (threshold para Hiss), el algoritmo determina que son **eventos no relacionados**.
* **Resultado**: No se realiza la fusión estéreo. El usuario recibe dos alertas redundantes en la interfaz, a pesar de que el solapamiento temporal entre ambos es del **$80.3\%$ del tiempo total del evento**.

---

### 4. Evaluación de Estrategias: Eventos Continuos vs. Impulsivos

Es técnicamente correcto y necesario separar los eventos en dos categorías con estrategias de consolidación independientes debido a su naturaleza física:

| Dimensión | Eventos Impulsivos (`Click`, `Pop`, `Distortion`) | Eventos Continuos (`Hiss`, `Hum`, `Dropout`) |
| :--- | :--- | :--- |
| **Naturaleza Temporal** | Transitorio inmediato ($<50\text{ ms}$). | Fenómeno de fondo estacionario o de larga duración ($>1.5\text{ s}$). |
| **Criterio Físico** | Proximidad de impulso. Un click estéreo real ocurre casi de forma simultánea en muestras de ambos canales debido a desgaste o rayones físicos que afectan a todo el surco/cinta. | **Solapamiento Espectral/Temporal**. El ruido ocurre en paralelo pero su cruce de umbral depende de modulaciones de la señal principal. |
| **Estrategia Óptima** | **Umbral de Proximidad Corto (50ms)**. Si el desfase es mayor, son clicks espacialmente distintos (izquierdo o derecho) y deben tratarse por separado. | **Intersección / Solapamiento de Intervalos**. Si hay una coincidencia temporal significativa, se trata del mismo evento de ruido de fondo. |

---

### 5. Análisis de la Propuesta: Consolidación por Intervalos (Solapamiento)

#### Algoritmo Propuesto
Para dos eventos del mismo tipo y canales complementarios:
Si se solapan temporalmente, es decir:
$$[T_{\text{start}}(L), T_{\text{end}}(L)] \cap [T_{\text{start}}(R), T_{\text{end}}(R)] \neq \emptyset$$
Consolidar en:
* $\text{Start} = \min(L_{\text{start}}, R_{\text{start}})$
* $\text{End} = \max(L_{\text{end}}, R_{\text{end}})$
* $\text{Channel} = 2$ (Estéreo)

#### Ventajas:
1. **Eliminación Total de Duplicaciones**: Consolida de forma determinista ruidos de fondo (Hum, Hiss) que coexisten en ambos canales sin importar cuál cruzó primero el umbral.
2. **Robustez ante Diferencias de Paneo**: Inmune a las variaciones de amplitud locales de cada canal que desfasan los tiempos de inicio detectados.
3. **Presentación de UI Limpia**: Reporta un único bloque de restauración por archivo en lugar de fragmentos desalineados por canal.

#### Riesgos y Efectos Secundarios:
1. **Fusión de Eventos Distantes por Huecos**: Si existe un "hueco de enmascaramiento" corto, ¿podría la consolidación por intervalos propagar fusiones incorrectas? 
   * *Mitigación*: El algoritmo debe ejecutarse *después* de que cada canal haya consolidado localmente sus huecos mediante sus respectivos `gap_tolerance`.
2. **Pérdida de la Identidad del Canal**: Si el Hiss solo está presente en el canal izquierdo al inicio del archivo y luego se desplaza al derecho, unificar el rango completo como estéreo podría inducir al proceso de reparación a procesar innecesariamente zonas sin ruido en el canal alterno.
   * *Mitigación*: En el siseo de cinta analógica (Hiss) y Hum electromagnético, el fenómeno es físico del medio de reproducción y siempre afecta a ambos canales a la vez, por lo que el procesamiento estéreo es el comportamiento deseado.

#### Compatibilidad con Restauración Selectiva por Canal:
* Si el motor de audio permite desactivar o procesar canales por separado (p. ej., restaurar solo el canal Izquierdo), consolidar en `channel=2` (ambos) elimina la información de cuál canal tenía el siseo más severo. Sin embargo, para Hiss y Hum, la restauración suele ser global. Si en el futuro se requiere restauración selectiva fina, el modelo `GlitchEvent` debería conservar las amplitudes y niveles de siseo individuales como metadatos internos, aunque en la UI se exponga un único evento unificado.

---

### 6. Recomendación Final

Se recomienda **aprobar la transición a un algoritmo de consolidación basado en intervalos para eventos continuos** (`Hiss`, `Hum` y `Dropout`). La estrategia actual de ventana de proximidad de inicio se mantendrá exclusivamente para eventos transitorios (`Click`, `Pop`, `Distortion`).

La implementación de este cambio se planificará para la siguiente iteración experimental (Fase de Código).
