# Catálogo de Artefactos

## Artifact: CLICK & SPIKES

Características:
- Crest Factor (> 15.0)
- Spectral Bandwidth (> 80% Nyquist)
- RMS (> 2.0 * Noise Floor)
- Spectral Flux (detección de transitorios rápidos < 5 ms)

Detector actual:
- ClickDetectorV1 (Baseline)

Detector experimental:
- (Pendiente de INV-001)

---

## Artifact: POPS & LOW THUMPS

Características:
- Energía espectral concentrada (< 150 Hz, > 80% del total)
- Crest Factor (> 5.0)
- RMS (> 3.0 * Noise Floor)

Detector actual:
- PopDetectorV1 (Baseline)

Detector experimental:
- (Pendiente de INV-002)

---

## Artifact: HUM DE RED

Características:
- Frecuencias armónicas específicas (50/60 Hz y múltiplos)
- Magnitud relativa (> 2.0x respecto a bins vecinos)
- Persistencia temporal (> 40% de las ventanas analizadas)

Detector actual:
- HumDetectorV1 (Baseline)

Detector experimental:
- (Pendiente de INV-003)

---

## Artifact: CLIPPING

Características:
- Saturación de amplitud (>= 0.99)
- Continuidad temporal (> 3 muestras consecutivas)
- Tolerancia plana (Delta <= 10^-4)

Detector actual:
- ClippingDetectorV1 (Baseline)

Detector experimental:
- (Pendiente de INV-005)

---

## Artifact: DROPOUT

Características:
- Caída drástica de energía (RMS cae > 20 dB)
- Duración (> 10 ms)

Detector actual:
- DropoutDetectorV1 (Baseline)

Detector experimental:
- (Pendiente de INV-004)
