'use client'

import { X } from 'lucide-react'
import { useTheme } from '../ThemeContext'
import { ThemePreviewCard } from './ThemePreviewCard'

interface Props {
  open: boolean
  onClose: () => void
}

export function ThemesModal({ open, onClose }: Props) {
  const { themeId, syncWithSystem, setThemeId, setSyncWithSystem, themes } = useTheme()

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[660px] max-w-[92vw] max-h-[86vh] overflow-y-auto rounded-xl border border-pm-border bg-pm-bg shadow-2xl shadow-black/70"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-pm-border">
          <h2 className="text-[15px] font-semibold text-pm-text">Themes</h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md text-pm-text-muted hover:text-pm-text hover:bg-white/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pt-4 pb-1">
          <p className="text-[12px] text-pm-text-muted leading-relaxed">
            Personalize your experience with themes that match your style. Manually select a theme
            or sync with system settings and let the machine set your day and night themes.
          </p>
        </div>

        <div className="flex items-center justify-between px-5 py-3">
          <span className="text-[11.5px] font-medium text-pm-text-muted">Theme selection</span>

          <div className="flex items-center gap-4">
            <button
              type="button"
              onClick={() => setSyncWithSystem(true)}
              className="flex items-center gap-1.5 cursor-pointer"
            >
              <span
                className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                  syncWithSystem ? 'border-[#2f67cc]' : 'border-pm-border'
                }`}
              >
                {syncWithSystem && <span className="w-1.5 h-1.5 rounded-full bg-[#2f67cc]" />}
              </span>
              <span className="text-[12px] text-pm-text-secondary">Sync with system</span>
            </button>

            <button
              type="button"
              onClick={() => setSyncWithSystem(false)}
              className="flex items-center gap-1.5 cursor-pointer"
            >
              <span
                className={`w-3.5 h-3.5 rounded-full border flex items-center justify-center ${
                  !syncWithSystem ? 'border-[#2f67cc]' : 'border-pm-border'
                }`}
              >
                {!syncWithSystem && <span className="w-1.5 h-1.5 rounded-full bg-[#2f67cc]" />}
              </span>
              <span className="text-[12px] text-pm-text-secondary">Manual</span>
            </button>
          </div>
        </div>

        <div className="px-5 pb-5 grid grid-cols-3 gap-3">
          {themes.map((theme) => (
            <ThemePreviewCard
              key={theme.id}
              theme={theme}
              selected={!syncWithSystem && themeId === theme.id}
              disabled={!theme.implemented || syncWithSystem}
              comingSoon={!theme.implemented}
              onSelect={() => setThemeId(theme.id)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
