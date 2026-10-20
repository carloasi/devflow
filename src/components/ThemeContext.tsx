'use client'

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import { DEFAULT_THEME_ID, THEMES, ThemeDefinition, ThemeMode } from '@/app/types/Theme'

const THEME_STORAGE_KEY = 'devflow_theme_id'
const SYNC_STORAGE_KEY = 'devflow_theme_sync_with_system'

interface ThemeContextType {
  /** Tema escolhido manualmente (ignorado quando syncWithSystem=true) */
  themeId: string
  /** Tema efetivamente aplicado agora (considera syncWithSystem) */
  effectiveThemeId: string
  syncWithSystem: boolean
  setThemeId: (id: string) => void
  setSyncWithSystem: (value: boolean) => void
  themes: ThemeDefinition[]
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined)

function getSystemPrefersDark(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return true
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

// Só dark/light têm uma paleta "system" óbvia — qualquer outro tema
// escolhido manualmente vira o efetivo mesmo com sync desligado; o sync só
// decide ENTRE dark e light, igual a maioria dos apps faz.
function resolveSystemThemeId(): string {
  return getSystemPrefersDark() ? 'dark' : 'light'
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [themeId, setThemeIdState] = useState<string>(DEFAULT_THEME_ID)
  const [syncWithSystem, setSyncWithSystemState] = useState<boolean>(false)
  const [hydrated, setHydrated] = useState(false)

  // Hidrata do localStorage no mount (client-only). O <html> já recebe o
  // data-theme certo antes disso via script inline no layout.tsx, então não
  // há flash — isto só sincroniza o estado React com o que já está na tela.
  useEffect(() => {
    try {
      const storedTheme = localStorage.getItem(THEME_STORAGE_KEY)
      const storedSync = localStorage.getItem(SYNC_STORAGE_KEY)
      if (storedTheme && THEMES.some(t => t.id === storedTheme)) {
        setThemeIdState(storedTheme)
      }
      if (storedSync === 'true') setSyncWithSystemState(true)
    } catch {
      // localStorage indisponível — segue com os defaults
    }
    setHydrated(true)
  }, [])

  const effectiveThemeId = useMemo(() => {
    if (syncWithSystem) return resolveSystemThemeId()
    return themeId
  }, [syncWithSystem, themeId])

  // Aplica o atributo no <html> sempre que o tema efetivo mudar.
  useEffect(() => {
    if (!hydrated) return
    document.documentElement.setAttribute('data-theme', effectiveThemeId)
  }, [effectiveThemeId, hydrated])

  // Enquanto syncWithSystem estiver ligado, escuta mudanças do SO em tempo
  // real (ex.: usuário troca o modo escuro do Windows/macOS com o app aberto).
  useEffect(() => {
    if (!syncWithSystem || typeof window === 'undefined' || !window.matchMedia) return
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => {
      document.documentElement.setAttribute('data-theme', resolveSystemThemeId())
    }
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [syncWithSystem])

  const setThemeId = useCallback((id: string) => {
    const theme = THEMES.find(t => t.id === id)
    if (!theme || !theme.implemented) return
    setThemeIdState(id)
    // Escolher um tema manualmente desliga o "Sync with system" — igual ao
    // Postman: os dois modos (Sync with system / Manual) são mutuamente
    // exclusivos na UI.
    setSyncWithSystemState(false)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, id)
      localStorage.setItem(SYNC_STORAGE_KEY, 'false')
    } catch {
      // ignora — só perde a persistência entre sessões
    }
  }, [])

  const setSyncWithSystem = useCallback((value: boolean) => {
    setSyncWithSystemState(value)
    try {
      localStorage.setItem(SYNC_STORAGE_KEY, String(value))
    } catch {
      // ignora
    }
  }, [])

  const value = useMemo<ThemeContextType>(() => ({
    themeId,
    effectiveThemeId,
    syncWithSystem,
    setThemeId,
    setSyncWithSystem,
    themes: THEMES,
  }), [themeId, effectiveThemeId, syncWithSystem, setThemeId, setSyncWithSystem])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextType {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}

export type { ThemeMode }
