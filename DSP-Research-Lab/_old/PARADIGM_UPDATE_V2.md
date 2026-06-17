# DSP Research Lab

## Paradigm Update v2.0

### Contexto

La línea completa de investigación INV-001 (Click Detection) ha concluido.

Los resultados obtenidos obligan a actualizar formalmente varios supuestos arquitectónicos y metodológicos del DSP Research Lab.

Este documento no reemplaza el SPEC original.

Este documento actualiza los principios de investigación que deberán aplicarse a todas las investigaciones futuras.

---

# Hallazgo Arquitectónico AF-001

Los artefactos no deben clasificarse inicialmente por thresholds.

Deben clasificarse primero por dominio físico dominante.

Antes de diseñar cualquier detector, toda investigación deberá responder:

```text
¿Dónde vive este artefacto?
```

Opciones:

- Dominio Temporal
    
- Dominio Espectral
    
- Dominio Híbrido
    
- Dominio Contextual
    

---

# Hallazgo Arquitectónico AF-002

Los detectores monolíticos deben evitarse.

La arquitectura preferida es:

```text
Candidato
↓
Validación
↓
Confidence
↓
Clasificación
```

No:

```text
Threshold
↓
Verdadero/Falso
```

---

# Hallazgo Arquitectónico AF-003

Los micro-clicks demostraron que existen artefactos que requieren múltiples dominios de análisis.

Arquitectura validada:

```text
Temporal Layer
↓
Candidate Detection

↓

Spectral Layer
↓
Candidate Validation

↓

Confidence Layer
↓
Final Decision
```

Esta arquitectura debe considerarse patrón de referencia para futuras investigaciones.

---

# Hallazgo Arquitectónico AF-004

Existen escenarios donde la separación perfecta es físicamente imposible.

Ejemplo validado:

```text
Micro-Click
≈
Ruido Blanco Instantáneo

Guitarra Distorsionada
≈
Ruido Blanco Sostenido
```

En estos casos:

- No perseguir precisión perfecta.
    
- No continuar ajustando thresholds indefinidamente.
    
- Aceptar límites físicos de separabilidad.
    
- Exponer sensibilidad al usuario cuando corresponda.
    

---

# Hallazgo Arquitectónico AF-005

Antes de calibrar un detector se debe caracterizar el artefacto.

Nuevo flujo obligatorio:

```text
Caracterización Física
↓
Dominio Dominante
↓
Detector Candidato
↓
Validación Mundo Real
↓
Calibración
↓
Integración
```

---

# Hallazgo Arquitectónico AF-006

El Analytical Spectrogram es ahora una infraestructura oficial del laboratorio.

Uso obligatorio para:

- Investigación DSP
    
- Validación espectral
    
- Clasificación
    
- Futuras capas IA
    

No utilizar el Visual Spectrogram para investigación.

---

# Hallazgo Arquitectónico AF-007

Toda nueva investigación debe producir Confidence Scores.

Formato objetivo:

```rust
ArtifactDetection {
    artifact_type,
    confidence,
    evidence
}
```

La confianza es ahora un output de primera clase del laboratorio.

---

# Actualización del Objetivo del DSP Research Lab

Objetivo anterior:

```text
Diseñar detectores.
```

Nuevo objetivo:

```text
Diseñar sistemas de evidencia para clasificación de artefactos.
```

---

# Aplicación inmediata

Las siguientes investigaciones deberán comenzar respondiendo:

## INV-002

Pop Characterization Study

Pregunta principal:

```text
¿El Pop es temporal,
espectral o híbrido?
```

---

## INV-003

Hum Characterization Study

Pregunta principal:

```text
¿Hum requiere validación híbrida
o basta una arquitectura espectral?
```

---

## INV-008

Hiss Characterization Study

Pregunta principal:

```text
¿Qué combinación mínima de evidencia
permite distinguir Hiss de contenido legítimo?
```

---

# Directiva Operativa

A partir de este momento:

No comenzar investigaciones diseñando detectores.

Comenzar investigaciones caracterizando artefactos.

Los detectores serán consecuencia de la investigación, no el punto de partida.