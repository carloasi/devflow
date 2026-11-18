import type { CollectionItem } from '@/app/types/CollectionItem';
import { findNodeById } from '@/components/collection-tree/utils/tree.utils';
import { cloneRequestNode } from './duplicateRequest';
import { applyRequestPatch, type RequestPatch } from './treeEdit';
import { applyBodyPatch, buildExpectScript, caseIdOf, type CaseExpectation } from './suiteCase';

// ─────────────────────────────────────────────────────────────────────────
// Passos de flow montados AQUI, a partir das requests de origem.
//
// Antes o agente, pra cada passo, achava a origem (list_folders/list_requests),
// lia a request inteira (get_request) e redigitava método, URL, headers e o
// body completo no create_flow — e ainda lia o passo equivalente do flow de
// referência pra copiar os scripts. Pra um modelo menor, isso eram ~4 chamadas
// por passo e muito texto gerado: o grosso dos 15 minutos de um flow.
//
// Com `copyFrom` (caminho ou id) o app copia a request de origem sozinho e só
// aplica por cima o que o agente mandar (scripts, body, URL…); com
// `scriptsFrom` puxa os scripts do flow de referência. Os segredos da origem
// vão junto sem passar pelo modelo, como no duplicate_request.
// ─────────────────────────────────────────────────────────────────────────

export interface RequestRef {
  collection?: string;
  folder?: string;
  request?: string;
  version?: string;
  search?: string;
}

export interface ScriptsRef {
  folder: string;
  step: string;
}

export interface FoundRequest {
  item: CollectionItem;
  /** Nomes das pastas até a request (sem ela). */
  folders: string[];
  /** "Coleção / Pasta / Request". */
  path: string;
}

const norm = (text: string) =>
  text
    .normalize('NFC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** "03 - Token v1" → "token v1": a numeração do flow não faz parte do nome. */
const bareName = (name: string) => norm(name).replace(/^\d+\s*-\s*/, '');

const splitPath = (text: string) =>
  (text.includes(' / ') ? text.split(' / ') : text.split('/'))
    .map(part => norm(part))
    .filter(Boolean);

function allRequests(items: CollectionItem[], folders: string[] = [], out: FoundRequest[] = []): FoundRequest[] {
  for (const item of items) {
    if (item.type === 'request') {
      out.push({ item, folders, path: [...folders, item.name].join(' / ') });
    } else if (item.item?.length) {
      allRequests(item.item, [...folders, item.name], out);
    }
  }
  return out;
}

/** Os segmentos aparecem em sequência no caminho das pastas. */
function containsSegments(folders: string[], wanted: string[]): boolean {
  if (wanted.length === 0) return true;
  const path = folders.map(norm);
  for (let start = 0; start + wanted.length <= path.length; start++) {
    if (wanted.every((segment, i) => path[start + i] === segment)) return true;
  }
  return false;
}

/** Fica com o filtro só se ele não zerar a lista (filtro de preferência). */
function prefer<T>(list: T[], keep: (entry: T) => boolean): T[] {
  const kept = list.filter(keep);
  return kept.length > 0 ? kept : list;
}

// Flows prontos, pastas de teste e de referência: nunca são origem de cópia
// (só de encadeamento). Usado como preferência quando há mais de uma candidata.
const FLOW_SEGMENT = /(^|\s)(flows?|flow tests?|mocks?)(\s|$)/i;

function describe(found: FoundRequest): string {
  return `${found.path} (id: ${found.item.id})`;
}

function ambiguity(what: string, list: FoundRequest[]): Error {
  const shown = list.slice(0, 8).map(describe).join('; ');
  const more = list.length > 8 ? `; … ${list.length - 8} more` : '';
  return new Error(`${what} matches ${list.length} requests: ${shown}${more}. Pass the id (or a longer path) of the one you want.`);
}

/** Aceita id, caminho "Coleção / Pasta / Request" ou o objeto da receita. */
export function findSourceRequest(collections: CollectionItem[], ref: string | RequestRef): FoundRequest {
  const everything = allRequests(collections);

  if (typeof ref === 'string') {
    const text = ref.trim();
    if (!text) throw new Error('empty request reference.');
    const byId = findNodeById(collections, text);
    if (byId) {
      if (byId.type !== 'request') throw new Error(`"${byId.name}" is a ${byId.type}, not a request.`);
      const entry = everything.find(e => e.item.id === byId.id);
      return entry ?? { item: byId, folders: [], path: byId.name };
    }
    // Parece id (UUID) e não existe: dizer isso. Antes caía no parse de caminho
    // e respondia 'No folder matches ""', que não ajuda. Nome solto sem espaço
    // ("2FA", "Checkout") segue como busca por nome.
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text)) {
      throw new Error(`Request id "${text}" not found in the open workspace. Check the workspace open in DevFlow, or use list_requests / search_requests to find the request.`);
    }
    // Caminho como o DevFlow mostra: " / " entre os níveis. Barra sem espaço
    // faz parte do nome (ex. "Order/{recordLocator} v3").
    const segments = text.includes(' / ') ? text.split(' / ') : text.split('/');
    const request = segments.pop() ?? '';
    return findSourceRequest(collections, { request, folder: segments.join(' / ') });
  }

  const label = [ref.folder, ref.request].filter(Boolean).join(' / ') || ref.search || '?';
  const folderSegments = ref.folder ? splitPath(ref.folder) : [];
  const inFolder = everything.filter(e => containsSegments(e.folders, folderSegments));
  if (inFolder.length === 0) {
    throw new Error(`No folder matches "${ref.folder}" (for "${label}"). Call list_folders to see the paths.`);
  }

  const wanted = ref.request ? bareName(ref.request) : '';
  const search = ref.search ? norm(ref.search) : '';
  let candidates = wanted ? inFolder.filter(e => bareName(e.item.name) === wanted) : [];
  if (candidates.length === 0 && wanted) candidates = inFolder.filter(e => bareName(e.item.name).includes(wanted));
  if (candidates.length === 0 && search) candidates = inFolder.filter(e => bareName(e.item.name).includes(search));
  if (candidates.length === 0) {
    const nearby = inFolder.slice(0, 8).map(e => e.path).join('; ');
    throw new Error(`Request "${label}" not found. In that folder: ${nearby || 'nothing'}.`);
  }

  if (ref.collection) {
    const collection = norm(ref.collection);
    candidates = prefer(candidates, e => norm(e.folders[0] ?? '') === collection);
  }
  if (candidates.length > 1 && ref.version) {
    const version = norm(ref.version);
    candidates = prefer(
      candidates,
      e => e.folders.some(f => norm(f) === version) || new RegExp(`(^|\\W)${version}(\\W|$)`).test(bareName(e.item.name))
    );
  }
  if (candidates.length > 1) candidates = prefer(candidates, e => !e.folders.some(f => FLOW_SEGMENT.test(f)));
  if (candidates.length > 1 && wanted) candidates = prefer(candidates, e => bareName(e.item.name) === wanted);

  if (candidates.length > 1) throw ambiguity(`"${label}"`, candidates);
  return candidates[0];
}

/** O passo `step` dentro da pasta de referência (o flow pronto). */
export function findReferenceStep(collections: CollectionItem[], ref: ScriptsRef | string): FoundRequest {
  if (typeof ref === 'string') return findSourceRequest(collections, ref);
  const folderSegments = splitPath(ref.folder);
  const inFolder = allRequests(collections).filter(e => containsSegments(e.folders, folderSegments));
  if (inFolder.length === 0) throw new Error(`Reference folder "${ref.folder}" not found.`);
  const wanted = bareName(ref.step);
  let matches = inFolder.filter(e => bareName(e.item.name) === wanted);
  if (matches.length === 0) matches = inFolder.filter(e => bareName(e.item.name).includes(wanted));
  if (matches.length === 0) {
    throw new Error(
      `Step "${ref.step}" not found in "${ref.folder}". Its steps: ${inFolder.map(e => e.item.name).join('; ')}.`
    );
  }
  // Mais de um com o nome (ex. "Order v3" antes e depois): o primeiro, na ordem do flow.
  return matches[0];
}

const PATCH_KEYS: (keyof RequestPatch)[] = [
  'method', 'url', 'pathParams', 'headers', 'body', 'bodyType', 'auth', 'preRequestScript', 'postResponseScript',
];

function patchOf(spec: Record<string, unknown>): RequestPatch {
  const patch: Record<string, unknown> = {};
  for (const key of PATCH_KEYS) if (spec[key] !== undefined) patch[key] = spec[key];
  return patch as RequestPatch;
}

const ASSERTION = /\bpm\.(test|expect)\s*\(/;

export interface BuiltStep {
  node: CollectionItem;
  /** De onde a request veio ("Coleção / Pasta / Request"), quando é cópia. */
  source?: string;
  /** De onde vieram os scripts, quando houve scriptsFrom. */
  scriptsSource?: string;
  warnings: string[];
}

export interface BuildOptions {
  /** Monta o nó da request "do zero" (create_request). */
  buildNew: (spec: Record<string, unknown>) => CollectionItem;
  /** Pre-request da receita + o do flow de referência, nessa ordem, em vez
   *  de o da receita substituir o outro. A receita usa pra o reset antes de
   *  criar, que se soma ao que o passo de referência já faz. */
  mergeReferencePreRequest?: boolean;
}

/**
 * Um passo do create_flow, pronto (ainda fora da árvore):
 * - `duplicateFrom`: cópia fiel (scripts e examples inclusive), com o que vier por cima;
 * - `copyFrom`: a request de origem sem os scripts dela, com os do passo por cima;
 * - senão, request nova com os campos do passo.
 * Em qualquer um, `scriptsFrom` traz os scripts do passo equivalente do flow de referência.
 */
export function buildFlowStep(
  collections: CollectionItem[],
  spec: Record<string, unknown>,
  name: (base: string) => string,
  options: BuildOptions
): BuiltStep {
  const warnings: string[] = [];
  let node: CollectionItem;
  let source: string | undefined;
  const fields = { ...spec };

  let scriptsSource: string | undefined;
  if (spec.scriptsFrom) {
    const reference = findReferenceStep(collections, spec.scriptsFrom as ScriptsRef | string);
    scriptsSource = reference.path;
    const scripts = reference.item.request?.scripts ?? { preRequest: '', postResponse: '' };
    const referencePre = scripts.preRequest ?? '';
    const referencePost = scripts.postResponse ?? '';
    if (fields.preRequestScript === undefined) fields.preRequestScript = referencePre;
    else if (options.mergeReferencePreRequest && referencePre.trim() && !String(fields.preRequestScript).includes(referencePre.trim())) {
      fields.preRequestScript = `${String(fields.preRequestScript).trimEnd()}\n\n// Do flow de referência (${reference.path}):\n${referencePre}`;
    }
    if (fields.postResponseScript === undefined) fields.postResponseScript = referencePost;
    if (ASSERTION.test(referencePre) || ASSERTION.test(referencePost)) {
      warnings.push(
        `the scripts copied from "${reference.path}" have pm.test/pm.expect — flows do not assert by default; remove them unless the user asked.`
      );
    }
  }

  const copyRef = (spec.duplicateFrom ?? spec.copyFrom) as string | RequestRef | undefined;
  if (copyRef) {
    const found = findSourceRequest(collections, copyRef);
    source = found.path;
    const base = String(spec.name ?? '').trim() || found.item.name;
    node = cloneRequestNode(found.item, name(base));
    if (!spec.duplicateFrom) {
      // copyFrom: a request, não os testes nem os examples da origem.
      delete node.item;
      if (node.request) node.request = { ...node.request, scripts: { preRequest: '', postResponse: '' } };
    }
    const patch = patchOf(fields);
    if (Object.keys(patch).length > 0) node = { ...applyRequestPatch(node, patch).item, name: node.name };
  } else {
    const built = options.buildNew(fields);
    node = { ...built, name: name(built.name) };
  }

  // Caso de suíte: só o que muda no body e o retorno esperado.
  if ((spec.bodyPatch || spec.bodyRemove) && node.request) {
    const body = applyBodyPatch(
      node.request.body ?? '',
      (spec.bodyPatch ?? {}) as Record<string, unknown>,
      Array.isArray(spec.bodyRemove) ? spec.bodyRemove.map(String) : []
    );
    node = { ...node, request: { ...node.request, body, bodyType: 'raw' } };
  }
  if (spec.expect && node.request) {
    const caseId = String(spec.caseId ?? '').trim() || caseIdOf(String(spec.name ?? '').trim() || node.name);
    const asserts = buildExpectScript(caseId, spec.expect as CaseExpectation);
    const post = node.request.scripts?.postResponse ?? '';
    node = {
      ...node,
      request: {
        ...node.request,
        scripts: { preRequest: node.request.scripts?.preRequest ?? '', postResponse: post.trim() ? `${post.trimEnd()}\n\n${asserts}` : asserts },
      },
    };
  }

  // Troca de texto na URL, nos headers e no body (ex. {{urlOrderGroupsApi}} →
  // {{urlOrderGroups}} quando o environment só tem a segunda).
  const replacements = (spec.replaceText as { from: string; to: string }[] | undefined) ?? [];
  if (replacements.length > 0 && node.request) {
    const swap = (text: string) => replacements.reduce((acc, r) => acc.split(r.from).join(r.to), text);
    const url = swap(node.request.url ?? '');
    node = {
      ...node,
      request: {
        ...node.request,
        url,
        urlexport: { ...(node.request.urlexport ?? { host: [], path: [] }), raw: url },
        headers: (node.request.headers ?? []).map(h => ({ ...h, value: swap(h.value ?? '') })),
        body: swap(node.request.body ?? ''),
      },
    };
  }

  return { node, source, scriptsSource, warnings };
}
