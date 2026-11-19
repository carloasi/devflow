'use client'

// ─────────────────────────────────────────────────────────────────────────
// Carregando, com o ícone do DevFlow (src-tauri/icons/icon.ico, copiado pra
// public/devflow-icon.png): o ícone "respira" — cresce e brilha devagar — e,
// no carregamento grande, um anel azul gira em volta dele. As animações
// ficam em globals.css (devflow-breathe, devflow-ring, devflow-progress) e
// param com "reduzir movimento".
// ─────────────────────────────────────────────────────────────────────────

const ICON_SRC = '/devflow-icon.png'

/** O ícone do DevFlow; `animated` = respirando (algo está carregando). */
export function DevFlowMark({ size = 48, animated = true }: { size?: number; animated?: boolean }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- ícone local pequeno, export estático
    <img
      src={ICON_SRC}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none ${animated ? 'devflow-breathe' : ''}`}
      style={{ width: size, height: size }}
    />
  )
}

/** Carregando no meio do espaço: o ícone com o anel girando, o que está acontecendo e um detalhe. */
export function DevFlowLoader({ label, detail, size = 64 }: { label: string; detail?: string; size?: number }) {
  const ring = size + 28
  return (
    <div role="status" aria-live="polite" className="h-full min-h-[220px] flex flex-col items-center justify-center gap-3 text-center">
      <div className="relative flex items-center justify-center" style={{ width: ring, height: ring }}>
        {/* Anel: um arco azul girando em volta do ícone. */}
        <span
          aria-hidden="true"
          className="devflow-ring absolute inset-0 rounded-full border-[3px] border-[#1e6bff]/15 border-t-[#4fc3ff] border-r-[#1e6bff]"
        />
        <DevFlowMark size={size} />
      </div>
      <p className="text-[13px] font-semibold text-pm-text">{label}</p>
      {detail && <p className="max-w-[46ch] text-[11px] text-pm-text-muted">{detail}</p>}
    </div>
  )
}

/**
 * Carregando em tamanho de botão ou de linha: só o anel fino girando.
 *
 * Sem o ícone do DevFlow no meio: em 12–16px ele não se lia como ícone, e
 * sim como uma bolinha azul pulsando ao lado dos botões — parecia a logo
 * fora do lugar. O ícone fica só no carregamento grande (DevFlowLoader), onde
 * tem tamanho pra ser reconhecido.
 */
export function DevFlowSpinner({ size = 16, className = '' }: { size?: number; className?: string }) {
  const border = size >= 28 ? 2.5 : size >= 18 ? 2 : 1.5
  return (
    <span
      role="status"
      aria-label="Loading"
      className={`devflow-ring inline-block shrink-0 rounded-full border-[#1e6bff]/20 border-t-[#4fc3ff] border-r-[#1e6bff] ${className}`}
      style={{ width: size, height: size, borderWidth: border, borderStyle: 'solid' }}
    />
  )
}

/**
 * Aviso flutuante de "trabalhando" (sincronizar, enviar, processar): um
 * cartão de vidro com o ícone num ladrilho iluminado, o que está
 * acontecendo e um detalhe, e a barra correndo na borda de baixo. Os "..."
 * do texto viram pontos animados.
 */
export function DevFlowBusyCard({ title, detail }: { title: string; detail?: string }) {
  const clean = title.replace(/\s*(\.\.\.|…)\s*$/, '')
  return (
    <div
      role="status"
      aria-live="polite"
      className="relative overflow-hidden min-w-[300px] max-w-[440px] rounded-2xl border border-white/[0.07] bg-pm-surface/85 px-4 py-3.5 backdrop-blur-xl shadow-[0_28px_70px_-18px_rgba(0,0,0,0.75),0_0_0_1px_rgba(79,195,255,0.06)] animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200"
    >
      {/* Brilho azul no canto: a cor do ícone, bem de leve. */}
      <span aria-hidden="true" className="pointer-events-none absolute -left-12 -top-14 h-36 w-36 rounded-full bg-[#1e6bff]/25 blur-3xl" />
      <div className="relative flex items-center gap-3.5">
        <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#1e6bff]/25 to-[#4fc3ff]/5 ring-1 ring-[#4fc3ff]/25 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
          <DevFlowSpinner size={32} />
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-pm-text">
            {clean}
            <span aria-hidden="true" className="devflow-dots" />
          </span>
          {detail && <span className="truncate text-[11.5px] text-pm-text-muted">{detail}</span>}
        </span>
      </div>
      {/* Barra correndo na borda de baixo. */}
      <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-[2px] overflow-hidden bg-white/[0.04]">
        <span className="devflow-progress absolute inset-y-0 w-1/3 bg-gradient-to-r from-transparent via-[#4fc3ff] to-transparent" />
      </span>
    </div>
  )
}

/** Tela inteira carregando (abrir o app, trocar de workspace): o loader no centro. */
export function DevFlowFullScreenLoader({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-pm-bg font-sans">
      <DevFlowLoader label={label} detail={detail} size={72} />
    </div>
  )
}

/** Barra fina e contínua: algo está carregando, sem esconder o que já está na tela. */
export function ProgressStrip({ active }: { active: boolean }) {
  return (
    <div className="relative h-0.5 shrink-0 overflow-hidden" aria-hidden="true">
      {active && <div className="devflow-progress absolute inset-y-0 w-1/3 bg-gradient-to-r from-[#1e6bff] to-[#4fc3ff]" />}
    </div>
  )
}
