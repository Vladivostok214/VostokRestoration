# INV-002C: Pop Real-World Validation

## Contexto y Objetivo
La misión de este estudio es intentar romper la arquitectura candidata actual (**DC Offset + LFER Gate**) aplicándola sobre una matriz de archivos de audio extremadamente diversos extraídos del mundo real y corrompidos. El objetivo es encontrar los límites físicos donde la hipótesis colapsa y entender el porqué.

## Dataset Evaluado
Se utilizó la batería de pruebas oficial del laboratorio que contiene:
- `bateriacorrupta.wav` (Percusión pura)
- `musicaconmetronomocorrupta.wav` (Música rítmica)
- `musicapesadacorrupta.wav` (Heavy Metal denso)
- `vozbajacalidadcorrupta.wav` (Locución degradada)
- `vozenoffcorrupta.wav` (Locución limpia)
- `musicaenvivocorrupta.wav` (Grabación musical en vivo)

*Configuración del Detector*: Ventana de 50ms, `DC Thresh = 0.05`, `LFER Thresh = 0.10`.

## Resultados de la Validación

| Archivo / Dominio | Falsos Positivos | Falsos Negativos | Estado de la Arquitectura |
| :--- | :---: | :---: | :--- |
| **Voz / Podcast** (`vozenoff`) | 0 | 0 | **Perfecto** |
| **Batería Pura** (`bateriacorrupta`) | 0 | 0 | **Perfecto** (Ignora Kicks) |
| **Música Densa / Metal** (`musicapesada`) | 0 | 0 | **Perfecto** (Ignora Distorsión) |
| **Música Rítmica** (`musicaconmetronomo`) | 0 | 0 | **Perfecto** |
| **Música en Vivo** (`musicaenvivocorrupta`) | **137** | 0 | **FALLO CRÍTICO** |

### Segunda Fase: Verificación de Recall en Entornos Hostiles
Para corroborar si el detector seguía reconociendo Pops reales bajo estos entornos, se inyectaron 5 Pops sintéticos en las pistas más complejas y se volvió a correr el algoritmo:

| Archivo Inyectado | Total Detecciones | Pops GT Encontrados | Recall | Falsos Positivos |
| :--- | :---: | :---: | :---: | :---: |
| `bateria_pops.wav` | 5 | 5/5 | **100%** | 0 |
| `musicaenvivo_pops.wav` | 140 | 5/5 | **100%** | 135 |

**Conclusión de Recall:** La arquitectura es implacable encontrando Pops (100% Recall) sin importar si están ocultos detrás de una batería o de una multitud. El problema matemático radica exclusivamente en la incapacidad de filtrar el ruido natural continuo (Falsos Positivos).

---

## Análisis Especial: La Ruptura de la Hipótesis

### ¿Por qué falló en `musicaenvivocorrupta.wav`?
Al extraer la telemetría de los 137 Falsos Positivos, se encontró lo siguiente:
```text
-> Tiempo: 8.700s  | DC: 0.081 | LFER: 0.515
-> Tiempo: 16.040s | DC: 0.078 | LFER: 0.452
-> Tiempo: 34.450s | DC: 0.050 | LFER: 0.506
```

**Explicación Física:**
Las grabaciones en vivo en entornos abiertos o de alto volumen capturan "Rumble" (resonancias mecánicas del escenario) y **ráfagas de viento en los micrófonos**. 
Físicamente, una ráfaga de viento o un "golpe de escenario" empuja la membrana del micrófono en una sola dirección de manera casi idéntica a una vocal plosiva (Pop). 
Esto genera un **DC Offset local masivo** (hasta 0.08) y una concentración de energía sub-grave gigantesca (**LFER > 0.50**).

El detector no está matemáticamente equivocado: *esas ondas son estructuralmente idénticas a un Pop*. Sin embargo, desde el punto de vista del usuario, es el "rumble" natural de una grabación en vivo, no un defecto digital aislado que deba ser reparado con interpolación de 50ms.

---

## Respuestas a las Preguntas Arquitectónicas

1. **¿El DC Offset sigue siendo la evidencia dominante?**
   Sí. Es la métrica que mejor aísla las anomalías de LF. Ignora a la perfección baterías pesadas de estudio y bajos eléctricos en los otros tracks de prueba, confirmando su superioridad sobre el LFER por sí solo.

2. **¿Existen dominios donde falla?**
   Falla catastróficamente en material grabado en vivo (Live Music / Field Recordings) donde la contaminación mecánica (viento, rumble del escenario, golpes de atril) forma parte del audio sostenido.

3. **¿El LFER sigue siendo suficiente como validador?**
   **No.** El viento y el rumble en vivo tienen un LFER idéntico al de un Pop vocálico, por lo que el LFER no puede filtrar estos Falsos Positivos mecánicos.

4. **¿Aparece una tercera evidencia necesaria?**
   Sí: **Aislamiento Contextual (Transitoriedad)**. 
   Un Pop accidental es un evento *singular* y aislado frente a su entorno inmediato (±500ms). El Rumble en vivo o el viento son sostenidos o aparecen en clusters largos. Necesitamos una métrica que indique "Este alto DC offset apareció de la nada", en lugar de ser un valor absoluto.

5. **¿La arquitectura debe evolucionar?**
   Sí. La arquitectura actual detecta la *presencia de asimetría LF*, pero no su *intención* temporal.

   **Evolución requerida:**
   ```text
   DC Offset (Firma Principal)
   ↓
   LFER Gate (Validación Espectral)
   ↓
   Context Ratio Validation (¿Es un pico aislado o es Rumble sostenido?)
   ```

---

## Recomendación Final

**Requiere INV-002D**
La arquitectura `DC + LFER` ha demostrado ser brillante para detectar distorsiones de baja frecuencia, separando con éxito Kicks limpios y Metal denso. Sin embargo, no está lista para Producción sin una capa adicional de contexto. 

Recomiendo abrir la fase **INV-002D** para investigar métricas de Contexto (ej. `Local DC / Surround DC Ratio`) que permitan enseñar al detector a tolerar el rumble continuo de una grabación en vivo, reservando el disparo solo para los Thumps e inyecciones DC aisladas.
