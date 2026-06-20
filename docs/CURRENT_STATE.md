# Vostok Restoration DSP - CURRENT_STATE

Última actualización: 2026-06-20

Cobertura:
P1.5 → P1.10E


| Detector | Estado | Precisión | Recall | Prioridad |
| -------- | ------ | --------- | ------ | --------- |
| Click    | 🟢     | 100%      | 83.3%  | ALTA      |
| Pop      | 🟡     | 83.3%     | 83.3%  | MEDIA     |
| Hum      | 🟢     | 100%      | 100%   | BAJA      |
| Hiss     | 🟢     | 100%      | 100%   | BAJA      |
| Dropout  | 🟡     | 66.7%     | 100%   | ALTA     |
| Clipping | 🟢     | 100%      | 100%   | BAJA      |


### Métricas Globales Actuales

Precision: 96.88%
Recall: 86.11%
F1 Score: 91.18%
---

# Detector: Click

Estado: 🟢 Funcional

Métricas:

* Precision: 100%
* Recall: 83.3%
* F1: 90.9%

Documentación asociada:

* P1.8A REPORTE TECNICO TRAZABILIDAD DEL CLICK
* P1.8B REPORTE TÉCNICO REFACTORIZACIÓN DEL GENERADOR DE CLICKS
* P1.9A OBJETIVOS AUDITORÍA RECALL DE CLICKS
* P1.9A.1 REPORTE DE VALIDACIÓN EXPERIMENTAL
* P1.9B REPORTE AUDITORIA CUANTITATIVA REGLAS DETECTOR DE CLICKS
* P1.9C REPORTE TECNICO DISEÑO EXPERIMENTAL REEMPLAZO REGLA DE FIRMA FÍSICA
* P1.9D REPORTE TECNICO DE IMPLEMENTACION Y VALIDACIÓN
* P1.9D RESULTADOS BENCHMARK GLOBAL

Conclusiones confirmadas:

* El detector LPC detecta correctamente los clicks.
* Los clicks sintéticos antiguos contaminaban el benchmark.
* La reclasificación Click -> Distortion ya fue corregida.
* Alternativa A (Relajación Controlada por Asimetría de Magnitud) resolvió los FN por cabalgamiento.

Hipótesis abiertas:

* Los 4 FN restantes están documentados (1 falla de ratio_next, 2 por Sibilancia Estricta).

Próximo paso:

* Ninguno para Clicks por ahora.

---

# Detector: Pop

Estado: 🟢 Estable

Precision: 83.3%
Recall: 83.3%
F1: 83.3%

Conclusiones confirmadas:

- El filtro ZCR eliminó los falsos positivos vocales principales.
- La consolidación Click↔Pop fue refinada durante P1.10.
- El margen contextual de Clipping fue ampliado para absorber precursores energéticos.
- El detector ya no presenta falsos positivos masivos.

Hipótesis abiertas:

- GT-032 permanece como único Error de Tipo conocido.

Próximo paso:

- Ninguno inmediato.
- Reabrir únicamente si GT-032 se convierte en prioridad.
---

# Detector: Hum

Estado: 🟢 Estable

Métricas:

* Precision: 100%
* Recall: 100%

Documentación asociada:

* P1.5 REPORTE TÉCNICO IMPLEMENTACIÓN
* P1.5 RESULTADOS IMPLEMENTACIÓN

Conclusiones confirmadas:

* El filtro de estabilidad frecuencial funciona correctamente.

Hipótesis abiertas:

* Ninguna.

---

# Detector: Hiss

Estado: 🟢 Estable

Métricas:

* Precision: 100%
* Recall: 100%

Documentación asociada:

* AUDITORIA_GLOBAL_DETECTORES.md
* P1.5 RESULTADOS IMPLEMENTACIÓN

Conclusiones confirmadas:

* Corrección de gap_tolerance validada.

Hipótesis abiertas:

* Ninguna.

---

# Detector: Dropout

Estado: 🟡 Mejorable

Métricas:

* Precision: 66.7%
* Recall: 100%

Documentación asociada:

* AUDITORIA_GLOBAL_DETECTORES.md

Conclusiones confirmadas:

* Detecta correctamente los dropouts reales.

Hipótesis abiertas:

* Investigar FP persistente en ~101.647s.

---

# Detector: Clipping

Estado: 🟢 Funcional

Métricas:

* Precision: 100%
* Recall: 100%

Documentación asociada:

* P1.6A REPORTE TÉCNICO AUDITORÍA CLIPPING
* P1.6B REPORTE TÉCNICO
* P1.7A REPORTE TÉCNICO AUDITORÍA DETECTOR CLIPPING
* P1.7B REPORTE TÉCNICO CORRECCIÓN ACTIVADOR CLIPPING
* P1.7C REPORTE TÉCNICO AUDITORÍA TRAZABILIDAD
* P1.7D REPORTE TÉCNICO AUDITORÍA FLUJO SCANPARAMS
* P1.7E REPORTE TÉCNICO IMPLEMENTACIÓN DETECTOR
* P1.7F REPORTE TÉCNICO CLIPPING POR VENTANAS
* P1.7G REPORTE FORENSE DE CONSOLIDACIÓN
* P1.7H REPORTE TÉCNICO CONSOLIDACIÓN DE REGIONES

Conclusiones confirmadas:

* Distortion estaba deshabilitado en UI.
* El generador producía falsos GT.
* El detector necesitaba ventanas locales.
* La fragmentación temporal fue corregida.

Hipótesis abiertas:

* Ninguna crítica.

---

# Hipótesis Cerradas

* Distortion=false en frontend.
* Clicks sintéticos generados como flat-top.
* Clipping generator defectuoso.
* Fragmentación de regiones de clipping.
* Incompatibilidad Distortion <-> Clipping.
* Firma Física Estricta como causa de FN masivo de Clicks (Solucionado en P1.9D).

# P1.10 - Pop Precision Refinement (Completado)

Objetivo:
Eliminar falsos positivos residuales y errores de clasificación
sin modificar detectores DSP.

Documentación:

- P1.10A REPORTE TÉCNICO AUDITORÍA PRECISIÓN POPS
- P1.10B REPORTE TÉCNICO DISEÑO EXPERIMENTAL
- P1.10C REPORTE TÉCNICO IMPLEMENTACIÓN
- P1.10D REPORTE FORENSE CASOS RESIDUALES
- P1.10E REPORTE TÉCNICO IMPLEMENTACIÓN

Resultados:

- VOS-17 eliminado correctamente mediante expansión de margen contextual de clipping.
- Consolidación Click↔Pop mejorada.
- Falsos positivos globales reducidos.
- Precision global aumentada a 96.88%.

Casos abiertos:

- GT-032:
  Click clasificado como Pop.
  Único error de clasificación restante del detector Pop.

---

# Línea de Investigación Activa

LAB-DROPOUT-003

Objetivo:
Determinar la causa raíz del falso positivo persistente
en ~101.647s y mejorar la precisión del detector Dropout.


# DSP Maturity Snapshot

Hum:
🟢 Producción

Hiss:
🟢 Producción

Clipping:
🟢 Producción

Click:
🟢 Producción (Recall limitado por casos extremos conocidos)

Pop:
🟢 Estable (1 error de clasificación residual)

Dropout:
🟡 Requiere refinamiento

Estado global del motor DSP:
🟢 Estabilizado

Último benchmark:
Precision = 96.88%
Recall = 86.11%
F1 = 91.18%