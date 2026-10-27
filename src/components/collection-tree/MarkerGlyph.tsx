// Etiqueta preenchida com a cor do marcador.
//
// Não é o `Tag` do lucide: aquele é um contorno, e aqui o glifo TEM que
// carregar a cor — é ela que identifica o marcador na linha da árvore, onde
// não cabe o nome.
//
// Um path só, com `fillRule="evenodd"`: o furo da etiqueta é um subpath do
// mesmo path, e é isso que o abre de verdade. Dois paths separados não
// furam nada — o círculo sairia pintado por cima, virando uma bolha.
// O furo fechado é o sinal de "tem nota". Tentei antes um pontinho no canto,
// mas a 11px ele encosta na etiqueta vizinha e vira sujeira; fechar o furo
// muda a silhueta inteira sem ocupar um pixel a mais.
export function MarkerGlyph({
  color,
  size = 11,
  solid = false,
  className,
}: {
  color: string
  size?: number
  solid?: boolean
  className?: string
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <path
        fill={color}
        fillRule="evenodd"
        d={
          'M11.172 2a2 2 0 0 1 1.414.586l9.71 9.71a2.426 2.426 0 0 1 0 3.42l-6.58 6.58a2.426 2.426 0 0 1-3.42 0l-8.71-8.71A2 2 0 0 1 2 11.172V4a2 2 0 0 1 2-2z' +
          // Furo generoso de propósito: a 11px um furo "realista" some, e
          // com ele some a diferença entre ter e não ter nota.
          (solid ? '' : 'M7.25 4.75a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z')
        }
      />
    </svg>
  )
}
