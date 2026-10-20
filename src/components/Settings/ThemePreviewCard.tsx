'use client'

import { ThemeDefinition } from '@/app/types/Theme'

interface Props {
  theme: ThemeDefinition
  selected: boolean
  disabled: boolean
  /** true só quando o tema em si não tem paleta pronta (theme.implemented
   * === false). Diferente de `disabled`, que também fica true durante o
   * modo "Sync with system" — nesse caso o card fica desabilitado/apagado
   * mas não deve mostrar "Soon", já que o tema é real. */
  comingSoon: boolean
  onSelect: () => void
}

// Mini-mockup de "janela" usado nos cards da tela Themes — reproduz em
// miniatura a barra de título + um input + algumas barrinhas de "texto",
// coloridas com a paleta de preview daquele tema (ver Theme.ts).
export function ThemePreviewCard({ theme, selected, disabled, comingSoon, onSelect }: Props) {
  const { preview } = theme

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      className={`group flex flex-col gap-2 text-left rounded-lg p-1.5 transition-colors ${
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
      }`}
    >
      <div
        className={`relative rounded-lg overflow-hidden border-2 transition-colors ${
          selected
            ? 'border-[#ff6c37]'
            : disabled
              ? 'border-transparent'
              : 'border-transparent group-hover:border-pm-border'
        }`}
        style={{ background: preview.contentBg }}
      >
        {comingSoon && (
          <span className="absolute top-1.5 right-1.5 z-10 px-1.5 py-0.5 rounded text-[8px] font-semibold tracking-wide uppercase bg-black/60 text-zinc-300">
            Soon
          </span>
        )}

        {/* Barra de título fake */}
        <div className="h-5 flex items-center gap-1 px-2" style={{ background: preview.titleBarBg }}>
          <span className="w-1 h-1 rounded-full opacity-70" style={{ background: preview.textBar }} />
          <span className="w-1 h-1 rounded-full opacity-70" style={{ background: preview.textBar }} />
          <span className="w-1 h-1 rounded-full opacity-70" style={{ background: preview.textBar }} />
          <span className="flex-1 h-1 rounded-full ml-1.5 max-w-[46px]" style={{ background: preview.textBar }} />
          <span className="ml-auto w-1.5 h-1.5 rounded-full" style={{ background: preview.accent }} />
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: preview.accentSecondary }} />
        </div>

        {/* Conteúdo fake */}
        <div className="px-2.5 py-2.5 flex flex-col gap-1.5">
          <span className="h-1 w-1/3 rounded-full opacity-80" style={{ background: preview.textBar }} />

          <div className="flex items-center gap-1.5">
            <span
              className="flex-1 h-3.5 rounded border"
              style={{ borderColor: preview.inputBorder, background: 'transparent' }}
            />
            <span className="w-7 h-3.5 rounded" style={{ background: preview.accent }} />
          </div>

          <div className="flex items-center gap-1 mt-0.5">
            <span className="h-1 w-7 rounded-full" style={{ background: preview.accentSecondary }} />
            <span className="h-1 w-4 rounded-full opacity-70" style={{ background: preview.textBar }} />
            <span className="h-1 w-4 rounded-full opacity-70" style={{ background: preview.textBar }} />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1.5 px-0.5">
        <span
          className={`w-3 h-3 rounded-full border shrink-0 flex items-center justify-center ${
            selected ? 'border-[#ff6c37]' : 'border-pm-border'
          }`}
        >
          {selected && <span className="w-1.5 h-1.5 rounded-full bg-[#ff6c37]" />}
        </span>
        <span className={`text-[11.5px] ${disabled ? 'text-pm-text-muted' : 'text-pm-text'}`}>
          {theme.name}
        </span>
      </div>
    </button>
  )
}
