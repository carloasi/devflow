'use client'

import { LANGUAGES, setLanguage, useLanguage, type Language } from '@/lib/i18n/language'

// A tradução está chegando tela por tela; por enquanto só a revisão de
// mudanças do GitHub segue o idioma. O aviso diz isso pra ninguém achar que
// a troca "não funcionou" no resto do app.
export function LanguageSettingsSection() {
  const language = useLanguage()

  return (
    <div>
      <h3 className="text-sm font-semibold text-pm-text mb-2">Language</h3>

      <div className="flex items-center justify-between py-3">
        <div className="flex-1 pr-4">
          <p className="text-sm font-medium text-pm-text">Interface language</p>
          <p className="text-xs text-pm-text-muted mt-0.5">
            Applies right away. Translated so far: the GitHub review screen (pull, push and restore).
          </p>
        </div>

        <select
          value={language}
          onChange={e => setLanguage(e.target.value as Language)}
          className="h-7 shrink-0 rounded-md border border-pm-border bg-pm-bg px-2 text-xs text-pm-text outline-none cursor-pointer focus:border-[#007acc]/60"
        >
          {LANGUAGES.map(l => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  )
}
