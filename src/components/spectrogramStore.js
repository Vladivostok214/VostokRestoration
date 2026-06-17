// src/components/spectrogramStore.js
// Almacenamiento transitorio global aislado para evitar colisiones con el HMR de React

export const SPECTROGRAM_STORAGE = {
  transient: null,
  hum: null
};