# Catálogo de Detectores

## Detector: CLICK

Parámetros y Umbrales Base:
- Crest Factor Threshold = 15.0
- Bandwidth Threshold = 0.8 * Nyquist
- RMS Threshold = 2.0 * Noise Floor

Detector actual:
- ClickDetectorV1

Detector experimental:
- (Pendiente de INV-001)

---

## Detector: POP

Parámetros y Umbrales Base:
- Low Freq Cutoff = 150 Hz
- Energy Ratio Threshold = 0.8 (80%)
- Crest Factor Threshold = 5.0
- RMS Threshold = 3.0 * Noise Floor

Detector actual:
- PopDetectorV1

Detector experimental:
- (Pendiente de INV-002)

---

## Detector: HUM

Parámetros y Umbrales Base:
- Neighbor Magnitude Ratio = 2.0
- Absolute Magnitude Min = 0.005
- Time Persistence Ratio = 0.4 (40%)

Detector actual:
- HumDetectorV1

Detector experimental:
- (Pendiente de INV-003)

---

## Detector: CLIPPING

Parámetros y Umbrales Base:
- Absolute Amplitude Threshold = 0.99
- Consecutive Samples Min = 3
- Max Flatness Delta = 0.0001

Detector actual:
- ClippingDetectorV1

Detector experimental:
- (Pendiente de INV-005)

---

## Detector: DROPOUT

Parámetros y Umbrales Base:
- RMS Drop Threshold = -20 dB (o < 10% del promedio móvil)
- Min Duration = 10 ms

Detector actual:
- DropoutDetectorV1

Detector experimental:
- (Pendiente de INV-004)
