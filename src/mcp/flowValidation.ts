import type { CollectionItem } from '@/app/types/CollectionItem';

// ─────────────────────────────────────────────────────────────────────────
// Validação estática de um flow (validate_flow / create_flow do MCP).
//
// Um flow é uma pasta: os passos rodam na ordem e passam dados gravando
// variáveis no post-response (`pm.environment.set`). O erro mais comum de
// quem monta um flow — sobretudo uma IA menor — é um passo consumir
// `{{x}}` que ninguém produz, ou que só é produzido DEPOIS. Hoje isso só
// aparece executando (e executar cria dados reais). Aqui aparece antes, sem
// rodar nada e sem ler valor de variável nenhuma: só nomes.
//
// Sem Tauri de propósito: testável fora do app.
// ─────────────────────────────────────────────────────────────────────────

export type ProblemLevel = 'error' | 'warning';

export interface FlowProblem {
  level: ProblemLevel;
  code:
    | 'missing-variable'
    | 'produced-later'
    | 'empty-url'
    | 'grpc-not-runnable'
    | 'json-body-without-content-type'
    | 'script-syntax'
    | 'literal-secret';
  message: string;
  variable?: string;
}

export interface FlowStepReport {
  position: number;
  id: string;
  name: string;
  method: string;
  tokenStep: boolean;
  /** {{variáveis}} que o passo usa (URL, headers, path params, body, auth). */
  consumes: string[];
  /** Variáveis que os scripts do passo gravam (pre-request valem no próprio passo). */
  produces: string[];
  problems: FlowProblem[];
}

export interface FlowReport {
  ok: boolean;
  steps: FlowStepReport[];
  errors: number;
  warnings: number;
  /** Consumidas por algum passo, sem produtor e sem existir no environment. */
  missingVariables: string[];
}

const VAR_RE = /\{\{\s*([^{}\s]+?)\s*\}\}/g;
const SET_RE = /pm\.(?:environment|variables|globals|collectionVariables)\.set\(\s*(['"`])([^'"`]+)\1/g;
// Mesma regra de nome da redação de segredos (redactSecrets).
const SECRET_NAME_RE = /auth|token|key|secret|password|senha|cookie|session/i;

function varsIn(text: string | undefined | null, out: Set<string>) {
  for (const match of String(text ?? '').matchAll(VAR_RE)) {
    // {{$guid}}, {{$timestamp}}… são variáveis dinâmicas do runtime.
    if (!match[1].startsWith('$')) out.add(match[1]);
  }
}

// set("x", "") é reset antes de criar, não produção: contar como produtor
// escondia a falta do produtor de verdade (ex. post-response com caminho
// errado) e o validate passava.
const RESET_RE = /^\s*,\s*(?:""|''|``)\s*\)/;

function setsIn(script: string | undefined | null): string[] {
  const text = String(script ?? '');
  return [...text.matchAll(SET_RE)]
    .filter(m => !RESET_RE.test(text.slice((m.index ?? 0) + m[0].length)))
    .map(m => m[2]);
}

function isTokenStep(item: CollectionItem): boolean {
  return item.request?.auth?.type === 'oauth2' && !item.request?.url?.trim();
}

/** Variável que um passo de token grava (o campo Access Token = {{x}}). */
function tokenVariable(item: CollectionItem): string | null {
  const field = item.request?.auth?.oauth2?.find(e => e.key === 'accessToken' && e.enabled !== false)?.value ?? '';
  return field.trim().match(/^\{\{\s*([\w.-]+)\s*\}\}$/)?.[1] ?? null;
}

function hasBody(item: CollectionItem): boolean {
  const req = item.request;
  return !!req && req.bodyType !== 'none' && !!req.body?.trim();
}

/** O que o passo consome: tudo que vai na request (não o que os scripts leem). */
export function consumedVariables(item: CollectionItem): string[] {
  const out = new Set<string>();
  const req = item.request;
  if (!req) return [];
  varsIn(req.url, out);
  for (const h of req.headers ?? []) {
    if (h.enabled === false) continue;
    varsIn(h.key, out);
    varsIn(h.value, out);
  }
  for (const v of req.urlexport?.variable ?? []) if (v.enabled !== false) varsIn(v.value, out);
  if (hasBody(item)) varsIn(req.body, out);
  const auth = req.auth;
  if (auth && auth.type !== 'none') {
    varsIn(auth.token, out);
    varsIn(auth.username, out);
    varsIn(auth.password, out);
    varsIn(auth.key, out);
    varsIn(auth.value, out);
    for (const e of auth.oauth2 ?? []) {
      // O Access Token de um passo de token é o que ele PRODUZ, não consome.
      if (e.enabled === false || (isTokenStep(item) && e.key === 'accessToken')) continue;
      varsIn(e.value, out);
    }
  }
  return [...out];
}

function syntaxProblem(phase: string, code: string | undefined): FlowProblem | null {
  if (!code?.trim()) return null;
  try {
    // Só compila (não executa). O QuickJS do DevFlow tem a mesma sintaxe.
    new Function(code);
    return null;
  } catch (e) {
    // EvalError/CSP: o ambiente não deixa compilar — não é erro do script.
    if (!(e instanceof SyntaxError)) return null;
    return { level: 'error', code: 'script-syntax', message: `${phase} script does not compile: ${e.message}` };
  }
}

function literalSecretProblems(item: CollectionItem): FlowProblem[] {
  const req = item.request;
  if (!req) return [];
  const literal = (value: string | undefined) => !!value?.trim() && !value.includes('{{');
  const problems: FlowProblem[] = [];
  for (const h of req.headers ?? []) {
    if (h.enabled !== false && SECRET_NAME_RE.test(h.key) && literal(h.value)) {
      problems.push({
        level: 'warning',
        code: 'literal-secret',
        message: `Header "${h.key}" has a literal value — use a {{variable}}: the collection is synced to GitHub.`,
      });
    }
  }
  const auth = req.auth;
  if (auth && auth.type !== 'none' && auth.type !== 'oauth2') {
    for (const [field, value] of [['token', auth.token], ['password', auth.password], ['value', auth.value]] as const) {
      if (literal(value)) {
        problems.push({
          level: 'warning',
          code: 'literal-secret',
          message: `Auth ${field} is a literal value — use a {{variable}}: the collection is synced to GitHub.`,
        });
      }
    }
  }
  return problems;
}

/**
 * Valida os passos de um flow, na ordem em que rodam.
 * `environmentNames`: nomes das variáveis do environment (null = sem environment pra conferir).
 */
export function validateFlow(steps: CollectionItem[], environmentNames: Iterable<string> | null): FlowReport {
  const env = new Set(environmentNames ?? []);
  const producedBy = new Map<string, number>(); // variável → 1º passo que a produz
  const plan = steps.map((item, index) => {
    const pre = setsIn(item.request?.scripts?.preRequest);
    const post = setsIn(item.request?.scripts?.postResponse);
    const token = isTokenStep(item) ? tokenVariable(item) : null;
    const produces = [...new Set([...pre, ...post, ...(token ? [token] : [])])];
    for (const name of produces) if (!producedBy.has(name)) producedBy.set(name, index);
    return { item, index, pre: new Set(pre), produces };
  });

  const missing = new Set<string>();
  const reports: FlowStepReport[] = plan.map(({ item, index, pre, produces }) => {
    const problems: FlowProblem[] = [];
    const consumes = consumedVariables(item);
    for (const name of consumes) {
      const first = producedBy.get(name);
      if (pre.has(name) || (first !== undefined && first < index) || env.has(name)) continue;
      if (first !== undefined && first >= index) {
        problems.push({
          level: 'error',
          code: 'produced-later',
          variable: name,
          message: `{{${name}}} is only produced by step ${first + 1} ("${steps[first].name}"), after this one.`,
        });
        continue;
      }
      missing.add(name);
      problems.push({
        level: 'error',
        code: 'missing-variable',
        variable: name,
        message: `{{${name}}} is not produced by an earlier step and is not in the environment.`,
      });
    }

    if (item.protocol === 'grpc') {
      problems.push({ level: 'warning', code: 'grpc-not-runnable', message: 'gRPC steps are not run by run_collection.' });
    } else if (!item.request?.url?.trim() && !isTokenStep(item)) {
      problems.push({ level: 'error', code: 'empty-url', message: 'The URL is empty (and this is not an OAuth 2.0 token step).' });
    }

    // O app põe Content-type: application/json sozinho quando há body — só
    // falta se esse header automático foi desligado e não há um do usuário.
    const req = item.request;
    if (req && hasBody(item) && /^\s*[[{]/.test(req.body ?? '')) {
      const userHeader = (req.headers ?? []).some(h => h.enabled !== false && h.key?.toLowerCase() === 'content-type');
      const defaultOff = (req.disabledDefaultHeaders ?? []).some(k => k.toLowerCase() === 'content-type');
      if (!userHeader && defaultOff) {
        problems.push({
          level: 'warning',
          code: 'json-body-without-content-type',
          message: 'JSON body without Content-Type (the automatic header is turned off).',
        });
      }
    }

    for (const p of [syntaxProblem('Pre-request', req?.scripts?.preRequest), syntaxProblem('Post-response', req?.scripts?.postResponse)]) {
      if (p) problems.push(p);
    }
    problems.push(...literalSecretProblems(item));

    return {
      position: index + 1,
      id: item.id,
      name: item.name,
      method: item.protocol === 'grpc' ? 'gRPC' : item.method ?? 'GET',
      tokenStep: isTokenStep(item),
      consumes,
      produces,
      problems,
    };
  });

  const errors = reports.reduce((n, r) => n + r.problems.filter(p => p.level === 'error').length, 0);
  const warnings = reports.reduce((n, r) => n + r.problems.filter(p => p.level === 'warning').length, 0);
  return { ok: errors === 0, steps: reports, errors, warnings, missingVariables: [...missing] };
}
