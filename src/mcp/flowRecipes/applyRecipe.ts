// ─────────────────────────────────────────────────────────────────────────
// Receita + respostas do usuário → os passos do create_flow.
//
// É o que o agente fazia à mão seguindo as RECIPE_RULES: escolher o bloco de
// autenticação pela resposta, tirar os passos cujo `when` não bate, trocar a
// rota/pax/antecedência nos scripts, transformar "copyFrom" em cópia e
// "scriptsFrom" em scripts do flow de referência. Feito aqui, o agente manda
// só as respostas (create_flow_from_recipe) e recebe o flow pronto.
//
// Puro (sem árvore, sem Tauri): devolve os passos e o que falta; quem chama
// resolve as origens (flowSources) e grava.
// ─────────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;

export interface RecipeQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface PlannedStep {
  /** Nome do passo na receita (chave de `overrides`). */
  recipeName: string;
  spec: Json;
  status?: string;
  notes?: string;
}

export interface RecipePlan {
  steps: PlannedStep[];
  missingAnswers: RecipeQuestion[];
  /** Passos com bloco CONFIRMAR (caminho de JSON) ainda não confirmados. */
  needsConfirmation: string[];
  /** Passos cuja origem depende de uma escolha que a receita não resolve. */
  unresolved: string[];
  /** Respostas que nenhum marcador nem `when` usa: o agente aplica à mão (ex. rota no body). */
  unusedAnswers: string[];
}

/** "hold (Recomendado)" → "hold"; "Sim, usar urlOrderGroups (Recomendado)" → "sim, usar urlordergroups". */
export function normalizeAnswer(answer: string): string {
  return answer
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** O token bate no começo da resposta, como palavra inteira ("paga" ≠ "pagamento"). */
function answerStartsWith(answer: string, token: string): boolean {
  const a = normalizeAnswer(answer);
  const t = normalizeAnswer(token);
  if (!a.startsWith(t)) return false;
  const next = a.charAt(t.length);
  return next === '' || !/[\p{L}\p{N}]/u.test(next);
}

/** "payment == paga", "auth != msal". Resposta ausente = undefined (falta perguntar). */
export function evaluateWhen(when: string, answers: Record<string, string>, used?: Set<string>): boolean | undefined {
  const match = when.match(/^\s*([\w-]+)\s*(==|!=)\s*(.+?)\s*$/);
  if (!match) throw new Error(`Invalid "when" in the recipe: "${when}".`);
  const [, id, op, token] = match;
  used?.add(id);
  const answer = answers[id];
  if (answer === undefined) return undefined;
  const hit = answerStartsWith(answer, token);
  return op === '==' ? hit : !hit;
}

const ROUTE = /([A-Za-z]{3})\s*(?:→|->|>|–|-|\/|\bpara\b|\baté\b|\ba\b)\s*([A-Za-z]{3})\b/i;

/** Valor de um marcador `<<id>>`, `<<id.number>>`, `<<id.origin>>`, `<<id.destination>>`. */
function answerPart(answer: string, part: string | undefined): string | undefined {
  if (!part) return normalizeAnswer(answer);
  if (part === 'number') return answer.match(/\d+/)?.[0];
  if (part === 'origin' || part === 'destination') {
    const route = answer.match(ROUTE);
    if (!route) return undefined;
    return (part === 'origin' ? route[1] : route[2]).toUpperCase();
  }
  return undefined;
}

const MARKER = /<<([\w-]+)(?:\.(\w+))?>>/g;

/** Troca os marcadores das respostas em todo texto do passo. */
function fillMarkers(value: unknown, answers: Record<string, string>, problems: Set<string>, used?: Set<string>): unknown {
  if (typeof value === 'string') {
    return value.replace(MARKER, (whole, id: string, part: string | undefined) => {
      used?.add(id);
      const answer = answers[id];
      const filled = answer === undefined ? undefined : answerPart(answer, part);
      if (filled === undefined) {
        problems.add(answer === undefined ? id : `${id} (could not read "${part}" from "${answer}")`);
        return whole;
      }
      return filled;
    });
  }
  if (Array.isArray(value)) return value.map(v => fillMarkers(v, answers, problems, used));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillMarkers(v, answers, problems, used)]));
  }
  return value;
}

const STEP_FIELDS = [
  'name', 'method', 'url', 'pathParams', 'headers', 'body', 'bodyType', 'auth', 'preRequestScript', 'postResponseScript',
];

function isPlaceholderRef(ref: unknown): boolean {
  if (!ref || typeof ref !== 'object') return false;
  return Object.values(ref as Json).some(v => typeof v === 'string' && /^\(.*\)$/.test(v.trim()));
}

/** Um passo de bloco de autenticação (references/grupos/auth-*.json) → passo do create_flow. */
export function authBlockSteps(block: Json): Json[] {
  const steps: Json[] = [];
  const duplicate = block.duplicate as Json | undefined;
  if (duplicate) {
    // O caminho, quando a receita tem, dispensa o agente de procurar o id.
    steps.push({ duplicateFrom: duplicate.path ?? duplicate.requestId, name: duplicate.name });
  }
  for (const request of (block.requests as Json[] | undefined) ?? []) {
    const rest = { ...request };
    delete rest.folderId;
    steps.push(rest);
  }
  return steps;
}

export function planRecipe(
  recipe: Json,
  authBlocks: Record<string, Json>,
  answers: Record<string, string>,
  options: { overrides?: Record<string, Json>; confirmed?: string[] } = {}
): RecipePlan {
  const asks = ((recipe.ask as RecipeQuestion[] | undefined) ?? []).map(q => ({
    id: q.id,
    question: q.question,
    options: q.options,
  }));
  const missing = new Set<string>();
  const used = new Set<string>();
  // Toda pergunta da receita precisa de resposta, mesmo a que o app não aplica
  // sozinho (vai em "unusedAnswers", pro agente pôr no passo certo).
  for (const q of asks) if (!(answers[q.id] ?? '').trim()) missing.add(q.id);
  const overrides = options.overrides ?? {};
  const confirmed = new Set((options.confirmed ?? []).map(name => name.trim().toLowerCase()));
  const steps: PlannedStep[] = [];
  const needsConfirmation: string[] = [];
  const unresolved: string[] = [];

  // Autenticação primeiro: o bloco cujo `when` bate.
  for (const include of (recipe.include as { when: string; file: string }[] | undefined) ?? []) {
    const hit = evaluateWhen(include.when, answers, used);
    if (hit === undefined) {
      missing.add(include.when.split(/==|!=/)[0].trim());
      continue;
    }
    if (!hit) continue;
    const block = authBlocks[include.file];
    if (!block) throw new Error(`The recipe includes "${include.file}", which this DevFlow does not ship.`);
    for (const spec of authBlockSteps(block)) {
      steps.push({ recipeName: String(spec.name ?? ''), spec, status: 'confirmado' });
    }
  }

  const recipeSteps = (recipe.steps as Json[] | undefined) ?? [];
  recipeSteps.forEach((step, index) => {
    const recipeName = String(step.name ?? `step ${index + 1}`);
    if (typeof step.when === 'string') {
      const hit = evaluateWhen(step.when, answers, used);
      if (hit === undefined) {
        missing.add(step.when.split(/==|!=/)[0].trim());
        return;
      }
      if (!hit) return;
    }

    const override = overrides[recipeName] ?? overrides[String(index + 1)] ?? {};
    if (override.skip === true) return;

    const spec: Json = {};
    for (const key of STEP_FIELDS) if (step[key] !== undefined) spec[key] = step[key];
    const copyRef = override.copyFrom ?? override.duplicateFrom ?? step.copyFrom;
    if (copyRef && !isPlaceholderRef(copyRef)) {
      spec[step.tool === 'duplicate_request' || override.duplicateFrom ? 'duplicateFrom' : 'copyFrom'] = copyRef;
    } else if (copyRef) {
      unresolved.push(recipeName);
    }
    if (step.scriptsFrom && override.scriptsFrom !== null) spec.scriptsFrom = override.scriptsFrom ?? step.scriptsFrom;
    for (const [key, value] of Object.entries(override)) {
      if (!['copyFrom', 'duplicateFrom', 'scriptsFrom', 'skip'].includes(key)) spec[key] = value;
    }

    // Trocas de texto que dependem de resposta (ex. {{urlOrderGroupsApi}} → {{urlOrderGroups}}).
    for (const rule of (step.replace as { when?: string; from: string; to: string }[] | undefined) ?? []) {
      if (rule.when) {
        const hit = evaluateWhen(rule.when, answers, used);
        if (hit === undefined) missing.add(rule.when.split(/==|!=/)[0].trim());
        if (!hit) continue;
      }
      spec.replaceText = [...((spec.replaceText as Json[] | undefined) ?? []), { from: rule.from, to: rule.to }];
    }

    const scripts = `${spec.preRequestScript ?? ''}\n${spec.postResponseScript ?? ''}`;
    if (/CONFIRMAR/.test(scripts) && !confirmed.has(recipeName.toLowerCase()) && override.postResponseScript === undefined) {
      needsConfirmation.push(recipeName);
    }

    steps.push({
      recipeName,
      spec: fillMarkers(spec, answers, missing, used) as Json,
      status: typeof step.status === 'string' ? step.status : undefined,
      notes: typeof step.notes === 'string' ? step.notes : undefined,
    });
  });

  // Marcadores dos blocos de autenticação também.
  for (const planned of steps) planned.spec = fillMarkers(planned.spec, answers, missing, used) as Json;

  const missingAnswers = asks.filter(q => [...missing].some(m => m === q.id || m.startsWith(`${q.id} `)));
  const unknown = [...missing].filter(m => !asks.some(q => m === q.id || m.startsWith(`${q.id} `)));
  for (const id of unknown) missingAnswers.push({ id, question: `Answer "${id}"`, options: [] });

  const unusedAnswers = asks.filter(q => answers[q.id] !== undefined && !used.has(q.id)).map(q => q.id);
  return { steps, missingAnswers, needsConfirmation, unresolved, unusedAnswers };
}

/** "Flow NN - Reserva paga" com o próximo número livre entre os irmãos. */
export function numberedFlowName(template: string, siblingNames: string[]): string {
  if (!/\bNN\b/.test(template)) return template;
  const used = siblingNames
    .map(name => name.match(/^\s*flow\s+(\d+)/i)?.[1])
    .filter((n): n is string => !!n)
    .map(Number);
  const next = (used.length ? Math.max(...used) : 0) + 1;
  return template.replace(/\bNN\b/, String(next).padStart(2, '0'));
}
