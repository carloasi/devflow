import type { RunEntry } from './runCollectionRequest';

// ─────────────────────────────────────────────────────────────────────────
// Decide se uma linha do Runner conta como falha, e monta o texto do motivo.
//
// A regra tem uma sutileza que vale explicar: **status HTTP de erro nem
// sempre é falha**. Um fluxo de teste negativo — "pagamento sem CPF tem que
// ser bloqueado" — espera 400. Tratar todo 4xx/5xx como falha deixava esse
// caso permanentemente vermelho, e um relatório que sempre acusa erro não
// informa mais nada.
//
// Quem decide, então, é a asserção. Quando a request tem pm.test(...), ela
// declarou o que se esperava, e o veredito é o das asserções. Sem nenhuma
// asserção não há declaração nenhuma, e aí 4xx/5xx volta a ser falha — senão
// um 500 de verdade passaria batido em silêncio.
//
// É a mesma semântica do Newman: o resultado vem das asserções, não do
// código de status.
// ─────────────────────────────────────────────────────────────────────────

export function hasFailureReason(entry: RunEntry): boolean {
  const o = entry.outcome;
  if (!o) return false;

  // Nem chegou a responder, ou o script quebrou: não há asserção que torne
  // isso intencional.
  if (o.status === 'error' || o.scriptError) return true;

  // Tem asserção: ela manda, inclusive pra transformar um 400 em sucesso.
  if (o.tests.length > 0) return o.tests.some(t => !t.passed);

  return o.httpStatus !== undefined && o.httpStatus >= 400;
}

/**
 * Texto completo (multi-linha) do motivo da falha.
 *
 * `includeBody` existe porque os dois usos querem coisas diferentes: o
 * relatório copiado e o JUnit precisam ser autossuficientes (quem lê não tem
 * a tela à mão), enquanto na linha expandida o corpo já aparece na seção
 * Response logo abaixo — repeti-lo empurraria o motivo pra fora da vista.
 */
export function failureReason(entry: RunEntry, includeBody = true): string {
  const o = entry.outcome;
  if (!o) return '';
  const lines: string[] = [];

  const failedTests = o.tests.filter(t => !t.passed);

  if (o.status === 'error' && o.errorMessage) {
    lines.push(`Request failed: ${o.errorMessage}`);
  } else if (o.httpStatus !== undefined && o.httpStatus >= 400) {
    lines.push(`HTTP ${o.httpStatus}`);
    if (includeBody && o.responseBodySnippet?.trim()) {
      lines.push(o.responseBodySnippet.trim());
    }
  }

  // Sem isto, uma request que respondeu 200 e quebrou só numa asserção
  // produzia um motivo com a URL e mais nada — inútil no relatório copiado e
  // no JUnit, onde a lista de testes da tela não existe.
  if (failedTests.length > 0) {
    if (lines.length > 0) lines.push('');
    for (const t of failedTests) {
      lines.push(`✗ ${t.name}${t.message ? `: ${t.message}` : ''}`);
    }
  }

  if (o.scriptError) {
    if (lines.length > 0) lines.push('');
    lines.push(o.scriptError);
  }

  if (o.resolvedUrl) {
    lines.push('');
    lines.push(`URL: ${o.resolvedUrl}`);
  }

  return lines.join('\n');
}

/**
 * Status de erro que as asserções declararam esperado. A linha usa isto pra
 * mostrar "400 esperado" em vez de pintar de vermelho — sem isso um fluxo
 * negativo que passou fica visualmente idêntico a um que não rodou direito.
 */
export function isExpectedErrorStatus(entry: RunEntry): boolean {
  const o = entry.outcome;
  if (!o || o.scriptError || o.status === 'error') return false;
  if (o.tests.length === 0) return false;
  if (o.tests.some(t => !t.passed)) return false;
  return o.httpStatus !== undefined && o.httpStatus >= 400;
}
