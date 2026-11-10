'use client'

import { useSyncExternalStore } from 'react'

// Idioma da interface. Começa só com a tela de revisão do GitHub
// (SyncDiffDialog) traduzida — o resto do app continua em inglês até ganhar
// o seu próprio dicionário (ver syncDiffStrings.tsx como modelo).
//
// Guardado no localStorage e lido por useSyncExternalStore, sem Provider:
// assim qualquer componente (e outras janelas, pelo evento `storage`) segue a
// troca na hora, sem precisar estar debaixo de um contexto montado no topo.

export type Language = 'en' | 'pt-BR'

export const LANGUAGES: readonly { id: Language; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'pt-BR', label: 'Português (Brasil)' },
]

const STORAGE_KEY = 'devflow_language'
const DEFAULT_LANGUAGE: Language = 'en'

function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some(l => l.id === value)
}

export function getLanguage(): Language {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isLanguage(stored) ? stored : DEFAULT_LANGUAGE
  } catch {
    return DEFAULT_LANGUAGE
  }
}

const listeners = new Set<() => void>()

export function setLanguage(language: Language): void {
  try {
    localStorage.setItem(STORAGE_KEY, language)
  } catch {
    // Sem storage: a troca vale só até fechar o app.
  }
  listeners.forEach(fn => fn())
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange)
  const onStorage = (e: StorageEvent) => {
    if (e.key === STORAGE_KEY) onChange()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function useLanguage(): Language {
  return useSyncExternalStore(subscribe, getLanguage, () => DEFAULT_LANGUAGE)
}
