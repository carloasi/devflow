'use client' // Error boundaries must be Client Components

import { useEffect } from 'react'
import { RotateCcw } from 'lucide-react'
import { logError } from '@/lib/errorLog'
import { ErrorReportForm } from '@/components/ErrorReportForm'

// Tela de fallback quando algum componente quebra no render. O erro já é
// registrado e enviado automaticamente (logError com autoReport); o form
// abaixo permite o usuário mandar um report com a descrição do que fazia.
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string }
  unstable_retry: () => void
}) {
  useEffect(() => {
    logError('react', error, { autoReport: true })
  }, [error])

  return (
    <div className="flex h-full w-full items-center justify-center bg-pm-bg p-6">
      <div className="w-full max-w-md rounded-xl border border-pm-border bg-pm-surface p-5 shadow-2xl">
        <h2 className="text-sm font-semibold text-pm-text">Something went wrong</h2>
        <p className="mt-1 text-xs text-pm-text-muted">
          The error was logged and sent for analysis. You can try again, or send a report
          describing what you were doing.
        </p>
        <pre className="mt-3 max-h-24 overflow-auto rounded-md border border-pm-border bg-pm-hover p-2 font-mono text-[11px] text-red-400 whitespace-pre-wrap break-all">
          {error.message || 'Unknown error'}
        </pre>

        <div className="mt-4">
          <ErrorReportForm />
        </div>

        <button
          type="button"
          onClick={() => unstable_retry()}
          className="mt-3 flex items-center gap-1.5 h-7 px-2.5 rounded-md text-xs font-medium text-pm-text-secondary border border-pm-border hover:bg-pm-hover transition-colors cursor-pointer"
        >
          <RotateCcw size={12} /> Try again
        </button>
      </div>
    </div>
  )
}
