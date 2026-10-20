// ─────────────────────────────────────────────────────────────────────────
// localStorage sem derrubar o app.
//
// A cota do localStorage é do ORIGIN INTEIRO — ~5 MiB para tudo que o app
// guarda. Quem enche não é quem quebra: o histórico de respostas ocupava 2,2
// MB em 257 chaves e engolia a cota em silêncio (a gravação dele já tinha
// try/catch), e aí o próximo a escrever estourava. Na prática era o menor
// deles — o tamanho dos painéis, salvo a cada arrastada de divisória — que
// jogava um QuotaExceededError na cara do usuário e derrubava a tela.
//
// Daí as duas metades daqui:
//
//   • `safeSetItem`, porque preferência de UI que não salva é um detalhe, e
//     nunca motivo para a janela inteira cair;
//   • orçamento e varredura, porque silenciar o erro sem limitar o consumo
//     só troca uma falha visível por uma invisível.
// ─────────────────────────────────────────────────────────────────────────

/**
 * O que o navegador cobra pela entrada.
 *
 * Chromium mede em UTF-16, então cada caractere custa 2 bytes — e a chave
 * conta junto com o valor. Medir em bytes de UTF-8 subestimaria a conta e o
 * orçamento aqui estouraria antes do limite calculado.
 */
export function entryBytes(key: string, value: string): number {
  return (key.length + value.length) * 2;
}

/** Gravação que não derruba a tela. `false` = não coube ou não deu. */
export function safeSetItem(key: string, value: string): boolean {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    // Cota cheia, modo privativo, armazenamento bloqueado. Nenhum deles
    // justifica interromper o que o usuário está fazendo.
    return false;
  }
}

export function safeRemoveItem(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* idem */
  }
}

/** Chaves com um prefixo, com o tamanho que cada uma ocupa. */
export function measurePrefix(prefix: string): StoredItem[] {
  if (typeof window === 'undefined') return [];
  const out: StoredItem[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const value = window.localStorage.getItem(key) ?? '';
      out.push({ key, bytes: entryBytes(key, value), touchedAt: 0 });
    }
  } catch {
    return [];
  }
  return out;
}

export interface StoredItem {
  key: string;
  bytes: number;
  /** Quanto mais antigo, mais cedo sai. */
  touchedAt: number;
}

/**
 * Quais chaves remover para caber no orçamento. As mais antigas saem antes.
 *
 * Por CHAVE inteira, e não por entrada dentro dela: o que sobra precisa
 * continuar sendo um histórico legível de alguma request, e não o resto
 * arbitrário de várias.
 */
export function planEviction(items: StoredItem[], budget: number): string[] {
  let total = items.reduce((acc, item) => acc + item.bytes, 0);
  if (total <= budget) return [];

  // Mais antigo primeiro. Empate pelo maior, que libera mais por remoção.
  const order = [...items].sort(
    (a, b) => a.touchedAt - b.touchedAt || b.bytes - a.bytes
  );

  const drop: string[] = [];
  for (const item of order) {
    if (total <= budget) break;
    drop.push(item.key);
    total -= item.bytes;
  }
  return drop;
}

/**
 * Prefixos que nada mais lê.
 *
 * `devflow_runner_last*` ficou para trás quando o histórico de runs passou
 * para o arquivo próprio `runner-history.json` (ver runHistory.ts): 16
 * chaves e ~577 KB que nenhum código procura mais, ocupando cota de quem
 * precisa.
 *
 * `response-viewer:` é a passagem do corpo da resposta para a janela
 * destacada, que a apaga assim que lê. Sobra só quando a janela não chegou a
 * abrir — e na partida do app não existe passagem pendente, então o que
 * estiver aí é resto.
 */
export const DEAD_PREFIXES: readonly string[] = ['devflow_runner_last', 'response-viewer:'];

export interface SweepResult {
  removed: number;
  freedBytes: number;
}

/** Remove o que ficou para trás. Roda na partida, uma vez. */
export function sweepDeadKeys(prefixes: readonly string[] = DEAD_PREFIXES): SweepResult {
  if (typeof window === 'undefined') return { removed: 0, freedBytes: 0 };

  const doomed: StoredItem[] = [];
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !prefixes.some(p => key.startsWith(p))) continue;
      const value = window.localStorage.getItem(key) ?? '';
      doomed.push({ key, bytes: entryBytes(key, value), touchedAt: 0 });
    }
  } catch {
    return { removed: 0, freedBytes: 0 };
  }

  for (const item of doomed) safeRemoveItem(item.key);
  return {
    removed: doomed.length,
    freedBytes: doomed.reduce((acc, item) => acc + item.bytes, 0),
  };
}
