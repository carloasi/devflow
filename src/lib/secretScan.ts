import type { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Credenciais escritas direto nas requests, em vez de {{variavel}}.
//
// Num perfil real: 409 tokens JWT literais em 332 requests — e **361 deles já
// tinham expirado**, mediana de 328 dias, o mais antigo de 775. Nenhum ainda
// valia. Quem abre uma dessas e aperta Send leva 401 e vai investigar um
// token que morreu há um ano.
//
// Por isso isto classifica em vez de só apontar: token morto se apaga, token
// vivo se extrai para uma variável. Tratar os dois igual transformaria uma
// limpeza de cinco minutos numa revisão de 332 itens.
//
// A detecção segue a mesma regra do mcp/redactSecrets.ts — nome de campo que
// sugere credencial —, e referência a variável nunca conta: `{{token}}` é
// exatamente o que se quer ver no lugar.
// ─────────────────────────────────────────────────────────────────────────

/** Campos cujo NOME sugere credencial. Mesma regra da redação do MCP. */
const SECRET_KEY_REGEX = /auth|token|key|secret|password|senha|cookie|session/i;

const JWT_REGEX = /\beyJ[A-Za-z0-9_-]{8,}\.([A-Za-z0-9_-]{8,})\.[A-Za-z0-9_-]*/;

/**
 * Campos do OAuth2 que são de fato credencial.
 *
 * Lista fechada, e não a regra por nome: o conjunto de campos do OAuth2 é
 * fixo, e três dos que casam com `/token|auth/` não são segredo nenhum —
 * `tokenName` é rótulo, `authUrl` e `accessTokenUrl` são endereços. Numa base
 * real eram 249 achados falsos de 332, o bastante para a lista virar ruído.
 *
 * `clientId` fica de fora de propósito: identifica a aplicação, não autoriza.
 */
const OAUTH2_SECRET_FIELDS: ReadonlySet<string> = new Set([
  'clientSecret',
  'accessToken',
  'refreshToken',
  'password',
]);

export type SecretKind = 'jwt' | 'bearer' | 'basic' | 'apikey' | 'header' | 'oauth2';

export interface SecretFinding {
  requestId: string;
  requestName: string;
  /** Nomes dos ancestrais até a request, para localizar na árvore. */
  path: string[];
  kind: SecretKind;
  /** Onde o valor mora, para quem for aplicar a correção. */
  location:
    | { type: 'auth'; field: 'token' | 'password' | 'value' }
    | { type: 'oauth2'; key: string }
    | { type: 'header'; key: string };
  /** O valor mascarado — o original nunca sai daqui. */
  preview: string;
  /** Só para JWT: expirou? `null` quando não dá pra ler o `exp`. */
  expired: boolean | null;
  /** Há quantos dias expirou. */
  expiredDaysAgo?: number;
  /** Nome de variável sugerido, derivado do campo. */
  suggestedVariable: string;
}

export function isVarReference(value: string): boolean {
  return /^\s*\{\{[^{}]+\}\}\s*$/.test(value);
}

/** Comprimento abaixo do qual não vale chamar de credencial. */
const MIN_SECRET_LENGTH = 8;

/**
 * Vale investigar?
 *
 * Qualquer  no valor já basta para NÃO ser achado. A primeira
 * versão exigia que o valor inteiro fosse a referência, e  * — a forma correta de escrever o header — caía como segredo literal: 2.352
 * falsos positivos numa base real, o bastante para a lista virar ruído e
 * ninguém olhar. Se a pessoa parametrizou, ela já fez o certo.
 *
 * O piso de tamanho tira o resto do ruído: , ,  em campo
 * cujo nome por acaso casa com a regra.
 */
function isLiteral(value: string | undefined): value is string {
  if (!value) return false;
  const text = value.trim();
  return text.length >= MIN_SECRET_LENGTH && !text.includes('{{');
}

export function maskValue(value: string): string {
  const text = value.trim();
  if (text.length <= 12) return '•'.repeat(text.length);
  return `${text.slice(0, 6)}…${text.slice(-4)} (${text.length} chars)`;
}

/**
 * O JWT já expirou?
 *
 * Decodifica só o payload — nada de validar assinatura, que exigiria a chave
 * e não é a pergunta. `null` quando não há `exp` legível: dizer "não expirou"
 * nesse caso seria afirmar o que não se sabe.
 */
export function jwtExpiry(value: string): { expired: boolean; daysAgo: number } | null {
  const match = value.match(JWT_REGEX);
  if (!match) return null;

  try {
    const base64 = match[1].replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? atob(base64) : Buffer.from(base64, 'base64').toString('utf8');
    const payload = JSON.parse(json) as { exp?: number };
    if (typeof payload.exp !== 'number') return null;

    const secondsPast = Math.floor(Date.now() / 1000) - payload.exp;
    return { expired: secondsPast > 0, daysAgo: Math.max(0, Math.floor(secondsPast / 86400)) };
  } catch {
    return null;
  }
}

/** Nome de variável a partir do campo: `X-Api-Key` → `xApiKey`. */
export function suggestVariableName(label: string): string {
  const parts = label
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return 'secret';

  // Já em camelCase e sem separador (`clientSecret`): só a inicial desce.
  // Passar pelo caminho de baixo achataria tudo em `clientsecret`.
  if (parts.length === 1 && /[a-z][A-Z]/.test(parts[0])) {
    return parts[0].charAt(0).toLowerCase() + parts[0].slice(1);
  }

  return parts
    .map((part, i) =>
      i === 0
        ? part.toLowerCase()
        : part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
    )
    .join('');
}

function buildFinding(
  item: CollectionItem,
  path: string[],
  kind: SecretKind,
  location: SecretFinding['location'],
  value: string,
  label: string
): SecretFinding {
  const expiry = jwtExpiry(value);
  return {
    requestId: item.id,
    requestName: item.name,
    path,
    kind: expiry ? 'jwt' : kind,
    location,
    preview: maskValue(value),
    expired: expiry ? expiry.expired : null,
    ...(expiry?.expired ? { expiredDaysAgo: expiry.daysAgo } : {}),
    suggestedVariable: suggestVariableName(label),
  };
}

function scanRequest(item: CollectionItem, path: string[]): SecretFinding[] {
  const out: SecretFinding[] = [];
  const req = item.request;
  if (!req) return out;

  const auth = req.auth;
  if (auth) {
    if (auth.type === 'bearer' && isLiteral(auth.token)) {
      out.push(buildFinding(item, path, 'bearer', { type: 'auth', field: 'token' }, auth.token, 'token'));
    }
    if (auth.type === 'basic' && isLiteral(auth.password)) {
      out.push(buildFinding(item, path, 'basic', { type: 'auth', field: 'password' }, auth.password, 'password'));
    }
    if (auth.type === 'apikey' && isLiteral(auth.value)) {
      out.push(
        buildFinding(item, path, 'apikey', { type: 'auth', field: 'value' }, auth.value, auth.key || 'apiKey')
      );
    }
    for (const entry of auth.oauth2 ?? []) {
      if (OAUTH2_SECRET_FIELDS.has(entry.key) && isLiteral(entry.value)) {
        out.push(
          buildFinding(item, path, 'oauth2', { type: 'oauth2', key: entry.key }, entry.value, entry.key)
        );
      }
    }
  }

  for (const header of req.headers ?? []) {
    if (!SECRET_KEY_REGEX.test(header.key) || !isLiteral(header.value)) continue;
    out.push(buildFinding(item, path, 'header', { type: 'header', key: header.key }, header.value, header.key));
  }

  return out;
}

export function scanTree(roots: CollectionItem[] | undefined | null): SecretFinding[] {
  const out: SecretFinding[] = [];

  const walk = (items: CollectionItem[], path: string[]) => {
    for (const item of items) {
      const here = [...path, item.name];
      // Examples guardam um retrato da request que os gerou; o segredo lá é
      // cópia do que já foi apontado na request, e listar os dois dobraria a
      // lista sem acrescentar um lugar para corrigir.
      if (item.type !== 'example') out.push(...scanRequest(item, here));
      if (item.item?.length) walk(item.item, here);
    }
  };

  walk(roots ?? [], []);
  return out;
}

export interface ScanSummary {
  total: number;
  /** JWT com `exp` no passado: não funcionam mais, só confundem. */
  expired: number;
  /** Credencial que ainda pode valer — essas precisam virar variável. */
  live: number;
}

export function summarizeFindings(findings: SecretFinding[]): ScanSummary {
  const expired = findings.filter(f => f.expired === true).length;
  return { total: findings.length, expired, live: findings.length - expired };
}

// ─────────────────────────────────────────────────────────────────────────
// Aplicar a correção.
//
// O valor real é lido da ÁRVORE na hora de aplicar, nunca do achado — que só
// carrega a máscara. Assim o segredo não passa pelo relatório nem por nada
// que seja exibido, e extrair continua funcionando com o valor verdadeiro.
// ─────────────────────────────────────────────────────────────────────────

export type SecretAction =
  /** Vira {{variavel}}, e o valor original vai para o environment. */
  | { type: 'extract'; variable: string }
  /** Esvazia o campo. Para token expirado, que não serve mais para nada. */
  | { type: 'clear' };

export interface AppliedSecrets {
  roots: CollectionItem[];
  /** Variáveis a criar no environment, na ordem em que foram extraídas. */
  variables: { key: string; value: string }[];
}

function readAt(item: CollectionItem, location: SecretFinding['location']): string {
  const req = item.request;
  if (!req) return '';
  if (location.type === 'auth') return req.auth?.[location.field] ?? '';
  if (location.type === 'oauth2') {
    return req.auth?.oauth2?.find(e => e.key === location.key)?.value ?? '';
  }
  return req.headers?.find(h => h.key === location.key)?.value ?? '';
}

function writeAt(
  item: CollectionItem,
  location: SecretFinding['location'],
  next: string
): CollectionItem {
  const req = item.request;
  if (!req) return item;

  if (location.type === 'auth') {
    return { ...item, request: { ...req, auth: { ...req.auth!, [location.field]: next } } };
  }

  if (location.type === 'oauth2') {
    return {
      ...item,
      request: {
        ...req,
        auth: {
          ...req.auth!,
          oauth2: (req.auth?.oauth2 ?? []).map(e =>
            e.key === location.key ? { ...e, value: next } : e
          ),
        },
      },
    };
  }

  return {
    ...item,
    request: {
      ...req,
      headers: (req.headers ?? []).map(h => (h.key === location.key ? { ...h, value: next } : h)),
    },
  };
}

export function applySecretActions(
  roots: CollectionItem[],
  decisions: { finding: SecretFinding; action: SecretAction }[]
): AppliedSecrets {
  // Agrupa por request: uma request pode ter vários achados, e aplicar um de
  // cada vez sobre a árvore inteira reescreveria o nó N vezes.
  const byRequest = new Map<string, { finding: SecretFinding; action: SecretAction }[]>();
  for (const d of decisions) {
    const list = byRequest.get(d.finding.requestId);
    if (list) list.push(d);
    else byRequest.set(d.finding.requestId, [d]);
  }

  const variables: { key: string; value: string }[] = [];

  const walk = (items: CollectionItem[]): CollectionItem[] =>
    items.map(item => {
      const decisionsHere = byRequest.get(item.id);
      let next = item;

      for (const { finding, action } of decisionsHere ?? []) {
        if (action.type === 'extract') {
          const value = readAt(next, finding.location);
          // Campo já esvaziado por outra decisão, ou valor sumiu: não cria
          // variável vazia nem reescreve por cima.
          if (!value || isVarReference(value)) continue;
          variables.push({ key: action.variable, value });
          next = writeAt(next, finding.location, `{{${action.variable}}}`);
        } else {
          next = writeAt(next, finding.location, '');
        }
      }

      return next.item?.length ? { ...next, item: walk(next.item) } : next;
    });

  return { roots: walk(roots), variables };
}
