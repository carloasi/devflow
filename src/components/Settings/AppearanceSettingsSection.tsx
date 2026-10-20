'use client'

import { useState } from 'react'
import { Palette } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { ThemesModal } from './ThemesModal'

export function AppearanceSettingsSection() {
  const [themesOpen, setThemesOpen] = useState(false)
  const { themes, themeId, syncWithSystem } = useTheme()

  const currentLabel = syncWithSystem
    ? 'Sync with system'
    : themes.find(t => t.id === themeId)?.name ?? 'Dark'

  return (
    <div>
      <h3 className="text-sm font-semibold text-pm-text mb-2">Appearance</h3>

      <div className="flex items-center justify-between py-3">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-pm-text">Theme</p>
          <p className="text-xs text-pm-text-muted mt-0.5">
            Currently using <span className="text-pm-text-secondary">{currentLabel}</span>.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setThemesOpen(true)}
          className="flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-pm-text-secondary border border-pm-border hover:bg-pm-hover transition-colors cursor-pointer shrink-0"
        >
          <Palette size={12} /> Themes
        </button>
      </div>

      <ThemesModal open={themesOpen} onClose={() => setThemesOpen(false)} />
    </div>
  )
}
