# PROD-001: Hybrid Click Detector Integration

**Estado**: Completado  
**Fecha**: Junio 2026

## Resumen Ejecutivo

Como resultado del ciclo de investigaciones sobre la detección de clicks (desde `INV-001` hasta `INV-001E`), se ha integrado oficialmente en el backend el nuevo **Hybrid Click Detector**. Esta integración se ha realizado preservando la estabilidad del motor existente (`dsp.rs`) e incluye configuraciones de umbrales adaptativos basados en el modelo HFER, cálculos de métricas y puntuaciones de confianza nativas.

## Cambios Implementados

### 1. Despliegue Paralelo (Feature Flag)
El nuevo detector híbrido está activado mediante la bandera de configuración `use_hybrid_click_detector`. 
- Si es falso (default actual de legacy UI), el sistema continúa utilizando el método antiguo basado exclusivamente en STFT (Peak vs RMS & Bandwidth), manteniendo total compatibilidad hacia atrás.
- Si es verdadero, el motor puentea el detector antiguo e invoca al nuevo pipeline LPC + HFER de manera transparente para el resto de la aplicación.

### 2. Actualizaciones Estructurales
Se han ampliado las estructuras fundamentales de IPC entre el core Rust y Tauri:
- **`GlitchEvent`**: Se añadió el campo `pub confidence: f32`.
  - En los detectores Legacy, esta confianza asume el valor `1.0`.
  - En el Hybrid Click Detector, esta confianza es un valor continuo (0.0 a 1.0) calculado a partir de qué tanto excede el HFER detectado al nivel de sensibilidad.
- **`DetectorThresholds`**: Se añadió `pub spectral_sensitivity: f32` (valor por defecto `0.12`).
  - Esta variable expone el umbral base de la función HFER, unificando en una sola constante el control de Falsos Positivos frente al enmascaramiento del ruido de fondo, permitiendo ajuste asimétrico y expuesto al usuario.

### 3. Pipeline Híbrido en `detect_artifacts_dynamic`
La lógica implementada es un mapeo directo de los descubrimientos del laboratorio:
1. **LPC Pasada Temporal**: Detecta candidatos usando un Filtro Predictivo Adaptativo LMS de 2º orden. Busca discontinuidades temporales marcadas.
2. **Clustering Temporal**: Poda eventos cercanos para mantener 1 evento maestro por click individual.
3. **Validación Espectral HFER**: Para cada candidato, la arquitectura consulta la capa `AnalyticalSpectrogram` (recientemente desacoplada) y extrae localmente la relación de alta frecuencia sobre baja frecuencia. Se descartan las discontinuidades no acústicas.

### 4. Telemetría y Rendimiento
Se ha inyectado telemetría a nivel logístico interno para cuantificar el costo real en producción.
Ejemplo de output capturado tras el paso del detector:
```
[PROD-001 Metrics] Total: 41ms, LPC: 34ms, HFER: 6.8ms, Queries: 125, Mem: ~350KB
```

## Próximos Pasos (Frontend)

Con el motor preparado, la siguiente fase natural de producción (PROD-002 o equivalente) será exponer este feature flag al usuario y diseñar la interfaz para el ajuste de `spectral_sensitivity`.

La línea base del motor DSP (*DSP_BASELINE.md*) se encuentra actualizada a la versión 1.1 con esta nueva arquitectura.
