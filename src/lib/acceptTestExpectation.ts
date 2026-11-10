// ─────────────────────────────────────────────────────────────────────────
// "Accept as expected" no Collection Runner: um teste falhou porque a API
// respondeu algo diferente do que a asserção previa (ex: pm.expect(pm.
// response.code).to.equal(200), mas veio 400 — um 400 "de verdade", não um
// bug) — isto reescreve o script pra aceitar o valor que chegou, sem abrir o
// editor e caçar a linha manualmente.
//
// Escopo deliberadamente estreito: só mexe quando dá pra ter certeza de qual
// assert mudar. Qualquer ambiguidade (bloco não encontrado, string com sintaxe
// esquisita, valor repetido mais de uma vez no bloco) e a função devolve
// null — o chamador avisa que não deu pra fazer sozinho, em vez de editar o
// script errado.
//
// Cobre .to.equal(...) e .to.deeply.equal(...)/.eql(...), que são o formato
// de mensagem "expected X to equal Y" / "expected X to deeply equal Y" (ver
// __makeAssertion em src-tauri/src/lib.rs). Não cobre pm.response.to.have.
// status(...): a mensagem dali ("expected response to have status...") não
// carrega os valores no mesmo formato JSON, e misturar os dois aqui pioraria
// a confiabilidade do caso comum.
// ─────────────────────────────────────────────────────────────────────────

const FAILURE_PATTERN = /^expected (.+) to (equal|deeply equal) (.+)$/;

function isJsonLiteral(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** Índice do ')' que fecha o '(' em `openIndex`, pulando strings/comentários. */
function matchingParenIndex(source: string, openIndex: number): number {
  let depth = 1;
  let i = openIndex + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    if (ch === '/' && source[i + 1] === '/') {
      i = source.indexOf('\n', i);
      if (i === -1) return -1;
      continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      i = source.indexOf('*/', i + 2);
      if (i === -1) return -1;
      i += 2;
      continue;
    }
    if (ch === '(') depth++;
    if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Lê uma string literal a partir do índice de abertura da aspa; devolve o valor já sem escape e o índice logo após a aspa de fechamento. */
function readStringLiteral(source: string, quoteIndex: number): { value: string; end: number } | null {
  const quote = source[quoteIndex];
  if (quote !== '"' && quote !== "'" && quote !== '`') return null;
  let i = quoteIndex + 1;
  let raw = '';
  while (i < source.length && source[i] !== quote) {
    if (source[i] === '\\' && i + 1 < source.length) {
      raw += source[i] + source[i + 1];
      i += 2;
      continue;
    }
    raw += source[i];
    i++;
  }
  if (i >= source.length) return null;
  try {
    // JSON só entende aspas duplas — normaliza antes de desescapar.
    const asDouble = quote === '"' ? raw : raw.replace(/\\'/g, "'").replace(/(?<!\\)"/g, '\\"');
    return { value: JSON.parse(`"${asDouble}"`), end: i + 1 };
  } catch {
    return { value: raw, end: i + 1 };
  }
}

/** Limites (índices em `script`) do pm.test(...) cujo nome bate com `testName`. */
function findPmTestBlock(script: string, testName: string): { start: number; end: number } | null {
  const callRegex = /pm\.test\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = callRegex.exec(script))) {
    const openParenIndex = match.index + match[0].length - 1;
    let i = openParenIndex + 1;
    while (i < script.length && /\s/.test(script[i])) i++;
    const literal = readStringLiteral(script, i);
    if (!literal) continue;
    if (literal.value !== testName) continue;

    const closeIndex = matchingParenIndex(script, openParenIndex);
    if (closeIndex === -1) return null;
    return { start: match.index, end: closeIndex + 1 };
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Devolve o script com a asserção da pm.test(testName, ...) atualizada pro
 * valor que a resposta realmente trouxe, ou `null` se não der pra fazer com
 * segurança (mensagem fora do formato esperado, bloco não encontrado, ou
 * valor esperado aparecendo mais de uma vez dentro do bloco).
 */
export function acceptTestExpectation(script: string, testName: string, failureMessage: string): string | null {
  const parsed = FAILURE_PATTERN.exec(failureMessage.trim());
  if (!parsed) return null;
  const [, actualLiteral, equalKind, expectedLiteral] = parsed;
  if (!isJsonLiteral(actualLiteral) || !isJsonLiteral(expectedLiteral)) return null;
  if (actualLiteral === expectedLiteral) return null;

  const block = findPmTestBlock(script, testName);
  if (!block) return null;

  const method = equalKind === 'equal' ? 'equal' : 'eql';
  const blockText = script.slice(block.start, block.end);
  const assertionPattern = new RegExp(`\\.${method}\\(\\s*${escapeRegExp(expectedLiteral)}\\s*\\)`, 'g');
  const occurrences = blockText.match(assertionPattern);
  if (!occurrences || occurrences.length !== 1) return null;

  const updatedBlock = blockText.replace(assertionPattern, `.${method}(${actualLiteral})`);

  // Convenção vista no nome do teste ("... (200)"): se o número esperado
  // ainda aparece entre parênteses (só pode ser no nome — a asserção já foi
  // trocada acima), atualiza junto, senão o nome mentiria sobre o que a
  // asserção passa a checar.
  const nameSuffixPattern = new RegExp(`\\(${escapeRegExp(expectedLiteral)}\\)`, 'g');
  const withUpdatedName = nameSuffixPattern.test(updatedBlock)
    ? updatedBlock.replace(nameSuffixPattern, `(${actualLiteral})`)
    : updatedBlock;

  return script.slice(0, block.start) + withUpdatedName + script.slice(block.end);
}
