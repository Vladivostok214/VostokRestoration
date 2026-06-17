# INV-003A-Hum-Evidence-Validation: Informe de Validación

**Investigador:** Gemini DSP Research Agent
**Fecha:** Junio 2026
**Referencia:** INV-003, AF-001 → AF-010

---

## 1. Resultados Experimentales (Bin 5: 50Hz)

Se evaluó la separabilidad entre **Hum Real** (Segmento 1) y **Contenido Musical Engañoso** (Segmento 3: 50Hz con vibrato y trémolo).

| Métrica | Hum Eléctrico | Tono Musical (FP) | Ratio de Separabilidad |
| :--- | :--- | :--- | :--- |
| **Magnitud Media** | 48.88 | 24.88 | 1.96x |
| **Variabilidad (CV)** | **0.0006** | **0.5917** | **986x** |
| **Varianza de Fase** | **2.3880** | **4.9897** | **2.09x** |

---

## 2. Análisis de Evidencias

### Evidencia E: Estabilidad de Magnitud (GANADORA)
La variabilidad de la magnitud (Coeficiente de Variación) demostró ser la evidencia con mayor poder discriminante. Mientras que el Hum es casi perfectamente plano (CV = 0.0006), el tono musical con trémolo genera una fluctuación masiva. El ratio de separación de **986x** la convierte en la métrica más robusta.

### Evidencia F: Coherencia de Fase (SECUNDARIA)
La varianza de la diferencia de fase entre ventanas consecutivas es **2 veces menor** en el Hum que en el tono musical con vibrato. Si bien aporta información única (la inestabilidad del pitch musical), su ratio de separabilidad es significativamente inferior al de la estabilidad de magnitud en este escenario de estrés.

### Evidencia D: Persistencia Temporal (CONFIRMATORIA)
El Hum mantiene su estabilidad durante los 5 segundos del segmento, mientras que el contenido musical (incluso drones) suele tener variaciones micro-espectrales.

---

## 3. Tabla Comparativa de Evidencias

| Evidencia | Separabilidad | Robustez | Complejidad | Recomendación |
| :--- | :--- | :--- | :--- | :--- |
| **Estabilidad Mag** | Excelente (986x) | Alta | Baja | **Primaria** |
| **Coherencia Fase** | Media (2x) | Media | Alta | **Secundaria/Validación** |
| **Spectral Flux** | Alta | Alta | Baja | **Confirmatoria** |
| **Fundamental Fija**| Alta | Baja (FP con notas) | Baja | **Filtro Inicial** |

---

## 4. Casos Límite Identificados

1.  **Drones Electrónicos Estáticos:** Un sintetizador digital sin modulación podría generar un CV de magnitud similar al Hum. En este caso, la **Coherencia de Fase** y la **Serie Armónica Exacta** (Evidencia B) serían los únicos discriminantes.
2.  **Hum Intermitente:** La persistencia temporal fallaría en detectar interferencias que se activan/desactivan rápidamente, requiriendo una reducción del umbral de persistencia sacrificando precisión.

---

## 5. Respuesta a la Investigación Especial

**¿La fase aporta información única?**
SÍ. Aunque la magnitud es más fácil de medir y separar en este experimento, la fase captura la **inestabilidad de la fuente física**. Un instrumento musical, por muy estable que sea, sufre de micro-fluctuaciones de pitch que rompen la coherencia de fase perfecta de la red eléctrica. 

**¿Es suficiente la magnitud?**
Para casos generales, la estabilidad de magnitud (CV) + Persistencia es suficiente. Para escenarios de alta fidelidad con instrumentos tonales profundos (Órgano, Moog), la fase es el "seguro" necesario para evitar falsos positivos destructivos.

---

## 6. Recomendación para INV-003B

Se recomienda que la fase **INV-003B** se centre en la **Arquitectura Híbrida de Triple Capa**:

1.  **Capa 1 (Espectral):** Identificación de candidatos en bins de 50/60Hz y armónicos.
2.  **Capa 2 (Estabilidad):** Filtro de Coeficiente de Variación (CV) de magnitud sobre ventanas de 500ms.
3.  **Capa 3 (Contexto/Fase):** Validación de persistencia y coherencia de fase para el cálculo del *Confidence Score* final.
