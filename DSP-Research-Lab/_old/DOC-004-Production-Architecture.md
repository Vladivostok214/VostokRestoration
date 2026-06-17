# DOC-004: Production Architecture Snapshot

## Stack Tecnológico
* **Frontend UI**: React 19, vite. Interfaz basada en principios "Noir-Tech".
* **Core & Bridge**: Tauri v2, ofreciendo el shell y la capa de intercomunicación (IPC).
* **Backend DSP**: Rust (1.77+), optimizado para cálculo numérico seguro y de alto rendimiento.
* **Renderizado Visual**: WebGL y Canvas 2D (`SpectrogramGL.jsx`), esenciales para visualizar información de audio densa de forma fluida.
* **Dependencias Críticas**:
  * *Rust*: `symphonia` (decodificación), `rodio` (reproducción), `rustfft` (transformadas de Fourier), `rayon` (multithreading), `hound` (lectura/escritura PCM).
  * *React*: `@tauri-apps/api` (invocaciones IPC), `lucide-react` (iconografía).

---

## Arquitectura General

El ciclo de vida de los datos sigue un patrón unidireccional fuertemente desacoplado:

**Audio Local (WAV/FLAC)** 
↓ *(Decodificación vía Symphonia en Rust)*
**Backend DSP** *(Cálculo de STFT y Detección Analítica)*
↓ *(Almacenamiento en Memoria)*
**AppState** *(Estructuras `Mutex` protegidas con datos Float32 en bruto)*
↓ *(Serialización asíncrona a pedido por viewport)*
**IPC** *(Tauri Events/Commands a través de Base64 o arrays binarios)*
↓ *(Des-serialización a `Uint8Array`)*
**Frontend React** *(Orquestación y control de estado UI)*
↓ *(Asignación de textura GPU)*
**Visualización WebGL** *(SpectrogramGL renderizando en tiempo real)*

---

## Backend

* **`main.rs`**: Punto de entrada mínimo. Bootstrap del generador de la aplicación Tauri.
* **`lib.rs`**: Gestor del estado global (`AppState`). Define comandos IPC asíncronos para cargar archivos, solicitar recortes del espectrograma (`obtener_espectrograma_visible`) y reproducir audio (`SafeOutputStream`). Resuelve la problemática de multihilo con `Arc<Mutex<...>>` compartidos.
* **`dsp.rs` / `dsp_recovered.rs`**: Núcleo computacional puro. 
  * *Responsabilidades*: Análisis FFT, estimación del 'noise floor', perfiles de resolución temporo-frecuencial, detección algorítmica de glitches. 
  * *Dependencias*: Agnóstico al UI, depende estrictamente de `rustfft` y `rayon`.

---

## Frontend

* **`VostokRestoration.jsx`**: "Workspace" unificado y monolítico (orquestador). Coordina la reproducción (Transport Bar), el rango de visualización (Viewport zoom/pan), la línea temporal (Scrubbers) y el manejo de los estados recibidos del backend.
* **`SpectrogramGL.jsx`**: Renderizador especializado. Recibe un string en base64 o un Uint8Array representando magnitudes de STFT y dibuja dinámicamente un plano 2D usando WebGL puro.
* **`GlitchPanel.jsx` / Componentes Auxiliares**: Interfaces flotantes o paneles "Bento Grid" encargados de mostrar y accionar reparaciones de las anomalías reportadas.

---

## Analytical Spectrogram

El espectrograma no es una imagen estática, es una estructura de datos analítica:
* **Construcción**: Generado inmediatamente al cargar un archivo. Usa ventanas "Hann" y aplica FFT basado en `ResolutionProfile` (ej. TransientMode vs HumMasteringMode).
* **Almacenamiento**: `stft: Mutex<Option<Arc<AnalyticalSpectrogram>>>`. Se retiene en RAM de Rust como una matriz gigante bidimensional de flotantes.
* **Consultas**: El frontend envía un request `ViewportConfig` (inicio y fin de cuadro). Rust fragmenta la matriz gigante en tiempo constante y serializa solo el área de pantalla solicitada para prevenir colapso de memoria de JS.
* **Integración con detectores**: Los algoritmos (`clicks`, `pops`, `hum`) pueden acceder en memoria directamente al `Arc<AnalyticalSpectrogram>` simultáneamente mientras el frontend renderiza.

---

## Sistema de Feature Flags

Actualmente manejado localmente en la inicialización de sesiones del UI y en el AppState:
* **Inventario de Flags Visuales/Detectores** (Almacenados en `selectedArtifacts` en Frontend):
  * `clicks`, `pops`, `clipping`, `hum`, `dropouts`, `hiss`.
  * `use_hybrid_click_detector` (Experimental / Activable por usuario).
* **Perfiles de backend**: `TransientMode` (alta resolución temporal) vs `HumMasteringMode` (alta resolución de frecuencias).

---

## Cuellos de Botella Potenciales

* **CPU**: El primer cálculo del STFT bloquea un hilo intensivo (`spawn_blocking`), lo que puede causar retrasos de respuesta de la UI ("hiccups") en archivos grandes.
* **RAM**: Archivos de audio masivos (+60 minutos) forzarán a Tauri a almacenar toda la matriz analítica en RAM de Rust simultáneamente. Posible Out-Of-Memory sin mecanismo de swapping a disco.
* **IPC (Inter-Process Communication)**: Transportar matrices de píxeles vía Base64 (`window.atob(base64)`) añade overhead severo (1.33x tamaño) comparado con el paso de punteros binarios puros, afectando los refrescos rápidos de pantalla al hacer zoom.
* **WebGL**: Limitaciones de hardware en `max_texture_width: 2048`. Subir un buffer masivo al GPU para renderizar puede perder fotogramas.

---

## Identificación de Deuda Técnica Visible

1. **Serialización Ineficiente**: Base64 IPC decoding repetido en el hilo UI para texturas dinámicas.
2. **God Object React**: `VostokRestoration.jsx` asume roles tanto de presentador como controlador y puente IPC pesado (>1100 líneas).
3. **Locking Mutex Globales**: El backend usa `std::sync::Mutex` asíncrono-incómodo, pudiendo llegar a paralizar invocaciones concurrentes durante un renderizado de vista grande.
4. **Resiliencia RAM**: No existe partición en disco temporal para audios extensos. Depende un 100% de RAM instalada.

*(Generado por Vostok AI Architect).*
