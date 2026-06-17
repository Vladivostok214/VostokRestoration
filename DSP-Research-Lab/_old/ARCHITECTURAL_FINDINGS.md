# Architectural Findings Registry

## Política de Inmutabilidad AF

Una vez asignado un identificador AF:
* El número no puede reutilizarse.
* El significado no puede cambiar.
* Las revisiones deben crear un nuevo AF.
* Los AF son permanentes.

Este documento sirve como la única fuente de verdad (Single Source of Truth) inmutable para todos los Hallazgos Arquitectónicos (AF) descubiertos y validados por el DSP Research Lab en Vostok Restoration.

---

## AF-001: Taxonomía de Dominios

### Estado
Producción

### Origen
PARADIGM_UPDATE_V2.md (derivado de INV-001)

### Investigaciones que lo utilizan
- INV-002, INV-003, PROD-001

### Impacto Arquitectónico
Define el punto de partida de toda nueva investigación. Los artefactos no deben clasificarse inicialmente por umbrales, sino por su dominio físico dominante (Temporal, Espectral, Híbrido, Contextual).

---

## AF-002: Arquitectura en Capas

### Estado
Producción

### Origen
PARADIGM_UPDATE_V2.md

### Investigaciones que lo utilizan
- INV-002, INV-003, PROD-003

### Impacto Arquitectónico
Prohíbe los detectores monolíticos. Obliga a estructurar los algoritmos en: `Candidato -> Validación -> Confidence -> Clasificación`.

---

## AF-003: Arquitectura Híbrida de Detección

### Estado
Validado

### Origen
PARADIGM_UPDATE_V2.md (Investigación de Micro-Clicks)

### Investigaciones que lo utilizan
- INV-001A, INV-001D, PROD-001

### Impacto Arquitectónico
Establece el patrón oficial de interacción entre dominios: `Temporal Layer -> Candidate Detection -> Spectral Layer -> Candidate Validation -> Confidence Layer`.

---

## AF-004: Aceptación de Límites Físicos de Separabilidad

### Estado
Validado

### Origen
INV-001E / PARADIGM_UPDATE_V2.md

### Investigaciones que lo utilizan
- PROD-002

### Impacto Arquitectónico
Prohíbe continuar ajustando umbrales de manera infinita para buscar una precisión utópica. Obliga a exponer la sensibilidad de estos límites al usuario.

---

## AF-005: Flujo Mandatorio de Investigación

### Estado
Producción

### Origen
PARADIGM_UPDATE_V2.md

### Investigaciones que lo utilizan
- INV-002, INV-003

### Impacto Arquitectónico
El flujo de desarrollo queda estandarizado en: `Caracterización Física -> Dominio Dominante -> Detector Candidato -> Validación Mundo Real -> Calibración -> Integración`.

---

## AF-006: Uso Mandatorio del Analytical Spectrogram

### Estado
Producción

### Origen
INFRA-001 / PARADIGM_UPDATE_V2.md

### Investigaciones que lo utilizan
- INFRA-002, INV-002, INV-003

### Impacto Arquitectónico
Prohíbe el uso de representaciones visuales del espectrograma para cálculos. Obliga a los detectores a hacer recortes (`AnalyticalRegionRequest`) sobre la memoria inmutable de alta precisión en Rust.

---

## AF-007: Confidence como Ciudadano de Primera Clase

### Estado
Validado

### Origen
PARADIGM_UPDATE_V2.md

### Investigaciones que lo utilizan
- PROD-001, PROD-003, INV-003B

### Impacto Arquitectónico
Toda salida de detección de la capa nativa debe usar un Struct de `ArtifactDetection` incluyendo un valor flotante de `confidence`.

---

## AF-008: [Vacante Histórica]

### Estado
N/A

### Origen
N/A

### Investigaciones que lo utilizan
- Ninguna

### Impacto Arquitectónico
Identificador no asignado formalmente en el registro histórico debido a desincronizaciones previas a la norma de inmutabilidad. Se preserva vacío para mantener la trazabilidad numérica.

---

## AF-009: Modelado por Contexto Local (Context Ratio)

### Estado
Validado

### Origen
INV-002D

### Investigaciones que lo utilizan
- PROD-003

### Impacto Arquitectónico
Los artefactos deben modelarse respecto a su contexto local y no mediante valores absolutos. Ejemplo: Para aislar un Pop del Rumble continuo, se debe usar `Context Ratio` (Peak DC vs Surround DC) y no un DC Offset absoluto.

---

## AF-010: Taxonomía Temporal de Artefactos

### Estado
Validado

### Origen
INV-003

### Investigaciones que lo utilizan
- INV-003A, INV-003B

### Impacto Arquitectónico
Distingue conceptualmente los artefactos entre "Eventos" (transitorios finitos como Click y Pop) y "Condiciones" (estados estacionarios como Hum, Hiss y Rumble).

---

## AF-011: Distinción Estacionaria por Estabilidad

### Estado
Validado

### Origen
INV-003A

### Investigaciones que lo utilizan
- INV-003B

### Impacto Arquitectónico
Establece que los artefactos estacionarios (condiciones como el Hum eléctrico) se distinguen mejor por su estabilidad a lo largo del tiempo que por su amplitud bruta.

---

## AF-012: Restricción de Compuertas Binarias de Decisión

### Estado
Validado

### Origen
INV-003B

### Investigaciones que lo utilizan
- INV-003B, Desarrollos futuros de Hum

### Impacto Arquitectónico
No toda evidencia físicamente válida debe convertirse en una compuerta de decisión. Evidencias altamente inestables en ventanas cortas (como la Fase) deben ir al `Confidence Score` y NUNCA a un `Gate Binario`.

---

## AF-013: Backend Híbrido Optimizado (Zero-Copy)

### Estado
Producción

### Origen
PROD-003

### Investigaciones que lo utilizan
- PROD-001, INFRA-001

### Impacto Arquitectónico
El sistema base en Rust debe operar sobre memoria unificada usando operaciones Zero-Copy, procesando el audio en búferes solicitados asíncronamente para evitar desbordes de RAM.

---

## AF-014: Supremacía de la Estabilidad de Magnitud (CV)

### Estado
Validado

### Origen
INV-003A

### Investigaciones que lo utilizan
- INV-003B

### Impacto Arquitectónico
Convierte al `Coeficiente de Variación de Magnitud (CV)` en el filtro principal y más robusto (986x de separabilidad) para aislar contenido estacionario parásito del musical legítimo.

---

## AF-015: Prohibición de Gate Binario de Fase

### Estado
Validado

### Origen
INV-003B

### Investigaciones que lo utilizan
- Desarrollos futuros de detección tonal

### Impacto Arquitectónico
Prohibición algorítmica específica de los "Phase Gates". Todo análisis basado en coherencia de fase pasa exclusivamente a la capa final de ponderación de confianza.

---

## AF-016: Arquitectura Mínima Viable para Señales Constantes

### Estado
Validado

### Origen
INV-003B

### Investigaciones que lo utilizan
- Desarrollo de Hum (INV-003C / PROD-00X)

### Impacto Arquitectónico
Consolida la arquitectura MVA oficial para detectar interferencias constantes basadas en frecuencia: Análisis de Fundamental + Estabilidad de Magnitud (CV) + Persistencia Temporal.

## AF-017: La Arquitectura Mínima Viable no implica Producción Viable.

### Estado
Validado

### Origen
INV-003C

### Investigaciones que lo utilizan
- Desarrollo de Hum (INV-003C / PROD-00X)

### Impacto Arquitectónico
Una arquitectura puede explicar el fenómeno correctamente y aun así carecer de suficiente capacidad de rechazo para escenarios hostiles..

## AF-018: La perfección matemática puede ser evidencia de síntesis y no de realidad.

### Estado
Validado

### Origen
INV-003D

### Investigaciones que lo utilizan
- PROD-004

### Impacto Arquitectónico
No asumir que la señal físicamente real es la señal más perfecta.


---

# Matriz de Dependencias

| AF | Generado Por | Utilizado Por |
| -- | ------------ | ------------- |
| AF-001 | INV-001 | INV-002, INV-003, PROD-001 |
| AF-002 | PARADIGM_UPDATE_V2 | INV-002, INV-003, PROD-003 |
| AF-003 | INV-001A | INV-001D, PROD-001 |
| AF-004 | INV-001E | PROD-002 |
| AF-005 | PARADIGM_UPDATE_V2 | INV-002, INV-003 |
| AF-006 | INFRA-001 | INFRA-002, INV-002, INV-003 |
| AF-007 | PARADIGM_UPDATE_V2 | PROD-001, PROD-003, INV-003B |
| AF-008 | N/A | Ninguna |
| AF-009 | INV-002D | PROD-003 |
| AF-010 | INV-003 | INV-003A, INV-003B |
| AF-011 | INV-003A | INV-003B |
| AF-012 | INV-003B | INV-003B, Futuros |
| AF-013 | PROD-003 | PROD-001, INFRA-001 |
| AF-014 | INV-003A | INV-003B |
| AF-015 | INV-003B | Futuros desarrollos tonales |
| AF-016 | INV-003B | INV-003C, PROD-00X |
| AF-017 | INV-003C | INV-003D, PROD-00X |
| AF-018 | INV-003D | PROD-004 |