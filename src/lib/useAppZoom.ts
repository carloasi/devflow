'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

// Zoom da janela inteira (mesma ideia do Ctrl + roda do mouse do navegador).
// Usa o zoom nativo da webview do Tauri (getCurrentWebview().setZoom) em vez
// de `transform: scale` no CSS — assim o texto é re-renderizado nítido em
// cada nível, o layout reflui normalmente e o Monaco continua calculando as
// posições do cursor certinho (com scale ele erra o hit-test do clique).
//
// Requer a permissão `core:webview:allow-set-webview-zoom` nas capabilities
// (ver src-tauri/capabilities/*.json).

const ZOOM_STORAGE_KEY = 'app_zoom_factor';
// Exportados pro seletor de porcentagem da barra de status (ZoomControl.tsx)
// montar as opções e validar o valor digitado com os mesmos limites que o
// clamp daqui aplica — senão a UI ofereceria níveis que seriam recortados.
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 2.5;
const ZOOM_STEP = 0.1;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value * 100) / 100));
}

function readStoredZoom(): number {
  try {
    const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
    if (!raw) return 1;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? clampZoom(parsed) : 1;
  } catch {
    return 1;
  }
}

interface UseAppZoomResult {
  zoom: number;
  setZoom: (factor: number) => void;
  resetZoom: () => void;
}

export function useAppZoom(): UseAppZoomResult {
  const [zoom, setZoomState] = useState(1);
  // O valor atual num ref: os listeners de wheel/teclado são registrados uma
  // única vez (precisam de { passive: false }), então não podem depender do
  // `zoom` do closure senão ficariam sempre lendo o valor inicial.
  const zoomRef = useRef(1);

  const applyZoom = useCallback((factor: number) => {
    const next = clampZoom(factor);
    if (next === zoomRef.current) return;

    zoomRef.current = next;
    setZoomState(next);

    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(next));
    } catch {
      // sem localStorage o zoom só não persiste entre sessões
    }

    import('@tauri-apps/api/webview')
      .then(({ getCurrentWebview }) => getCurrentWebview().setZoom(next))
      .catch(err => console.error('Erro ao aplicar zoom da janela:', err));
  }, []);

  const resetZoom = useCallback(() => applyZoom(1), [applyZoom]);

  // Restaura o zoom salvo ao abrir a janela.
  useEffect(() => {
    const stored = readStoredZoom();
    if (stored === 1) return;
    zoomRef.current = 1;
    applyZoom(stored);
  }, [applyZoom]);

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // preventDefault exige { passive: false } no addEventListener; sem
      // isso o Chromium ignora e a página faz o zoom "de fábrica" junto,
      // dobrando o efeito.
      e.preventDefault();
      // deltaY < 0 = roda pra cima = aproximar.
      const direction = e.deltaY < 0 ? 1 : -1;
      applyZoom(zoomRef.current + direction * ZOOM_STEP);
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // '=' cobre o Ctrl+'+' sem shift na maioria dos layouts; 'Add'/
      // 'Subtract' são o +/- do teclado numérico.
      if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
        e.preventDefault();
        applyZoom(zoomRef.current + ZOOM_STEP);
      } else if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        applyZoom(zoomRef.current - ZOOM_STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        applyZoom(1);
      }
    };

    // capture: true porque o Monaco registra os próprios listeners de wheel
    // nos editores — na fase de bubble o evento poderia ser consumido antes
    // de chegar aqui, e o Ctrl+roda não funcionaria justamente sobre o
    // editor de body/response, que é onde mais se quer aumentar a fonte.
    window.addEventListener('wheel', handleWheel, { passive: false, capture: true });
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('wheel', handleWheel, { capture: true });
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [applyZoom]);

  return { zoom, setZoom: applyZoom, resetZoom };
}
