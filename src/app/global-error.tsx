'use client' // Error boundaries must be Client Components

import { useEffect } from 'react'
import { logError } from '@/lib/errorLog'

// Só aparece se o PRÓPRIO layout raiz quebrar (providers, etc). Substitui o
// layout inteiro, então não dá pra contar com CSS/tema do app aqui — estilo
// inline mínimo. O erro é registrado e enviado automaticamente.
export default function GlobalError({
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
    <html lang="en">
      <body style={{ margin: 0, fontFamily: 'sans-serif', background: '#1e1e1e', color: '#d4d4d4' }}>
        <div style={{ padding: 24, maxWidth: 480 }}>
          <h2 style={{ fontSize: 14 }}>Something went wrong</h2>
          <p style={{ fontSize: 12, opacity: 0.7 }}>
            The error was logged and sent for analysis.
          </p>
          <pre style={{ fontSize: 11, color: '#e06c75', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {error.message || 'Unknown error'}
          </pre>
          <button
            type="button"
            onClick={() => unstable_retry()}
            style={{ fontSize: 12, padding: '4px 10px', cursor: 'pointer' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  )
}
