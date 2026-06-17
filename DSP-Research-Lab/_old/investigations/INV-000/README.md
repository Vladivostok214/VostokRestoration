# INV-000: DSP Baseline Validation

## Objetivo

Establecer la línea base oficial del motor DSP de Vostok Restoration.

Validar que la documentación contenida en `DSP_BASELINE.md` representa fielmente el comportamiento real del motor implementado en Rust.

El resultado de esta investigación será utilizado como referencia para todas las investigaciones futuras del DSP Research Lab.

---

## Código Fuente de Referencia

Proyecto Principal:

```text
C:\Users\WLADI\Vostok Plugins\vostok-apps-web\Vostok Restoration V1\src-tauri\src\dsp.rs
```

---

## Alcance

Esta investigación NO modifica código.

Esta investigación NO desarrolla nuevos algoritmos.

Esta investigación tiene carácter exclusivamente documental, analítico y de auditoría técnica.

---

## Entregables

### 1. Inventario de Capacidades DSP

Identificar y documentar:

#### Decodificación

- WAV
    
- MP3
    
- FLAC
    

#### Transformadas

- FFT
    
- STFT
    

#### Feature Extraction

- RMS
    
- Peak
    
- Crest Factor
    
- Spectral Centroid
    
- Spectral Bandwidth
    
- Spectral Flatness
    
- Spectral Flux
    

#### Detectores

- Click
    
- Pop
    
- Hum
    
- Dropout
    
- Clipping
    

#### Reparadores

- Hermite Cubic Repair
    

#### Exportación

- WAV PCM
    
- Bit-perfect patching
    

---

### 2. Matriz de Capacidades

Construir una tabla:

|Capacidad|Documentada|Implementada|Estado|
|---|---|---|---|
|RMS|Sí|Sí|OK|
|Hiss Detector|No|No|N/A|
|Crackle Detector|No|No|N/A|

---

### 3. Validación Matemática

Verificar que las fórmulas documentadas coinciden con la implementación real.

Ejemplos:

- Hann Window
    
- Crest Factor
    
- Spectral Flux
    
- Spectral Flatness
    
- Hermite Cubic Interpolation
    

---

### 4. Validación de Umbrales

Verificar:

#### Click

- Crest Factor > 15
    
- Bandwidth > 80% Nyquist
    

#### Pop

- Low Frequency Energy Ratio > 80%
    

#### Hum

- Harmonic Dominance > 2x Neighbors
    
- Active Ratio > 40%
    

#### Clipping

- Consecutive Samples > 3
    

#### Dropout

- RMS Drop > 20 dB
    

---

### 5. Identificación de Deuda Técnica

Documentar capacidades ausentes.

Ejemplos:

- Hiss Detection
    
- Crackle Detection
    
- Spectral Repair
    
- AR Reconstruction
    
- LPC Reconstruction
    
- Probabilistic Classification
    
- Automatic Repair Selection
    

---

## Metodología

### Paso 1

Leer `DSP_BASELINE.md`.

---

### Paso 2

Analizar `dsp.rs`.

---

### Paso 3

Construir mapa:

```text
Documentación
↓
Implementación
↓
Estado
```

---

### Paso 4

Registrar discrepancias.

Clasificación:

#### Tipo A

Documentado pero no implementado.

#### Tipo B

Implementado pero no documentado.

#### Tipo C

Implementado de forma distinta a la documentación.

---

### Paso 5

Generar informe final.

---

## Criterios de Finalización

La investigación se considera terminada cuando existe:

- Inventario DSP completo.
    
- Matriz de capacidades.
    
- Lista de discrepancias.
    
- Lista de deuda técnica.
    
- Informe final validado.
    

---

## Resultado Esperado

Archivo:

```text
reports/INV-000-Baseline-Validation.md
```

Este documento se convertirá en la referencia oficial del estado DSP de Vostok Restoration v1.