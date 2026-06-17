# DOC-007: Proceso de Generación de Audios Degradados (Data Augmentation)

Este documento detalla el procedimiento oficial del laboratorio para generar audios sintéticamente degradados, los cuales sirven como base para las pruebas y benchmarks de **Real World Validation** del DSP.

## 1. Ubicación y Entorno

Todo el proceso de degradación de audio está centralizado en el siguiente directorio:

```text
C:\Users\WLADI\Vostok Plugins\vostok-apps-web\Vostok Restoration V1\TestSamples
```

En esta carpeta se encuentran los 6 archivos de audio originales (`.wav`) que representan diferentes tipologías y escenarios acústicos reales (voz, batería, música en vivo, etc.).

## 2. Preparación del Script (`degradar_audio.py`)

El motor de inyección de artefactos es el script `degradar_audio.py`. 

Antes de ejecutar la degradación, el investigador debe:
1. Abrir el script en un editor de código.
2. Localizar la lógica interna de generación y **modificar el script** para adaptarlo al tipo específico de artefacto o aberración digital (Click, Pop, Slip, Drop, Hum, etc.) que requiera inyectar en esa sesión de pruebas.
3. Guardar los cambios.

## 3. Ejecución del Comando

Se debe abrir una terminal o consola de comandos en el directorio `TestSamples` y ejecutar el script pasando el archivo de entrada y el nombre del archivo de salida.

**Sintaxis:**
```bash
python degradar_audio.py entrada.wav salida.wav
```

**Convención de Nomenclatura:**
El archivo de salida debe ser nombrado agregando el sufijo `_degradado` al nombre original. 

**Ejemplo:**
Si el archivo original es `bateria.wav`, el comando sería:
```bash
python degradar_audio.py bateria.wav bateria_degradado.wav
```

## 4. Entregables de la Ejecución

Al ejecutar exitosamente el comando, el script producirá **dos artefactos**:

1. **El Audio Degradado (`.wav`):** El archivo de salida que contiene la señal original con las aberraciones inyectadas. Este es el archivo que se cargará en los módulos DSP de Vostok para evaluar las métricas de detección.
2. **El Registro de Ground Truth (`.csv`):** Un archivo CSV que contiene la telemetría y metadatos de las corrupciones generadas (tiempos exactos de inyección, intensidades, etc.). Esta es la "verdad fundamental" que permite calcular de forma precisa el *Recall* y los Falsos Positivos de los detectores sin intervención humana.

## 5. Validación

Una vez generados los audios degradados y sus respectivos archivos CSV para las 6 pistas base, el dataset estará listo para ser importado por el entorno de desarrollo y sometido a las pruebas de estrés de los detectores híbridos en fase `PROD` o `INV`.
