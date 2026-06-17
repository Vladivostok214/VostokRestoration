# Catálogo de Reparadores

## Reparador: HERMITE CUBIC REPAIR

Características:
- Expansión dinámica del área dañada basada en Noise Floor
- Promedio de 8 muestras seguras para puntos de anclaje (P0, P1)
- Estimación de tangentes con Catmull-Rom (C1)
- Parcheo in-place de bytes crudos (bit-perfect)

Estado actual:
- HermiteCubicV1 (Baseline)

Estado experimental:
- (Pendiente de INV-006)

---

## Reparador: ADAPTIVE HUM REMOVAL

Características:
- Sustracción espectral adaptable
- Seguimiento de fase

Estado actual:
- No implementado

Estado experimental:
- (Pendiente de investigación)

---

## Reparador: SPECTRAL REPAIR / INPAINTING

Características:
- Reconstrucción de plano tiempo-frecuencia
- Interpolación bidimensional de magnitudes

Estado actual:
- No implementado

Estado experimental:
- (Pendiente de investigación)

---

## Reparador: AR PREDICTION / LPC RECONSTRUCTION

Características:
- Modelado autorregresivo lineal
- Extrapolación de forma de onda original

Estado actual:
- No implementado

Estado experimental:
- (Pendiente de investigación)
