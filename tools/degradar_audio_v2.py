# -*- coding: utf-8 -*-
"""
Vostok Labs — DSP Stress Testing Script v2
Generador de artefactos digitales y señales parásitas para calibración de Vostok Restoration v1.

Novedades v2:
  - Nuevo modo: real_world  (vinilo, casete, grabaciones de campo, archivos históricos)
  - Hum segmentado: afecta sólo 1-4 zonas del archivo, con fade-in/out suaves
  - Hiss segmentado: afecta sólo 1-3 zonas del archivo, con fade-in/sustain/fade-out
  - Clicks agrupados en clusters temporales (estilo vinilo)
  - Ground Truth v2: StartTime, EndTime, ArtifactType, Magnitude, Metadata
  - Parámetro opcional --seed para reproducibilidad total
"""

import sys
import math
import random
import argparse
import csv
import numpy as np
from pathlib import Path
from scipy.io import wavfile


# ══════════════════════════════════════════════════════════════════════════════
# UTILIDADES DE CONVERSIÓN DE AUDIO
# ══════════════════════════════════════════════════════════════════════════════

def convertir_a_float(audio):
    """Convierte cualquier formato de entrada a float32 normalizado en [-1, 1]."""
    if audio.dtype == np.int16:
        return audio.astype(np.float32) / 32768.0
    if audio.dtype == np.int32:
        return audio.astype(np.float32) / 2147483648.0
    if audio.dtype == np.uint8:
        return (audio.astype(np.float32) - 128) / 128.0
    return audio.astype(np.float32)


# ══════════════════════════════════════════════════════════════════════════════
# MOTOR DE INYECCIÓN — MODOS HEREDADOS (sin modificar)
# ══════════════════════════════════════════════════════════════════════════════

def inyectar_artefactos(audio, sample_rate, modo):
    """
    Motor original de inyección de artefactos.
    Compatible con: default, transients, all_mixed.
    Se mantiene intacto para preservar compatibilidad total.
    Retorna (audio_modificado, gt_events) usando el formato CSV v1.
    """
    audio_mod = audio.copy()
    total_muestras = len(audio_mod)
    es_stereo = audio_mod.ndim > 1
    gt_events = []

    # ── 1. CÁLCULO DINÁMICO DE DENSIDAD ────────────────────────────────────
    duracion_segundos = total_muestras / sample_rate
    minutos = duracion_segundos / 60.0

    perfiles = {
        "default":    {"clicks": 15, "pops": 0, "drops": 0, "clips": 0, "max_samples": 3},
        "transients": {"clicks": 45, "pops": 10, "drops": 0, "clips": 0, "max_samples": 5},
        "all_mixed":  {"clicks": 30, "pops": 8,  "drops": 4, "clips": 2, "max_samples": 4}
    }

    p = perfiles.get(modo, perfiles["all_mixed"])

    CANTIDAD_CLICKS = math.ceil(p["clicks"] * minutos) if p["clicks"] > 0 else 0
    CANTIDAD_POPS   = math.ceil(p["pops"] * minutos)   if p["pops"]   > 0 else 0
    CANTIDAD_DROPS  = math.ceil(p["drops"] * minutos)  if p["drops"]  > 0 else 0
    CANTIDAD_CLIPS  = math.ceil(p["clips"] * minutos)  if p["clips"]  > 0 else 0
    MAX_SAMPLES_DANO = p["max_samples"]

    print(f"\n--- Iniciando Inyección Quirúrgica Vostok | Modo: {modo} ---")
    print(f"  📊 Audio de {duracion_segundos:.2f}s ({minutos:.2f} min)")
    print(f"  💉 Dosis: {CANTIDAD_CLICKS} Clicks | {CANTIDAD_POPS} Pops | {CANTIDAD_DROPS} Drops | {CANTIDAD_CLIPS} Clips")

    # Vector de tiempo base
    t = np.linspace(0, total_muestras / sample_rate, total_muestras, endpoint=False)

    # ── 2. INYECCIÓN DE ARTEFACTOS (LÓGICA DSP ORIGINAL INTACTA) ──────────

    # DROPOUTS
    for i in range(CANTIDAD_DROPS):
        inicio = random.randint(1000, total_muestras - 10000)
        duracion = int(sample_rate * random.uniform(0.01, 0.05))  # Dropout 10-50ms
        fin = inicio + duracion

        if not es_stereo:
            mag = float(np.max(np.abs(audio_mod[inicio:fin])))
        else:
            mag = float(np.max(np.abs(audio_mod[inicio:fin, 0])))

        if not es_stereo:
            audio_mod[inicio:fin] = 0.0
        else:
            audio_mod[inicio:fin, :] = 0.0

        gt_events.append((inicio, inicio / sample_rate, "drop", mag))

    # CLICKS DIGITALES
    for i in range(CANTIDAD_CLICKS):
        inicio = random.randint(1000, total_muestras - 1000)
        longitud = 1  # [P1.8B] Click real (1 muestra) para no imitar flat-top clipping
        val = random.choice([-1.0, 1.0])

        if not es_stereo:
            mag = float(abs(val - audio_mod[inicio]))
            audio_mod[inicio] = val
        else:
            mag = float(abs(val - audio_mod[inicio, 0]))
            audio_mod[inicio, :] = val

        gt_events.append((inicio, inicio / sample_rate, "click", mag))

    # POPS PLOSIVOS (THUMP)
    for i in range(CANTIDAD_POPS):
        inicio = random.randint(1000, total_muestras - 10000)
        duracion = int(sample_rate * random.uniform(0.02, 0.08))
        fin = min(inicio + duracion, total_muestras)
        t_pop = np.linspace(0, (fin - inicio) / sample_rate, fin - inicio, endpoint=False)

        thump = np.sin(2 * np.pi * random.uniform(15, 40) * t_pop) * np.exp(-t_pop * 30)
        thump[thump < 0] *= 0.2
        amp = random.uniform(0.5, 0.9)

        if not es_stereo:
            audio_mod[inicio:fin] += thump * amp
        else:
            audio_mod[inicio:fin, 0] += thump * amp
            audio_mod[inicio:fin, 1] += thump * amp

        gt_events.append((inicio, inicio / sample_rate, "pop", float(amp)))

    # CLIPPING (SATURACIÓN ADC)
    for i in range(CANTIDAD_CLIPS):
        inicio = random.randint(1000, total_muestras - 20000)
        duracion = int(sample_rate * random.uniform(0.1, 0.5))
        fin = min(inicio + duracion, total_muestras)

        if not es_stereo:
            audio_mod[inicio:fin] *= 3.0
        else:
            audio_mod[inicio:fin, :] *= 3.0

        clip_threshold = random.uniform(0.7, 0.95)

        if not es_stereo:
            audio_mod[inicio:fin] = np.clip(audio_mod[inicio:fin], -clip_threshold, clip_threshold)
        else:
            audio_mod[inicio:fin, :] = np.clip(audio_mod[inicio:fin, :], -clip_threshold, clip_threshold)

        gt_events.append((inicio, inicio / sample_rate, "clipping", float(clip_threshold)))
        print(f"  [!] CLIPPING inyectado en {inicio/sample_rate:.2f}s | Techo: {clip_threshold:.2f}")

    if modo in ["hiss", "all_mixed"]:
        hiss_amp = 0.05
        ruido = np.random.normal(0, hiss_amp, total_muestras)
        if es_stereo:
            ruido = np.column_stack((ruido, ruido))
        audio_mod += ruido
        gt_events.append((0, 0.0, "hiss", float(hiss_amp)))
        print("[HISS] Inyectado en toda la pista.")

    if modo in ["hum_50hz", "all_mixed"]:
        amp = 0.05
        hum = amp * np.sin(2 * np.pi * 50 * t)
        if es_stereo:
            hum = np.column_stack((hum, hum))
        audio_mod += hum
        gt_events.append((0, 0.0, "hum_50hz", float(amp)))

    return audio_mod, gt_events


# ══════════════════════════════════════════════════════════════════════════════
# HELPERS INTERNOS PARA REAL_WORLD
# ══════════════════════════════════════════════════════════════════════════════

def _aplicar_fade(señal, sr, fade_ms=50):
    """
    Aplica fade-in y fade-out coseno en los primeros/últimos fade_ms ms del segmento.
    Opera in-place. Funciona igual para mono (1D) y estéreo (2D canal=0).
    """
    n_fade = min(int(sr * fade_ms / 1000.0), len(señal) // 4)
    if n_fade < 2:
        return señal

    # Curva coseno suavizada [0 → 1] y [1 → 0]
    rampa = 0.5 * (1 - np.cos(np.pi * np.arange(n_fade) / n_fade))

    if señal.ndim == 1:
        señal[:n_fade]  *= rampa
        señal[-n_fade:] *= rampa[::-1]
    else:
        señal[:n_fade,  :] *= rampa[:, np.newaxis]
        señal[-n_fade:, :] *= rampa[::-1, np.newaxis]

    return señal


def _segmentos_aleatorios(duracion_total_s, n_min, n_max, dur_min_s, dur_max_s):
    """
    Devuelve una lista de (inicio_s, fin_s) con segmentos no solapados,
    distribuidos aleatoriamente a lo largo de la duración total del archivo.
    """
    n = random.randint(n_min, n_max)
    segmentos = []
    intentos = 0

    while len(segmentos) < n and intentos < 200:
        intentos += 1
        dur = random.uniform(dur_min_s, dur_max_s)
        # Margen de 0.5 s en bordes para evitar truncar fades
        max_inicio = duracion_total_s - dur - 0.5
        if max_inicio < 0.5:
            continue
        inicio = random.uniform(0.5, max_inicio)
        fin = inicio + dur

        # Verificar que no solape con segmentos ya aceptados
        solapado = any(not (fin < s[0] or inicio > s[1]) for s in segmentos)
        if not solapado:
            segmentos.append((inicio, fin))

    segmentos.sort(key=lambda x: x[0])
    return segmentos


# ══════════════════════════════════════════════════════════════════════════════
# MOTOR REAL_WORLD
# ══════════════════════════════════════════════════════════════════════════════

def inyectar_real_world(audio, sample_rate):
    """
    Modo real_world: simula degradaciones análogas reales.

    Modela:
      - Digitalizaciones de vinilo (clicks en clusters, pops suaves)
      - Casetes (hiss segmentado, dropout corto)
      - Grabaciones de campo (hum 50 Hz segmentado con armónicos)
      - Archivos históricos (clipping leve, dropouts)

    Retorna:
      (audio_modificado, gt_events_v2)
      donde cada gt_event_v2 es un dict con claves:
        StartTime, EndTime, ArtifactType, Magnitude, Metadata
    """
    audio_mod = audio.copy()
    total_muestras = len(audio_mod)
    es_stereo = audio_mod.ndim > 1
    duracion_s = total_muestras / sample_rate
    minutos = duracion_s / 60.0

    gt_events = []  # Lista de dicts para Ground Truth v2

    print(f"\n--- Iniciando Inyección Real-World | Modo: real_world ---")
    print(f"  📊 Audio de {duracion_s:.2f}s ({minutos:.2f} min)")

    # ── VECTOR DE TIEMPO ───────────────────────────────────────────────────
    t_global = np.linspace(0, duracion_s, total_muestras, endpoint=False)

    # ══════════════════════════════════════════════════════════════════════
    # 1. CLICKS EN CLUSTERS (8–15 clicks/min, agrupados)
    # ══════════════════════════════════════════════════════════════════════
    total_clicks = random.randint(
        max(1, math.floor(8  * minutos)),
        max(1, math.ceil(15 * minutos))
    )
    clicks_inyectados = 0

    # Calcular cuántos clusters necesitamos para agotar total_clicks
    while clicks_inyectados < total_clicks:
        # Centro del cluster: posición aleatoria en el archivo
        cluster_center_s = random.uniform(0.5, duracion_s - 0.5)
        cluster_center   = int(cluster_center_s * sample_rate)

        # Número de clicks dentro de este cluster (2-5)
        clicks_restantes = total_clicks - clicks_inyectados
        clicks_en_cluster = random.randint(min(2, clicks_restantes), min(5, clicks_restantes))

        # Ventana temporal del cluster: ±200 ms alrededor del centro
        ventana_samples = int(0.2 * sample_rate)

        for _ in range(clicks_en_cluster):
            # Desplazamiento dentro de la ventana
            offset = random.randint(-ventana_samples, ventana_samples)
            inicio = cluster_center + offset
            inicio = max(100, min(inicio, total_muestras - 100))

            # [P1.8B] Longitud del click: estrictamente 1 sample para evitar falso clipping (flat-top)
            longitud = 1
            fin      = min(inicio + longitud, total_muestras)

            # Polaridad aleatoria
            val = random.choice([-1.0, 1.0])

            # Calcular magnitud antes de aplicar
            if not es_stereo:
                mag = float(abs(val - audio_mod[inicio]))
            else:
                mag = float(abs(val - audio_mod[inicio, 0]))

            # Aplicar click instantáneo
            if not es_stereo:
                audio_mod[inicio] = val
            else:
                audio_mod[inicio, :] = val

            t_click = inicio / sample_rate

            gt_events.append({
                "StartTime":    t_click,
                "EndTime":      t_click,           # artefacto instantáneo
                "ArtifactType": "click",
                "Magnitude":    round(mag, 4),
                "Metadata":     f"length={longitud}"
            })

            clicks_inyectados += 1
            if clicks_inyectados >= total_clicks:
                break

    print(f"  🎵 Clicks inyectados: {clicks_inyectados} (en clusters)")

    # ══════════════════════════════════════════════════════════════════════
    # 2. POPS SUAVES (1–3 por minuto, menos agresivos que modo transients)
    # ══════════════════════════════════════════════════════════════════════
    total_pops = random.randint(
        max(0, math.floor(1 * minutos)),
        max(1, math.ceil(3 * minutos))
    )

    for _ in range(total_pops):
        inicio = random.randint(int(0.5 * sample_rate), total_muestras - int(0.5 * sample_rate))
        dur_pop = int(sample_rate * random.uniform(0.015, 0.060))  # 15–60 ms, más suave
        fin     = min(inicio + dur_pop, total_muestras)
        t_pop   = np.linspace(0, (fin - inicio) / sample_rate, fin - inicio, endpoint=False)

        # Tono bajo con decaimiento exponencial (THUMP análogo)
        freq_pop = random.uniform(20, 60)
        thump    = np.sin(2 * np.pi * freq_pop * t_pop) * np.exp(-t_pop * 25)
        thump[thump < 0] *= 0.3  # Asimetría suave

        # Amplitud moderada: 0.2–0.5 (menos agresiva que transients)
        amp = random.uniform(0.2, 0.5)

        if not es_stereo:
            audio_mod[inicio:fin] += thump * amp
        else:
            audio_mod[inicio:fin, 0] += thump * amp
            audio_mod[inicio:fin, 1] += thump * amp

        t_inicio_s = inicio / sample_rate
        t_fin_s    = fin    / sample_rate

        gt_events.append({
            "StartTime":    round(t_inicio_s, 6),
            "EndTime":      round(t_fin_s,    6),
            "ArtifactType": "pop",
            "Magnitude":    round(float(amp), 4),
            "Metadata":     f"freq={freq_pop:.1f}hz"
        })

    print(f"  💥 Pops suaves inyectados: {total_pops}")

    # ══════════════════════════════════════════════════════════════════════
    # 3. DROPOUTS CORTOS (5–25 ms, 1–4 eventos)
    # ══════════════════════════════════════════════════════════════════════
    total_drops = random.randint(1, 4)

    for _ in range(total_drops):
        inicio  = random.randint(int(0.5 * sample_rate), total_muestras - int(0.5 * sample_rate))
        dur_drop = int(sample_rate * random.uniform(0.005, 0.025))  # 5–25 ms
        fin      = min(inicio + dur_drop, total_muestras)

        # Magnitud = nivel de señal borrado
        if not es_stereo:
            mag = float(np.max(np.abs(audio_mod[inicio:fin]))) if fin > inicio else 0.0
        else:
            mag = float(np.max(np.abs(audio_mod[inicio:fin, 0]))) if fin > inicio else 0.0

        if not es_stereo:
            audio_mod[inicio:fin] = 0.0
        else:
            audio_mod[inicio:fin, :] = 0.0

        t_inicio_s = inicio / sample_rate
        t_fin_s    = fin    / sample_rate
        dur_ms     = (fin - inicio) / sample_rate * 1000.0

        gt_events.append({
            "StartTime":    round(t_inicio_s, 6),
            "EndTime":      round(t_fin_s,    6),
            "ArtifactType": "dropout",
            "Magnitude":    round(mag, 4),
            "Metadata":     f"dur_ms={dur_ms:.1f}"
        })

    print(f"  ⬛ Dropouts cortos inyectados: {total_drops}")

    # ══════════════════════════════════════════════════════════════════════
    # 4. CLIPPING LEVE (0–2 segmentos, 100–300 ms)
    # ══════════════════════════════════════════════════════════════════════
    total_clips = random.randint(1, 2)

    for _ in range(total_clips):
        inicio   = random.randint(int(0.5 * sample_rate), total_muestras - int(0.5 * sample_rate))
        dur_clip = int(sample_rate * random.uniform(0.10, 0.30))  # 100–300 ms
        fin      = min(inicio + dur_clip, total_muestras)
        n_seg    = fin - inicio

        if n_seg < 100:
            continue

        segmento = audio_mod[inicio:fin].copy()
        
        # 1. Medir peak local
        peak_before = float(np.max(np.abs(segmento)))
        if peak_before < 1e-4:
            continue # Demasiado silencio para clipear de forma natural sin añadir ruido de fondo
            
        clip_threshold = random.uniform(0.75, 0.92)
        
        # 2. Calcular ganancia necesaria para asegurar saturación fuerte (ej: sobrepasar el umbral en un 80%)
        target_peak = clip_threshold * 1.8
        gain_needed = target_peak / peak_before
        
        # 3. Crear envolvente de ganancia para evitar clicks artificiales (fade in/out de 5ms)
        fade_samples = min(int(sample_rate * 0.005), n_seg // 4)
        envolvente = np.ones(n_seg, dtype=np.float32) * gain_needed
        
        if fade_samples > 0:
            # Transición suave desde ganancia original 1.0 hasta gain_needed (y viceversa)
            rampa_in = np.linspace(1.0, gain_needed, fade_samples, dtype=np.float32)
            rampa_out = np.linspace(gain_needed, 1.0, fade_samples, dtype=np.float32)
            envolvente[:fade_samples] = rampa_in
            envolvente[-fade_samples:] = rampa_out
            
        if not es_stereo:
            segmento_amplificado = segmento * envolvente
            segmento_clipeado = np.clip(segmento_amplificado, -clip_threshold, clip_threshold)
            samples_clipped = np.sum(np.abs(segmento_clipeado) >= clip_threshold - 1e-5)
            peak_after = float(np.max(np.abs(segmento_clipeado)))
        else:
            envolvente_2d = envolvente[:, np.newaxis]
            segmento_amplificado = segmento * envolvente_2d
            segmento_clipeado = np.clip(segmento_amplificado, -clip_threshold, clip_threshold)
            samples_clipped = np.sum(np.abs(segmento_clipeado[:, 0]) >= clip_threshold - 1e-5)
            peak_after = float(np.max(np.abs(segmento_clipeado[:, 0])))
            
        # 4. Verificar existencia real de clipping (flat tops verificables) antes de registrar GT
        if samples_clipped > 5:
            if not es_stereo:
                audio_mod[inicio:fin] = segmento_clipeado
            else:
                audio_mod[inicio:fin, :] = segmento_clipeado
                
            t_inicio_s = inicio / sample_rate
            t_fin_s    = fin    / sample_rate
            dur_ms     = (fin - inicio) / sample_rate * 1000.0

            gt_events.append({
                "StartTime":    round(t_inicio_s, 6),
                "EndTime":      round(t_fin_s,    6),
                "ArtifactType": "clipping",
                "Magnitude":    round(clip_threshold, 4),
                "Metadata":     f"dur_ms={dur_ms:.1f},threshold={clip_threshold:.2f}"
            })

            print(f"  [!] CLIPPING en {t_inicio_s:.2f}s | Techo: {clip_threshold:.2f} | Peak In: {peak_before:.3f} | Gain: {gain_needed:.2f}x | Samples Clipped: {samples_clipped}")
        else:
            print(f"  [!] Clipping fallido en {inicio/sample_rate:.2f}s (No alcanzó flat-tops)")

    # ══════════════════════════════════════════════════════════════════════
    # 5. HUM SEGMENTADO (1–4 segmentos, 2–15 s, 50 Hz + armónicos)
    # ══════════════════════════════════════════════════════════════════════
    # Amplitud aleatoria por segmento entre 0.01 y 0.05
    segmentos_hum = _segmentos_aleatorios(
        duracion_total_s=duracion_s,
        n_min=1, n_max=4,
        dur_min_s=2.0, dur_max_s=15.0
    )

    for seg_inicio_s, seg_fin_s in segmentos_hum:
        seg_inicio = int(seg_inicio_s * sample_rate)
        seg_fin    = int(seg_fin_s    * sample_rate)
        seg_fin    = min(seg_fin, total_muestras)
        n_seg      = seg_fin - seg_inicio

        if n_seg < 100:
            continue

        # Tiempo local del segmento
        t_seg = t_global[seg_inicio:seg_fin]

        # Amplitud aleatoria: 0.01 – 0.05
        amp_hum = random.uniform(0.01, 0.05)

        # Fundamental 50 Hz + 2 armónicos (100 Hz, 150 Hz)
        hum_seg = (
            amp_hum         * np.sin(2 * np.pi * 50  * t_seg) +
            amp_hum * 0.5   * np.sin(2 * np.pi * 100 * t_seg) +
            amp_hum * 0.25  * np.sin(2 * np.pi * 150 * t_seg)
        )

        # Fade-in / fade-out de 80 ms para transición suave
        _aplicar_fade(hum_seg, sample_rate, fade_ms=80)

        if not es_stereo:
            audio_mod[seg_inicio:seg_fin] += hum_seg
        else:
            audio_mod[seg_inicio:seg_fin, 0] += hum_seg
            audio_mod[seg_inicio:seg_fin, 1] += hum_seg

        gt_events.append({
            "StartTime":    round(seg_inicio_s, 6),
            "EndTime":      round(seg_fin_s,    6),
            "ArtifactType": "hum_50hz",
            "Magnitude":    round(float(amp_hum), 4),
            "Metadata":     "harmonics=3,fade=yes"
        })

    print(f"  〰️  Segmentos de HUM inyectados: {len(segmentos_hum)}")

    # ══════════════════════════════════════════════════════════════════════
    # 6. HISS SEGMENTADO (1–3 segmentos, 3–12 s, ruido blanco suave)
    # ══════════════════════════════════════════════════════════════════════
    segmentos_hiss = _segmentos_aleatorios(
        duracion_total_s=duracion_s,
        n_min=1, n_max=3,
        dur_min_s=3.0, dur_max_s=12.0
    )

    for seg_inicio_s, seg_fin_s in segmentos_hiss:
        seg_inicio = int(seg_inicio_s * sample_rate)
        seg_fin    = int(seg_fin_s    * sample_rate)
        seg_fin    = min(seg_fin, total_muestras)
        n_seg      = seg_fin - seg_inicio

        if n_seg < 100:
            continue

        # Amplitud aleatoria: 0.01 – 0.04
        amp_hiss = random.uniform(0.01, 0.04)

        # Ruido blanco gaussiano normalizado
        ruido_seg = np.random.normal(0.0, amp_hiss, n_seg).astype(np.float32)

        # Envolvente: fade-in (10%) → sustain (80%) → fade-out (10%)
        n_fade   = max(2, n_seg // 10)
        n_sustain = n_seg - 2 * n_fade

        envolvente = np.ones(n_seg, dtype=np.float32)
        rampa_in   = 0.5 * (1 - np.cos(np.pi * np.arange(n_fade) / n_fade))
        rampa_out  = rampa_in[::-1]

        envolvente[:n_fade]                   = rampa_in
        envolvente[n_fade:n_fade + n_sustain] = 1.0   # sustain plano
        envolvente[n_fade + n_sustain:]       = rampa_out

        ruido_seg *= envolvente

        if not es_stereo:
            audio_mod[seg_inicio:seg_fin] += ruido_seg
        else:
            audio_mod[seg_inicio:seg_fin, 0] += ruido_seg
            audio_mod[seg_inicio:seg_fin, 1] += ruido_seg

        gt_events.append({
            "StartTime":    round(seg_inicio_s, 6),
            "EndTime":      round(seg_fin_s,    6),
            "ArtifactType": "hiss",
            "Magnitude":    round(float(amp_hiss), 4),
            "Metadata":     "fade=yes"
        })

    print(f"  🌫️  Segmentos de HISS inyectados: {len(segmentos_hiss)}")

    # ══════════════════════════════════════════════════════════════════════
    # 7. SUPERPOSICIÓN PROBABILÍSTICA (30%)
    #    - hum coincide con clicks
    #    - hiss coincide con dropouts
    #    - hum coincide con hiss
    # (La superposición ya ocurre naturalmente porque cada artefacto elige
    #  posiciones independientes. Aquí forzamos un 30% de coincidencia
    #  deliberada copiando el inicio de un evento existente al otro.)
    # ══════════════════════════════════════════════════════════════════════

    # Recopilar rangos de hum y hiss registrados en gt_events
    rangos_hum  = [(e["StartTime"], e["EndTime"]) for e in gt_events if e["ArtifactType"] == "hum_50hz"]
    rangos_hiss = [(e["StartTime"], e["EndTime"]) for e in gt_events if e["ArtifactType"] == "hiss"]

    # 30%: forzar un click extra dentro de un segmento de hum
    if rangos_hum and random.random() < 0.30:
        rango = random.choice(rangos_hum)
        t_extra = random.uniform(rango[0] + 0.1, max(rango[0] + 0.2, rango[1] - 0.1))
        idx_extra = int(t_extra * sample_rate)
        idx_extra = max(0, min(idx_extra, total_muestras - 3))
        val_extra = random.choice([-1.0, 1.0])

        if not es_stereo:
            audio_mod[idx_extra] = val_extra
        else:
            audio_mod[idx_extra, :] = val_extra

        gt_events.append({
            "StartTime":    round(t_extra, 6),
            "EndTime":      round(t_extra, 6),
            "ArtifactType": "click",
            "Magnitude":    round(float(abs(val_extra)), 4),
            "Metadata":     "length=1,overlap=hum"
        })
        print("  🔀 Superposición forzada: click dentro de segmento HUM")

    # 30%: forzar un dropout extra dentro de un segmento de hiss
    if rangos_hiss and random.random() < 0.30:
        rango = random.choice(rangos_hiss)
        t_extra = random.uniform(rango[0] + 0.2, max(rango[0] + 0.3, rango[1] - 0.2))
        idx_extra = int(t_extra * sample_rate)
        dur_extra = int(sample_rate * random.uniform(0.005, 0.015))
        idx_fin   = min(idx_extra + dur_extra, total_muestras)

        if not es_stereo:
            mag_extra = float(np.max(np.abs(audio_mod[idx_extra:idx_fin]))) if idx_fin > idx_extra else 0.0
            audio_mod[idx_extra:idx_fin] = 0.0
        else:
            mag_extra = float(np.max(np.abs(audio_mod[idx_extra:idx_fin, 0]))) if idx_fin > idx_extra else 0.0
            audio_mod[idx_extra:idx_fin, :] = 0.0

        gt_events.append({
            "StartTime":    round(t_extra, 6),
            "EndTime":      round(idx_fin / sample_rate, 6),
            "ArtifactType": "dropout",
            "Magnitude":    round(mag_extra, 4),
            "Metadata":     f"dur_ms={dur_extra/sample_rate*1000:.1f},overlap=hiss"
        })
        print("  🔀 Superposición forzada: dropout dentro de segmento HISS")

    # 30%: superposición de hum y hiss (ya puede ocurrir, solo registramos en log)
    if rangos_hum and rangos_hiss and random.random() < 0.30:
        print("  🔀 Superposición detectada: segmento HUM+HISS coexistentes")

    return audio_mod, gt_events


# ══════════════════════════════════════════════════════════════════════════════
# EXPORTACIÓN WAV
# ══════════════════════════════════════════════════════════════════════════════

def exportar_wav_16bit(audio, sample_rate, ruta_salida):
    """Normaliza y exporta como WAV PCM 16-bit."""
    audio = np.clip(audio, -1.0, 1.0)
    wavfile.write(ruta_salida, sample_rate, (audio * 32767).astype(np.int16))


# ══════════════════════════════════════════════════════════════════════════════
# EXPORTACIÓN GROUND TRUTH
# ══════════════════════════════════════════════════════════════════════════════

def exportar_ground_truth_v1(gt_events, ruta_csv):
    """
    Exporta Ground Truth en formato original (CSV v1).
    Columnas: SampleIndex, TimeSeconds, ArtifactType, Magnitude_DeltaV
    Usado por los modos: default, transients, all_mixed.
    """
    gt_events.sort(key=lambda x: x[0])
    with open(ruta_csv, mode='w', newline='') as file:
        writer = csv.writer(file)
        writer.writerow(["SampleIndex", "TimeSeconds", "ArtifactType", "Magnitude_DeltaV"])
        for ev in gt_events:
            writer.writerow([ev[0], f"{ev[1]:.6f}", ev[2], f"{ev[3]:.4f}"])


def exportar_ground_truth_v2(gt_events, ruta_csv):
    """
    Exporta Ground Truth en formato extendido (CSV v2).
    Columnas: StartTime, EndTime, ArtifactType, Magnitude, Metadata

    Convenciones:
      - Artefactos instantáneos (click): StartTime == EndTime
      - Artefactos con duración (hum, hiss, dropout, pop): StartTime < EndTime
      - Metadata: pares clave=valor separados por comas
    """
    # Ordenar por tiempo de inicio
    gt_events.sort(key=lambda x: x["StartTime"])
    with open(ruta_csv, mode='w', newline='') as file:
        writer = csv.writer(file)
        writer.writerow(["StartTime", "EndTime", "ArtifactType", "Magnitude", "Metadata"])
        for ev in gt_events:
            writer.writerow([
                f"{ev['StartTime']:.6f}",
                f"{ev['EndTime']:.6f}",
                ev["ArtifactType"],
                f"{ev['Magnitude']:.4f}",
                ev["Metadata"]
            ])


# ══════════════════════════════════════════════════════════════════════════════
# PUNTO DE ENTRADA
# ══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":

    # ── BANNER ────────────────────────────────────────────────────────────
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    print("  VOSTOK LABS — GENERADOR DE GROUND TRUTH v2 (SOTA)  ")
    print("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")

    # ── ARGUMENTOS CLI ────────────────────────────────────────────────────
    # Soporta uso clásico (arrastrar archivo) y uso con flags.
    # Ejemplos:
    #   python degradar_audio_v2.py audio.wav
    #   python degradar_audio_v2.py audio.wav --seed 42
    parser = argparse.ArgumentParser(
        description="Vostok Labs — Generador de Ground Truth v2",
        add_help=True
    )
    parser.add_argument(
        "archivo",
        type=str,
        help="Ruta al archivo .wav de entrada (admite arrastrar y soltar)"
    )
    parser.add_argument(
        "--seed",
        type=int,
        default=None,
        help="Semilla para reproducibilidad total (ej: --seed 42)"
    )

    # Parsear; mantener compatibilidad con sys.argv sin flags
    args = parser.parse_args()

    # ── REPRODUCIBILIDAD ──────────────────────────────────────────────────
    if args.seed is not None:
        random.seed(args.seed)
        np.random.seed(args.seed)
        print(f"🔒 Semilla fijada: {args.seed} (modo determinista)")

    # ── VALIDACIÓN DE ARCHIVO ─────────────────────────────────────────────
    ruta_raw     = args.archivo.strip("\"'")
    ruta_entrada = Path(ruta_raw).resolve()

    if not ruta_entrada.exists() or ruta_entrada.suffix.lower() != '.wav':
        print(f"❌ Error de Formato: El archivo debe ser un .wav válido.\n-> {ruta_entrada}")
        sys.exit(1)

    # Rutas de salida en la misma carpeta del original
    directorio   = ruta_entrada.parent
    nombre_base  = ruta_entrada.stem

    ruta_salida_wav = directorio / f"{nombre_base}_DEGRADADO.wav"
    ruta_salida_csv = directorio / f"{nombre_base}_GROUND_TRUTH.csv"

    print(f"📁 Archivo detectado: {ruta_entrada.name}")

    # ── MENÚ INTERACTIVO ──────────────────────────────────────────────────
    print("\n[ PERFIL DE DEGRADACIÓN FORENSE ]")
    print("  1. default      — Hum 50Hz + Hiss + Clicks (bajo nivel)")
    print("  2. transients   — Solo Clicks y Pops extremos")
    print("  3. all_mixed    — Todas las anomalías al máximo")
    print("  4. real_world   — Vinilo, casete, grabaciones de campo ★ NUEVO")

    opcion = input("\n> Ingresa un número (o presiona Enter para 'all_mixed'): ").strip()

    modo = "all_mixed"   # Fallback automático
    if   opcion == "1": modo = "default"
    elif opcion == "2": modo = "transients"
    elif opcion == "3": modo = "all_mixed"
    elif opcion == "4": modo = "real_world"

    print(f"\n⚙️  Iniciando inyección de anomalías en modo: [{modo}]...")

    try:
        # ── CARGAR AUDIO ──────────────────────────────────────────────────
        sample_rate, audio_original = wavfile.read(ruta_entrada)
        audio_float = convertir_a_float(audio_original)

        # ── INYECTAR ARTEFACTOS ───────────────────────────────────────────
        if modo == "real_world":
            # Motor nuevo: retorna gt_events como lista de dicts (formato v2)
            audio_mod, eventos_gt = inyectar_real_world(audio_float, sample_rate)
            usar_gt_v2 = True
        else:
            # Motor original: retorna gt_events como lista de tuplas (formato v1)
            audio_mod, eventos_gt = inyectar_artefactos(audio_float, sample_rate, modo)
            usar_gt_v2 = False

        # ── EXPORTAR RESULTADOS ───────────────────────────────────────────
        exportar_wav_16bit(audio_mod, sample_rate, ruta_salida_wav)

        if usar_gt_v2:
            exportar_ground_truth_v2(eventos_gt, ruta_salida_csv)
        else:
            exportar_ground_truth_v1(eventos_gt, ruta_salida_csv)

        # ── RESUMEN FINAL ─────────────────────────────────────────────────
        print("\n──────────────────────────────────────────────────────")
        print("✅ PROCEDIMIENTO COMPLETADO CON ÉXITO")
        print(f"🎵 Audio inyectado : {ruta_salida_wav.name}")
        print(f"📊 Ground Truth    : {ruta_salida_csv.name}")
        if args.seed is not None:
            print(f"🔒 Semilla usada   : {args.seed}")
        print("──────────────────────────────────────────────────────\n")

    except Exception as e:
        print(f"\n❌ Falla crítica en el motor de degradación: {e}")
        raise
