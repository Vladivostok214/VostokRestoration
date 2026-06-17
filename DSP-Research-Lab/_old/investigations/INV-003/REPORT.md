# INV-003: Hum Characterization Report

## Phase 1: Physical Characterization

### 1.1 Physical Nature
Electrical Hum is a quasi-stationary, periodic interference originating from the power grid. It manifests as a fundamental frequency (50Hz or 60Hz) and a series of integer harmonics (100Hz, 120Hz, 150Hz, 180Hz, etc.).

### 1.2 Domain Identification (AF-001)
- **Dominant Domain:** Spectral.
- **Secondary Domain:** Temporal (Stationarity/Periodicity).
- **Classification:** Híbrido-Contextual (Requires long-term spectral persistence analysis).

### 1.3 Baseline Synthesis (Current State)
According to `DSP_BASELINE.md` and `INV-000`:
- **Detection Algorithm:** Frequency bin comparison vs. neighbors.
- **Target Frequencies:** [50, 60, 100, 120, 150, 180, 200, 240, 250, 300, 350, 360, 400, 420, 450, 480, 500] Hz.
- **Success Criteria:** `mag > 2.0 * neighbor_avg` AND `mag > 0.005` AND `persistence > 40%`.
- **Infrastructure:** `HumMasteringMode` (FFT 4096 / Hop 1024).

### 1.4 Characterization Findings (Draft)
- Unlike Clicks/Pops (Transients), Hum is **stationary**.
- Hum is **narrow-band** (single bins).
- **Challenge:** Distinction between "Musical Hum" (tonal instruments) and "Interference Hum".
- **Proposed Evidence:** Phase-locking or persistence across multiple seconds (Contextual).

## Phase 2: Experimental Design (Characterization)

### 2.1 Experiment: Spectral Discrimination Challenge
**Objective:** Identify the failure point of the magnitude-only baseline detector.

**Test Signals:**
1.  **Pure Grid Hum:** 50Hz sine, 0.05 amplitude, constant frequency.
2.  **Dirty Grid Hum:** 50Hz + Harmonics (150Hz, 250Hz) with 5% white noise.
3.  **Musical Tone (False Positive Candidate):** 50Hz sine with 2Hz Vibrato (FM) and 4Hz Tremolo (AM).
4.  **Intermittent Hum:** 50Hz sine pulsed (1s ON, 1s OFF).

**Evaluation Metrics:**
- **Recall:** % of Grid Hum detected.
- **Precision:** % of detected events that are not "Musical Tones".
- **Latency:** Time required for the persistence threshold (40%) to trigger.
