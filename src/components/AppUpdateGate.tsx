'use client'

import { DevFlowSpinner } from '@/components/helper/DevFlowLoader';
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ShieldAlert, RefreshCw, ExternalLink, Download } from 'lucide-react'
import { AppStatus, compareVersions, fetchAppStatus, reportUsage } from '@/lib/appStatus'
import { safeSetItem } from '@/lib/safeStorage';
import {
  OPTIONAL_SNOOZE_MS,
  UpdateDecision,
  decideUpdate,
  releasesWithLegacyFallback,
  shouldShowOptionalNotice,
} from '@/lib/updateDecision'
import { getLanguage, useLanguage, type Language } from '@/lib/i18n/language'

interface Props {
  children: React.ReactNode
}

// Checa a cada 20min + na volta de foco da janela — suficiente pra um aviso
// de update ou um bloqueio remoto se propagarem rápido sem ficar batendo no
// endpoint toda hora.
const POLL_INTERVAL_MS = 20 * 60 * 1000
const DISMISSED_VERSION_KEY = 'app_update_dismissed_version'
const SNOOZED_UNTIL_KEY = 'app_update_snoozed_until'
const OPTIONAL_TOAST_ID = 'app-update-optional'

type MandatoryUpdate = Extract<UpdateDecision, { kind: 'mandatory' }>

const STRINGS = {
  en: {
    optionalTitle: (v: string) => `Update available — v${v}`,
    optionalDefault: 'A new version of the app is available.',
    update: 'Update',
    later: 'Later',
    mandatoryTitle: 'Update required',
    mandatoryBody: (current: string, latest: string) =>
      `You are on v${current}. Update to v${latest} to keep using the app.`,
    requiredTag: 'required',
    noUrl: 'Ask the administrator for the installer link.',
  },
  'pt-BR': {
    optionalTitle: (v: string) => `Atualização disponível — v${v}`,
    optionalDefault: 'Uma nova versão do app está disponível.',
    update: 'Atualizar',
    later: 'Mais tarde',
    mandatoryTitle: 'Atualização obrigatória',
    mandatoryBody: (current: string, latest: string) =>
      `Você está na v${current}. Atualize para a v${latest} para continuar usando o app.`,
    requiredTag: 'obrigatória',
    noUrl: 'Peça ao administrador o link do instalador.',
  },
} satisfies Record<Language, unknown>

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

async function openExternal(url: string) {
  try {
    const { openUrl } = await import('@tauri-apps/plugin-opener')
    await openUrl(url)
  } catch {
    // Sem opener (fora do Tauri) ou URL inválida — nada a fazer.
  }
}

export function AppUpdateGate({ children }: Props) {
  const [blocked, setBlocked] = useState<{ message?: string; updateUrl?: string } | null>(null)
  const [mandatory, setMandatory] = useState<MandatoryUpdate | null>(null)
  const [currentVersion, setCurrentVersion] = useState<string | null>(null)
  const [checking, setChecking] = useState(false)
  const currentVersionRef = useRef<string | null>(null)
  const currentUserRef = useRef<string | null>(null)
  const lastToastVersionRef = useRef<string | null>(null)
  const hasReportedUsageRef = useRef(false)
  // toast.dismiss() programático também dispara o onDismiss do sonner — sem
  // esta trava, esconder o aviso opcional porque virou obrigatório gravaria
  // a versão como "dispensada pela pessoa".
  const toastOpenRef = useRef(false)
  const closingByAppRef = useRef(false)
  const overlayRef = useRef<HTMLDivElement>(null)
  const language = useLanguage()
  const t = STRINGS[language]

  const runCheck = async () => {
    setChecking(true)
    try {
      if (!currentVersionRef.current) {
        const { getVersion } = await import('@tauri-apps/api/app')
        currentVersionRef.current = await getVersion()
        setCurrentVersion(currentVersionRef.current)
      }
      if (!currentUserRef.current) {
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          currentUserRef.current = await invoke<string>('get_windows_username')
        } catch {
          // Sem permissão/fora do Tauri — segue sem identificar usuário,
          // só o bloqueio por usuário fica inativo (fail-open).
          currentUserRef.current = ''
        }
      }
      const current = currentVersionRef.current
      const currentUser = currentUserRef.current || ''

      // "Quem está usando o app" — check-in único por sessão (não a cada
      // checagem periódica de 20min), disparado aqui porque é o mesmo lugar
      // que já resolveu version+username pra primeira vez. Fire-and-forget,
      // não bloqueia nem afeta o resultado da checagem de bloqueio/update.
      if (!hasReportedUsageRef.current && current && currentUser) {
        hasReportedUsageRef.current = true
        reportUsage(currentUser, current)
      }

      // Offline, timeout, planilha com erro: fetchAppStatus devolve null e o
      // estado anterior é mantido — nunca bloqueia por falha da checagem.
      const status = await fetchAppStatus()
      if (!status || !current) return

      applyStatus(status, current, currentUser)
    } catch {
      // getVersion falhou (ex: fora do Tauri) — fail-open.
    } finally {
      setChecking(false)
    }
  }

  const dismissOptionalToast = () => {
    lastToastVersionRef.current = null
    if (!toastOpenRef.current) return
    // O onDismiss do sonner roda depois (num efeito); ele vê a trava, solta
    // e não grava nada.
    closingByAppRef.current = true
    toastOpenRef.current = false
    toast.dismiss(OPTIONAL_TOAST_ID)
  }

  const applyStatus = (status: AppStatus, current: string, currentUser: string) => {
    const isExplicitlyBlocked = status.blocked === true
    const isBelowMinVersion = !!status.minVersion && compareVersions(current, status.minVersion) < 0
    const isUserBlocked = !!currentUser && (status.blockedUsers || []).some(
      u => u.toLowerCase() === currentUser.toLowerCase()
    )
    const isVersionBlocked = (status.blockedVersions || []).some(
      v => compareVersions(v, current) === 0
    )

    if (isExplicitlyBlocked || isBelowMinVersion || isUserBlocked || isVersionBlocked) {
      const defaultMessage = isUserBlocked
        ? `Your account (${currentUser}) has been blocked from using this app. Contact the administrator for details.`
        : isVersionBlocked
          ? `This version (${current}) has been blocked. Please update to continue.`
          : isBelowMinVersion
            ? `This version (${current}) is no longer supported. Please update to continue.`
            : 'The app is temporarily unavailable. Please check back shortly.'

      setBlocked({
        message: status.blockMessage || defaultMessage,
        updateUrl: status.updateUrl,
      })
      setMandatory(null)
      dismissOptionalToast()
      return
    }

    setBlocked(null)

    const releases = releasesWithLegacyFallback(status.releases ?? [], status.latestVersion, status.updateMessage)
    const decision = decideUpdate(current, releases, status.updateUrl)

    if (decision.kind === 'mandatory') {
      // Obrigatória ignora "dispensar" e "lembrar depois".
      setMandatory(decision)
      dismissOptionalToast()
      return
    }

    // Se a planilha voltou a obrigatória pra "não", a tela some na próxima
    // checagem e cai no aviso opcional abaixo.
    setMandatory(null)

    if (decision.kind === 'none') {
      dismissOptionalToast()
      return
    }

    // Aviso opcional (não bloqueante). "X" = não avisar mais desta versão
    // (volta quando sair uma mais nova); "Mais tarde" = adia por 24h.
    const latest = decision.latest.version
    const snoozed = Number(readStorage(SNOOZED_UNTIL_KEY))
    const show = shouldShowOptionalNotice(
      latest,
      { dismissedVersion: readStorage(DISMISSED_VERSION_KEY), snoozedUntil: snoozed || null },
      Date.now(),
    )
    if (!show || lastToastVersionRef.current === latest) return

    lastToastVersionRef.current = latest
    toastOpenRef.current = true
    const s = STRINGS[getLanguage()]
    const url = decision.url
    toast(s.optionalTitle(latest), {
      id: OPTIONAL_TOAST_ID,
      description: decision.latest.notes || status.updateMessage || s.optionalDefault,
      duration: Infinity,
      // Botões de ação/cancelar fecham o toast sem chamar onDismiss.
      action: url
        ? {
            label: s.update,
            onClick: () => {
              toastOpenRef.current = false
              openExternal(url)
            },
          }
        : undefined,
      cancel: {
        label: s.later,
        onClick: () => {
          toastOpenRef.current = false
          safeSetItem(SNOOZED_UNTIL_KEY, String(Date.now() + OPTIONAL_SNOOZE_MS))
          // Libera pra aparecer de novo nesta mesma sessão depois do prazo.
          lastToastVersionRef.current = null
        },
      },
      onDismiss: () => {
        toastOpenRef.current = false
        if (closingByAppRef.current) {
          closingByAppRef.current = false
          return
        }
        safeSetItem(DISMISSED_VERSION_KEY, latest)
      },
    })
  }

  useEffect(() => {
    let cancelled = false
    let interval: ReturnType<typeof setInterval> | undefined
    let onVisibility: (() => void) | undefined

    // Janelas secundárias (ex: "Open response in new window") não têm a
    // permissão app:allow-version liberada na capability (só a janela
    // "main" tem) — e também não faz sentido cada popup rodar sua própria
    // checagem/overlay de bloqueio duplicada. Só a janela principal checa.
    ;(async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window')
        const label = getCurrentWindow().label
        if (cancelled || label !== 'main') return
      } catch {
        // Fora do Tauri (ex: next dev no navegador) — não faz nada, fail-open.
        return
      }

      runCheck()
      interval = setInterval(runCheck, POLL_INTERVAL_MS)
      onVisibility = () => {
        if (document.visibilityState === 'visible') runCheck()
      }
      document.addEventListener('visibilitychange', onVisibility)
    })()

    return () => {
      cancelled = true
      if (interval) clearInterval(interval)
      if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Com uma tela bloqueante aberta, o overlay já impede clique no app, mas o
  // foco pode ter ficado num editor por trás e os atalhos de teclado
  // (Ctrl+Enter, Ctrl+S...) continuariam agindo nele. Engole as teclas que
  // não nasceram dentro do overlay. Alt+F4 passa: fechar o app é permitido
  // (o instalador costuma pedir isso).
  const gateOpen = !!blocked || !!mandatory
  useEffect(() => {
    if (!gateOpen) return
    const focusTarget = overlayRef.current?.querySelector<HTMLElement>('button:not([disabled])')
    focusTarget?.focus()
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.altKey && e.key === 'F4') return
      if (overlayRef.current?.contains(e.target as Node)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [gateOpen])

  return (
    <>
      {children}
      {blocked ? (
        <div ref={overlayRef} className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/90 backdrop-blur-sm">
          <div className="max-w-md w-[90%] rounded-lg border border-pm-border bg-pm-surface p-6 flex flex-col items-center gap-3 text-center shadow-2xl">
            <ShieldAlert size={28} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-pm-text">App unavailable</h2>
            <p className="text-[12.5px] text-pm-text-muted leading-relaxed">{blocked.message}</p>
            <div className="flex items-center gap-2 mt-2">
              {blocked.updateUrl && (
                <button
                  onClick={() => openExternal(blocked.updateUrl!)}
                  className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-semibold text-white bg-[#097bed] hover:bg-[#097bed]/90 transition-colors cursor-pointer"
                >
                  <ExternalLink size={13} /> Open update page
                </button>
              )}
              <button
                onClick={runCheck}
                disabled={checking}
                className="flex items-center gap-1.5 h-8 px-3 rounded-md text-xs font-semibold text-pm-text-secondary border border-pm-border hover:bg-pm-hover transition-colors cursor-pointer disabled:opacity-50"
              >
                {checking ? <DevFlowSpinner size={14} /> : <RefreshCw size={13} />} Check again
              </button>
            </div>
          </div>
        </div>
      ) : mandatory && (
        // Tela de atualização obrigatória: sem fechar, sem "mais tarde", só
        // o botão Atualizar. Some sozinha se a planilha deixar de exigir
        // (próxima checagem) ou quando o app reabrir já na versão nova.
        <div
          ref={overlayRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="app-update-mandatory-title"
          className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/90 backdrop-blur-sm"
        >
          <div className="max-w-md w-[90%] rounded-lg border border-pm-border bg-pm-surface p-6 flex flex-col items-center gap-3 text-center shadow-2xl">
            <Download size={28} className="text-[#097bed]" />
            <h2 id="app-update-mandatory-title" className="text-sm font-semibold text-pm-text">
              {t.mandatoryTitle}
            </h2>
            <p className="text-[12.5px] text-pm-text-muted leading-relaxed">
              {t.mandatoryBody(currentVersion ?? '?', mandatory.latest.version)}
            </p>
            {mandatory.pending.some(r => r.notes) && (
              <ul className="w-full max-h-48 overflow-y-auto text-left flex flex-col gap-2 rounded-md border border-pm-border p-3">
                {mandatory.pending.map(r => (
                  <li key={r.version} className="text-[12px] leading-relaxed">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-pm-text">v{r.version}</span>
                      {r.mandatory && (
                        <span className="rounded px-1.5 text-[10.5px] font-semibold text-amber-400 border border-amber-400/40">
                          {t.requiredTag}
                        </span>
                      )}
                      {r.date && <span className="text-pm-text-muted">{r.date}</span>}
                    </div>
                    {r.notes && <p className="text-pm-text-muted whitespace-pre-line">{r.notes}</p>}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => mandatory.url && openExternal(mandatory.url)}
              disabled={!mandatory.url}
              className="mt-2 flex items-center gap-1.5 h-8 px-4 rounded-md text-xs font-semibold text-white bg-[#097bed] hover:bg-[#097bed]/90 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Download size={13} /> {t.update}
            </button>
            {!mandatory.url && <p className="text-[11.5px] text-pm-text-muted">{t.noUrl}</p>}
          </div>
        </div>
      )}
    </>
  )
}
