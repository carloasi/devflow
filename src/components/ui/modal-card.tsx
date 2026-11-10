'use client'

import { useEffect } from "react"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

// ─────────────────────────────────────────────────────────────────────────
// Cartão de confirmação/aviso pontual (não um Dialog do Radix) — pensado
// pra "fechar sem salvar?", "apagar workspace do GitHub?" e afins: um
// overlay full-screen por fora, e dentro só este cartão.
//
// Existia repetido, idêntico, em meia dúzia de lugares (AppLayout,
// GitHubStorageClient) — cada aviso novo nascia copiando um desses e, se
// quem copiou pegou uma versão de antes do ajuste de borda/arredondamento,
// o problema (ring-foreground/ring-white quase branco, rounded-xl/2xl
// grande demais) voltava. Centralizar aqui é o que garante que um aviso
// NOVO sai certo sem precisar lembrar a regra — ela mora só neste arquivo.
//
// Sem ring nenhum de propósito (border-pm-border já contorna certo) e
// rounded-lg, não -xl/-2xl — mesmo padrão aplicado nos Dialog/AlertDialog
// do Radix (ver src/components/ui/dialog.tsx e alert-dialog.tsx).
//
// `onClose`: X no canto e Esc. É a saída que não faz nada (o "Cancelar" /
// "Manter" do aviso) — sem ela, o único jeito de sair de um aviso era
// escolher uma das ações, mesmo quando a pessoa só queria pensar antes.
// ─────────────────────────────────────────────────────────────────────────

export function ModalCard({
  className,
  children,
  onClose,
  closeLabel = "Close",
}: {
  className?: string
  children: React.ReactNode
  onClose?: () => void
  closeLabel?: string
}) {
  useEffect(() => {
    if (!onClose) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [onClose])

  return (
    <div
      className={cn(
        "relative bg-pm-surface border border-pm-border rounded-lg shadow-2xl overflow-hidden font-sans",
        className
      )}
    >
      {onClose && (
        <button
          type="button"
          onClick={onClose}
          aria-label={closeLabel}
          title={`${closeLabel} (Esc)`}
          className="absolute top-2 right-2 z-10 h-6 w-6 flex items-center justify-center rounded-md text-pm-text-muted hover:text-pm-text hover:bg-pm-hover transition-colors cursor-pointer"
        >
          <X size={14} />
        </button>
      )}
      {children}
    </div>
  )
}
