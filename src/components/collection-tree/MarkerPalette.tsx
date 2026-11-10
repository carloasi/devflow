import { MARKER_COLORS } from '@/lib/markers'

// Paleta fechada (ver MARKER_COLORS): dez quadradinhos numa fila só. Um
// seletor de cor livre deixaria dois marcadores em tons indistinguíveis na
// árvore, que é justamente onde a cor precisa funcionar — e o que lê bem no
// tema escuro costuma sumir no claro.
//
// Fica num arquivo próprio porque TreeContextMenu (clique direito) e
// TreeActionMenu (o "…" de hover) precisam do MESMO seletor — os dois
// deixam marcar/criar/recolorir um marcador direto no menu da árvore.
export function MarkerPalette({
  selected,
  onPick,
}: {
  selected: string
  onPick: (color: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {MARKER_COLORS.map(color => (
        <button
          key={color}
          onClick={() => onPick(color)}
          className="size-4 rounded-[3px] transition-transform hover:scale-110"
          style={{
            backgroundColor: color,
            outline: color === selected ? '1.5px solid var(--color-pm-text)' : 'none',
            outlineOffset: 1,
          }}
        />
      ))}
    </div>
  )
}
