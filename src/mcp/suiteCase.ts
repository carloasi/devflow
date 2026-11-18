// ─────────────────────────────────────────────────────────────────────────
// Casos de suíte de teste montados AQUI, a partir do body base.
//
// Numa suíte, cada caso é o mesmo body com UM campo diferente e um retorno
// esperado. Antes o agente redigitava o body inteiro e o bloco de pm.test em
// cada caso — 30 casos = 30 bodies quase iguais, a parte mais lenta pra um
// modelo menor. Agora o passo diz só o que muda (`bodyPatch`/`bodyRemove`) e o
// que espera (`expect`); o app aplica no body copiado e gera as asserções no
// formato do modes/suite.md da skill.
// ─────────────────────────────────────────────────────────────────────────

type JsonValue = unknown;

// `{{var}}` fora de string (ex. "count": {{pax}}) não é JSON: troca por um
// marcador entre aspas antes do parse e devolve depois.
const VAR = /\{\{\s*[^{}]+?\s*\}\}/g;

function protectBareVariables(body: string): { text: string; restore: (json: string) => string } {
  const saved: string[] = [];
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    // Número com mais de 15 dígitos não cabe num double: JSON.parse
    // arredondava (12345678901234567890 → 12345678901234567000). Vai como texto
    // e volta igual.
    if (/[-\d]/.test(ch)) {
      const number = body.slice(i).match(/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (number && number[0].replace(/[-.eE+]/g, '').length > 15) {
        saved.push(number[0]);
        out += `"__DEVFLOW_VAR_${saved.length - 1}__"`;
        i += number[0].length - 1;
        continue;
      }
    }
    if (ch === '{' && body[i + 1] === '{') {
      VAR.lastIndex = i;
      const match = VAR.exec(body);
      if (match && match.index === i) {
        saved.push(match[0]);
        out += `"__DEVFLOW_VAR_${saved.length - 1}__"`;
        i += match[0].length - 1;
        continue;
      }
    }
    out += ch;
  }
  return {
    text: out,
    restore: json => json.replace(/"__DEVFLOW_VAR_(\d+)__"/g, (_, n: string) => saved[Number(n)]),
  };
}

/** "contact.phones[0].number" → ["contact", "phones", 0, "number"]. */
export function parsePath(path: string): (string | number)[] {
  const parts: (string | number)[] = [];
  for (const segment of path.split('.')) {
    const match = segment.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!match) throw new Error(`Invalid path "${path}".`);
    if (match[1]) parts.push(match[1]);
    for (const index of match[2].matchAll(/\[(\d+)\]/g)) parts.push(Number(index[1]));
  }
  if (parts.length === 0) throw new Error(`Invalid path "${path}".`);
  return parts;
}

function setPath(root: JsonValue, path: string, value: JsonValue) {
  const parts = parsePath(path);
  let node = root as Record<string | number, JsonValue>;
  parts.slice(0, -1).forEach((part, i) => {
    if (node[part] === undefined || node[part] === null || typeof node[part] !== 'object') {
      // Cria o caminho que falta (objeto, ou lista quando o próximo é índice).
      node[part] = typeof parts[i + 1] === 'number' ? [] : {};
    }
    node = node[part] as Record<string | number, JsonValue>;
  });
  node[parts[parts.length - 1]] = value;
}

function removePath(root: JsonValue, path: string): boolean {
  const parts = parsePath(path);
  let node = root as Record<string | number, JsonValue> | undefined;
  for (const part of parts.slice(0, -1)) {
    node = node?.[part] as Record<string | number, JsonValue> | undefined;
    if (!node || typeof node !== 'object') return false;
  }
  const last = parts[parts.length - 1];
  if (!node || !(last in node)) return false;
  if (Array.isArray(node) && typeof last === 'number') node.splice(last, 1);
  else delete node[last];
  return true;
}

/**
 * O body base com os campos do caso trocados. `set` vale literal (null =
 * `null` JSON, "campo ausente" = `remove`). Caminho de `remove` que não existe
 * é erro: o caso não estaria testando o que diz.
 */
export function applyBodyPatch(body: string, set: Record<string, JsonValue> = {}, remove: string[] = []): string {
  if (!body.trim()) throw new Error('bodyPatch needs a JSON body to patch, and the source body is empty.');
  const { text, restore } = protectBareVariables(body);
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('bodyPatch needs a JSON body, and this one is not valid JSON (comments?). Send the whole "body" instead.');
  }
  for (const [path, value] of Object.entries(set)) setPath(parsed, path, value);
  for (const path of remove) {
    if (!removePath(parsed, path)) throw new Error(`bodyRemove: "${path}" is not in the body.`);
  }
  return restore(JSON.stringify(parsed, null, 2));
}

export interface CaseExpectation {
  status?: number;
  /** Códigos que têm de estar na lista de notificações. */
  codes?: string[];
  /** Onde fica a lista de notificações na resposta. Padrão "notifications". */
  notificationsPath?: string;
  /** Campos da resposta com valor exato, ex. {"data.status": "Confirmed"}. */
  fields?: Record<string, JsonValue>;
}

/** "C-11 - Hífen" → "C-11"; sem prefixo, o nome inteiro. */
export function caseIdOf(name: string): string {
  const bare = name.replace(/^\d+\s*-\s*/, '');
  // C-11, A-01b, C-1.1, CT_01, TC001…
  const match = bare.match(/^([A-Za-z]{1,4}[-_]?\d+(?:[._-]\d+)*[a-z]?)(?=\s|$|:)/);
  return match ? match[1] : bare.trim();
}

/** As asserções do caso, no formato do modes/suite.md (igualdade exata, sem to.include sobre texto cru). */
export function buildExpectScript(caseId: string, expect: CaseExpectation): string {
  const id = JSON.stringify(caseId).slice(1, -1);
  const lines: string[] = ['// Asserções do caso (geradas pelo DevFlow a partir de "expect").'];
  const needsJson = (expect.codes?.length ?? 0) > 0 || Object.keys(expect.fields ?? {}).length > 0;
  if (needsJson) {
    lines.push('var __body = (function () { try { return pm.response.json(); } catch (e) { return {}; } })();');
    lines.push('function __get(obj, path) {');
    lines.push('  return path.replace(/\\[(\\d+)\\]/g, ".$1").split(".").reduce(function (acc, key) { return acc == null ? undefined : acc[key]; }, obj);');
    lines.push('}');
  }
  if (expect.status !== undefined) {
    const status = Number(expect.status);
    if (!Number.isInteger(status)) throw new Error(`expect.status must be a number, got "${expect.status}".`);
    lines.push(`pm.test("${id}: status ${status}", function () { pm.expect(pm.response.code).to.equal(${status}); });`);
  }
  if (expect.codes?.length) {
    const path = JSON.stringify(expect.notificationsPath ?? 'notifications');
    lines.push(`var __codes = (__get(__body, ${path}) || []).map(function (x) { return x && x.code; });`);
    for (const code of expect.codes) {
      const c = JSON.stringify(String(code));
      lines.push(`pm.test("${id}: code ${JSON.stringify(String(code)).slice(1, -1)}", function () { pm.expect(__codes).to.include(${c}); });`);
    }
  }
  for (const [path, value] of Object.entries(expect.fields ?? {})) {
    const p = JSON.stringify(path);
    lines.push(
      `pm.test("${id}: ${JSON.stringify(path).slice(1, -1)} = ${JSON.stringify(JSON.stringify(value)).slice(1, -1)}", function () { pm.expect(__get(__body, ${p})).to.eql(${JSON.stringify(value)}); });`
    );
  }
  if (lines.length === 1) throw new Error('expect needs at least one of: status, codes, fields.');
  return lines.join('\n');
}
