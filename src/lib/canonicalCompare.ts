// ─────────────────────────────────────────────────────────────────────────
// Forma canônica de um pedaço de request, para comparar conteúdo em vez de
// representação.
//
// O diff comparava com JSON.stringify, que é sensível à ORDEM DAS CHAVES. O
// lado remoto é reconstruído pelo importData, que monta os objetos na ordem
// dele — então praticamente todo item divergia, sempre. Na prática a tela de
// comparação listava 313 alterações num workspace em que quase nada mudou,
// e o usuário teria de achar as poucas reais no meio delas.
//
// O que se iguala aqui é só o que não carrega informação:
//
//   • ordem das chaves de objeto;
//   • `id` de header, parâmetro e campo de auth — gerado no import, nunca
//     digitado por ninguém;
//   • ausente ≡ vazio: `oauth2: []`, `undefined`, `null`, `{}`;
//   • `enabled` ausente ≡ `true`, que é como o app lê (ver defaultHeaders:
//     o filtro é `enabled !== false`);
//   • CRLF ≡ LF, diferença que vem do arquivo e não do conteúdo.
//
// O que NÃO se iguala, de propósito: espaço no começo ou fim de um valor (uma
// URL com espaço sobrando é defeito de verdade, e esconder isso aqui faria o
// diff mentir), ordem dos itens de um array e maiúsculas.
// ─────────────────────────────────────────────────────────────────────────

/** Marca um valor que deve sumir do objeto canônico. */
const ABSENT = Symbol('absent');

const DROPPED_KEYS: ReadonlySet<string> = new Set(['id']);

function isEmptyish(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'object') return Object.keys(value as object).length === 0;
  return false;
}

export function canonical(value: unknown): unknown {
  if (typeof value === 'string') {
    // Só a quebra de linha: aparar as pontas esconderia defeito real.
    return value.replace(/\r\n/g, '\n');
  }

  if (Array.isArray(value)) {
    // Ordem preservada: reordenar headers é uma edição de verdade, e igualá-la
    // faria o diff deixar passar uma mudança que o usuário fez.
    return value.map(canonical);
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (DROPPED_KEYS.has(key)) continue;

      const raw = (value as Record<string, unknown>)[key];
      // `enabled: true` é o padrão; mantê-lo faria `{key,value}` divergir de
      // `{key,value,enabled:true}`, que o app trata como a mesma coisa.
      if (key === 'enabled' && raw === true) continue;
      if (isEmptyish(raw)) continue;

      const next = canonical(raw);
      if (next === ABSENT || isEmptyish(next)) continue;
      out[key] = next;
    }
    return out;
  }

  return value;
}

/** Os dois lados dizem a mesma coisa, ignorando só a representação. */
export function sameContent(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/** Texto canônico de um valor — para impressão/fingerprint. */
export function canonicalString(value: unknown): string {
  return JSON.stringify(canonical(value));
}
