'use client'

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ShieldAlert, RefreshCw, ExternalLink } from 'lucide-react'
import { AppStatus, compareVersions, fetchAppStatus, reportUsage } from '@/lib/appStatus'

interface Props {
  children: React.ReactNode
}

// Checa a cada 20min + na volta de foco da janela — suficiente pra um aviso
// de update ou um bloqueio remoto se propagarem rápido sem ficar batendo no
// endpoint toda hora.
const POLL_INTERVAL_MS = 20 * 60 * 1000
const DISMISSED_VERSION_KEY = 'app_update_dismissed_version'

export function AppUpdateGate({ children }: Props) {
  const [blocked, setBlocked] = useState<{ message?: string; updateUrl?: string } | null>(null)
  const [checking, setChecking] = useState(false)
  const currentVersionRef = useRef<string | null>(null)
  const currentUserRef = useRef<string | null>(null)
  const lastToastVersionRef = useRef<string | null>(null)
  const hasReportedUsageRef = useRef(false)

  const runCheck = async () => {
    setChecking(true)
    try {
      if (!currentVersionRef.current) {
        const { getVersion } = await import('@tauri-apps/api/app')
        currentVersionRef.current = await getVersion()
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

      const status = await fetchAppStatus()
      if (!status || !current) {
        setChecking(false)
        return
      }

      applyStatus(status, current, currentUser)
    } finally {
      setChecking(false)
    }
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
      return
    }

    setBlocked(null)

    // Aviso de update disponível (não bloqueante) — só reaparece quando uma
    // versão MAIS NOVA que a última dispensada é anunciada, não toda hora.
    if (status.latestVersion && compareVersions(status.latestVersion, current) > 0) {
      const dismissed = localStorage.getItem(DISMISSED_VERSION_KEY)
      if (dismissed === status.latestVersion || lastToastVersionRef.current === status.latestVersion) return

      lastToastVersionRef.current = status.latestVersion
      toast(`Update available — v${status.latestVersion}`, {
        description: status.updateMessage || 'A new version of the app is available.',
        duration: Infinity,
        action: status.updateUrl
          ? {
              label: 'Download',
              onClick: async () => {
                const { openUrl } = await import('@tauri-apps/plugin-opener')
                openUrl(status.updateUrl!).catch(() => {})
              },
            }
          : undefined,
        onDismiss: () => {
          localStorage.setItem(DISMISSED_VERSION_KEY, status.latestVersion!)
        },
      })
    }
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

  return (
    <>
      {children}
      {blocked && (
        <div className="fixed inset-0 z-[999999] flex items-center justify-center bg-black/90 backdrop-blur-sm">
          <div className="max-w-md w-[90%] rounded-2xl border border-pm-border bg-pm-surface p-6 flex flex-col items-center gap-3 text-center shadow-2xl">
            <ShieldAlert size={28} className="text-amber-400" />
            <h2 className="text-sm font-semibold text-pm-text">App unavailable</h2>
            <p className="text-[12.5px] text-pm-text-muted leading-relaxed">{blocked.message}</p>
            <div className="flex items-center gap-2 mt-2">
              {blocked.updateUrl && (
                <button
                  onClick={async () => {
                    const { openUrl } = await import('@tauri-apps/plugin-opener')
                    openUrl(blocked.updateUrl!).catch(() => {})
                  }}
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
                <RefreshCw size={13} className={checking ? 'animate-spin' : ''} /> Check again
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
