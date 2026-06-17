import { useState, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';

export const useTileLoader = () => {
  const [cache, setCache] = useState({});
  const loadingRef = useRef(new Set());

  const loadTile = useCallback(async (tileId) => {
    // Si ya está cargado o cargando, retornar
    if (cache[tileId] || loadingRef.current.has(tileId)) {
      return cache[tileId];
    }

    loadingRef.current.add(tileId);

    try {
      // Llamada al comando Rust definido en el backend
      const binaryData = await invoke('get_tile_data', { id: tileId });
      const arrayBuffer = new Uint8Array(binaryData);

      setCache(prev => ({
        ...prev,
        [tileId]: arrayBuffer
      }));
      
      return arrayBuffer;
    } catch (err) {
      console.error(`Error loading tile ${tileId}:`, err);
      return null;
    } finally {
      loadingRef.current.delete(tileId);
    }
  }, [cache]);

  return { loadTile, cache };
};
