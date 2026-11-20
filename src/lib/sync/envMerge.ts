import type { Environment, EnvironmentValue } from '@/app/types/Environment';
import { hashContent } from '@/lib/contentHash';
import {
  applyEnvironmentChanges,
  diffEnvironments,
  enabledByKey,
  matchEnvironments,
} from '@/lib/environmentDiff';
import type { NodeHashes } from '@/lib/syncBase';
import { isSessionToken, withoutSessionTokens } from '@/lib/jwt';

// ─────────────────────────────────────────────────────────────────────────
// Merge dos ENVIRONMENTS no push, variável a variável.
//
// Antes o push mandava o arquivo do environment inteiro: quem enviasse por
// último apagava as variáveis que outra pessoa tinha criado ou mudado no
// meio. Agora, com a base (hash de cada variável na última sincronização):
//
//   mudou só lá  → entra o valor do GitHub;
//   mudou só aqui → fica o seu;
//   mudou dos dois lados (ou sem base) → fica o SEU, sem perguntar.
//
// O último caso não abre revisão de propósito: variável de environment muda
// sozinha o tempo todo (pm.environment.set grava token, id de reserva…), e
// perguntar a cada push sobre o `bearerToken` seria insuportável. Ficar com
// o seu é o que o push sempre fez — só que agora vale por variável, e não
// pelo environment inteiro.
//
// As chaves na base (mesmo registro das collections, ver syncBase):
//   env:<envId>         → o environment existia;
//   env:<envId>:<key>   → hash de valor + descrição da variável.
// ─────────────────────────────────────────────────────────────────────────

export const ENV_BASE_PREFIX = 'env:';

const envKey = (envId: string) => `${ENV_BASE_PREFIX}${envId}`;
const varKey = (envId: string, key: string) => `${ENV_BASE_PREFIX}${envId}:${key}`;

/**
 * Prefixo das variáveis de UM environment na base, com o `:` final. Sem ele,
 * `env:<id>#1` também pegava `env:<id>#10`…`#19` (ids gerados pela posição
 * no arquivo): regravar um apagava a base dos outros. A chave do próprio
 * environment (`env:<id>`) é regravada junto com as variáveis.
 */
export const envVarsPrefix = (envId: string) => `${ENV_BASE_PREFIX}${envId}:`;

function varHash(value: EnvironmentValue): string {
  return hashContent({ value: String(value.value ?? ''), description: value.description ?? '' });
}

type EnvPair = { local?: Environment; remote?: Environment };

/**
 * Id com que a base conhece este environment. Casados pelo NOME (duas
 * máquinas que criaram "Dev" cada uma), o local e o do GitHub têm ids
 * diferentes — e a base gravada num pull fica com o id de lá. Procurar só
 * pelo id daqui não achava nada: toda variável virava "sem base, fica a
 * sua", a mudança do colega nunca chegava e o push seguinte a apagava.
 */
function baseIdOf(base: NodeHashes | null, pair: EnvPair | undefined, fallback: string): string {
  const ids = [pair?.local?.id, pair?.remote?.id].filter((id): id is string => !!id);
  return ids.find(id => base?.[envKey(id)] !== undefined) ?? fallback;
}

/** Hashes dos environments pra base da sincronização. */
export function environmentHashes(environments: Environment[] | null | undefined): NodeHashes {
  const out: NodeHashes = {};
  for (const env of environments ?? []) {
    if (!env?.id) continue;
    out[envKey(env.id)] = '1';
    for (const [key, value] of enabledByKey(env.values)) out[varKey(env.id, key)] = varHash(value);
  }
  return out;
}

/**
 * A base dos environments depois de trazer pra cá, ANTES do push, o que veio
 * do GitHub (rebaseEnvironments) — mesmo motivo de adoptedRemoteBase
 * (lib/syncBase): sem isto, se o commit falhasse, a variável que veio de lá
 * ficava aqui como se fosse sua, e o push seguinte desfazia o que o colega
 * mudou ou apagou depois.
 *
 * Onde o environment mesclado ficou igual ao do GitHub (pareados pelo id
 * ou pelo nome), a variável vira base. Variável que a base tinha e que não existe mais em
 * nenhum dos dois lados sai — só nos environments presentes dos dois lados:
 * `merged` e `remote` podem ser só um environment, e a ausência dos outros
 * não diz nada. Tokens de sessão nunca entram (sobem vazios, lib/jwt).
 */
export function adoptedRemoteEnvBase(
  merged: Environment[] | null | undefined,
  remote: Environment[] | null | undefined,
  base: NodeHashes | null
): { hashes: NodeHashes; dropKeys: string[] } {
  const remoteEnvs = withoutSessionTokens(remote ?? []);
  const hashes: NodeHashes = {};
  const dropKeys: string[] = [];
  // Pareados pelo id e, sem ele, pelo NOME (matchEnvironments): o mesmo
  // environment criado em duas máquinas tem um id aqui e outro lá. Pelo id
  // só, as chaves dos dois lados nunca batiam e a base dele não mudava —
  // ficava a de antes do merge, e a variável que veio do colega passava por
  // sua no push seguinte. As chaves vão no id que a base já usa pra ele
  // (o mesmo que rebaseEnvironments lê); sem nenhum, o daqui, que é o que
  // o push grava.
  for (const pair of matchEnvironments(merged ?? [], remoteEnvs)) {
    if (!pair.local?.id || !pair.remote) continue;
    const id = baseIdOf(base, pair, pair.local.id);
    const mergedHashes = environmentHashes([{ ...pair.local, id }]);
    const remoteHashes = environmentHashes([{ ...pair.remote, id }]);
    for (const [key, value] of Object.entries(remoteHashes)) {
      if (mergedHashes[key] === value && base?.[key] !== value) hashes[key] = value;
    }
    // Variável que a base tinha e que não existe mais em nenhum dos dois
    // lados sai — só nos environments presentes dos dois lados: `merged` e
    // `remote` podem ser só um environment, e a ausência dos outros não diz
    // nada.
    if (!base) continue;
    const prefix = `${envKey(id)}:`;
    for (const key of Object.keys(base)) {
      if (key.startsWith(prefix) && mergedHashes[key] === undefined && remoteHashes[key] === undefined) dropKeys.push(key);
    }
  }
  return { hashes, dropKeys };
}

/**
 * Ids (do diffEnvironments) que, numa REVISÃO de environments, devem
 * começar em "Mine": variável sua alterada desde a base (ou sem base pra
 * dizer), e variável/environment que você apagou aqui. Sem isto a revisão
 * — que não tinha base nenhuma — marcava tudo como "usar a do GitHub", e
 * aplicar descartava a sua variável ainda não enviada.
 */
export function envKeepMineIds(
  local: Environment[] | null | undefined,
  remote: Environment[] | null | undefined,
  base: NodeHashes | null
): Set<string> {
  const out = new Set<string>();
  const pairs = new Map<string, EnvPair>();
  for (const pair of matchEnvironments(local ?? [], remote ?? [])) pairs.set(pair.local?.id ?? pair.remote!.id, pair);

  for (const node of diffEnvironments(local ?? [], remote ?? [])) {
    const envId = node.rootId;
    const baseId = baseIdOf(base, pairs.get(envId), envId);
    if (node.kind !== 'variable') {
      // Environment só lá que a base conhece: você o apagou aqui.
      if (node.change === 'added' && base?.[envKey(baseId)] !== undefined) out.add(node.id);
      continue;
    }
    const key = node.path[node.path.length - 1];
    const recorded = base?.[varKey(baseId, key)];
    if (node.change === 'added') {
      if (recorded !== undefined) out.add(node.id); // apagada aqui
      continue;
    }
    if (node.change === 'modified') {
      const pair = pairs.get(envId);
      const localValue = pair?.local ? enabledByKey(pair.local.values).get(key) : undefined;
      if (recorded === undefined || !localValue || varHash(localValue) !== recorded) out.add(node.id);
    }
  }
  return out;
}

export interface EnvRebaseResult {
  merged: Environment[];
  /** Variáveis (ou environments inteiros) que vieram do GitHub. */
  incoming: number;
  /** Mudados dos dois lados: ficou o valor daqui. */
  keptMine: number;
  /** Quais foram, "environment › variável" — pra dizer na mensagem do push. */
  keptMineNames: string[];
  /** O que veio do GitHub ("environment › variável"). */
  incomingNames: string[];
  /** O que é seu e segue no push. */
  outgoingNames: string[];
  /**
   * Tokens de sessão ("environment › variável") que diferem do GitHub e
   * ficam de fora: são de cada pessoa e sobem vazios (lib/jwt). Só pra Central
   * dizer por que não aparecem em "Para enviar".
   */
  sessionTokenNames: string[];
  /**
   * O valor de cada lado, por nome ("environment › variável") — o que a
   * Central mostra no diff de cada linha. Environment inteiro (só de um lado)
   * vem como "chave = valor", uma variável por linha. Sem tokens de sessão.
   */
  values: Record<string, { local?: string; remote?: string }>;
}

/** O conteúdo de um environment como texto, pro diff de um environment inteiro. */
function envAsText(env: Environment | undefined): string | undefined {
  if (!env) return undefined;
  return [...enabledByKey(env.values)].map(([key, v]) => `${key} = ${v.value ?? ''}`).join('\n');
}

export function rebaseEnvironments(
  local: Environment[] | null | undefined,
  remote: Environment[] | null | undefined,
  base: NodeHashes | null
): EnvRebaseResult {
  const localEnvs = local ?? [];
  // O lado do GitHub sem token de sessão: um arquivo de antes de eles subirem
  // vazios ainda pode ter o token de alguém. Assim a variável que só existe
  // lá chega aqui (vazia) em vez de ser ignorada inteira — e nunca com o
  // token de outra pessoa.
  const remoteEnvs = withoutSessionTokens(remote ?? []);

  // Os dois lados de cada environment, pelo id que o diff usa (o local).
  const pairs = new Map<string, EnvPair>();
  for (const pair of matchEnvironments(localEnvs, remoteEnvs)) {
    pairs.set(pair.local?.id ?? pair.remote!.id, pair);
  }

  // Token de sessão não entra no merge: o push o sobe VAZIO (lib/jwt), então
  // "aqui tem o token, no GitHub está vazio" é o estado normal depois de todo
  // envio. Comparado, ele aparecia pra sempre em "Para enviar" (e como
  // "mantive a sua" a cada push), por mais que se enviasse.
  const sessionTokenNames: string[] = [];
  const nodes = diffEnvironments(localEnvs, remoteEnvs).filter(node => {
    if (node.kind !== 'variable') return true;
    const pair = pairs.get(node.rootId);
    const key = node.path[node.path.length - 1];
    const localValue = pair?.local ? enabledByKey(pair.local.values).get(key)?.value : undefined;
    const remoteValue = pair?.remote ? enabledByKey(pair.remote.values).get(key)?.value : undefined;
    if (!isSessionToken(key, localValue) && !isSessionToken(key, remoteValue)) return true;
    sessionTokenNames.push(node.path.join(' › '));
    return false;
  });
  if (nodes.length === 0) {
    return { merged: localEnvs, incoming: 0, keptMine: 0, keptMineNames: [], incomingNames: [], outgoingNames: [], sessionTokenNames, values: {} };
  }
  // O que é seu: o mesmo critério da revisão (envKeepMineIds), menos o que
  // mudou dos dois lados (esse vai em keptMineNames).
  const mineIds = envKeepMineIds(localEnvs, remoteEnvs, base);

  // Alguma variável deste environment mudou aqui desde a base?
  const changedHere = (env: Environment, baseId: string) =>
    [...enabledByKey(env.values)].some(([key, value]) => base?.[varKey(baseId, key)] !== varHash(value));

  const accepted = new Set<string>();
  let incoming = 0;
  let keptMine = 0;
  const keptMineNames: string[] = [];
  const keep = (node: { path: string[] }) => {
    keptMine++;
    keptMineNames.push(node.path.join(' › '));
  };

  for (const node of nodes) {
    const envId = node.rootId;
    const pair = pairs.get(envId);
    const baseId = baseIdOf(base, pair, envId);
    const known = (key: string) => base?.[key] !== undefined;

    if (node.kind !== 'variable') {
      if (node.change === 'added') {
        // Só no GitHub: novo lá → entra; já existiu aqui → você apagou, fica apagado.
        if (!known(envKey(baseId))) {
          accepted.add(node.id);
          incoming++;
        }
      } else if (node.change === 'removed') {
        // Só aqui: novo aqui → fica; apagado lá → sai, a não ser que você o tenha mudado.
        if (known(envKey(baseId)) && pair?.local && !changedHere(pair.local, baseId)) {
          accepted.add(node.id);
          incoming++;
        } else if (known(envKey(baseId))) {
          keep(node);
        }
      }
      continue;
    }

    const key = node.path[node.path.length - 1];
    const recorded = base?.[varKey(baseId, key)];
    const localValue = pair?.local ? enabledByKey(pair.local.values).get(key) : undefined;
    const remoteValue = pair?.remote ? enabledByKey(pair.remote.values).get(key) : undefined;

    if (node.change === 'added') {
      // Só no GitHub: criada lá → entra; já existia → você apagou, fica apagada.
      if (recorded === undefined) {
        accepted.add(node.id);
        incoming++;
      }
      continue;
    }
    if (node.change === 'removed') {
      // Só aqui: apagada lá e intocada aqui → sai; senão fica.
      if (recorded !== undefined && localValue && varHash(localValue) === recorded) {
        accepted.add(node.id);
        incoming++;
      }
      continue;
    }

    // Alterada: vale quem mexeu; os dois (ou sem base) → fica a sua.
    if (recorded === undefined || !localValue || !remoteValue) {
      keep(node);
      continue;
    }
    const here = varHash(localValue) !== recorded;
    const there = varHash(remoteValue) !== recorded;
    if (there && !here) {
      accepted.add(node.id);
      incoming++;
    } else if (there && here) {
      keep(node);
    }
  }

  const label = (node: { path: string[] }) => node.path.join(' › ');
  const incomingNames = nodes.filter(n => accepted.has(n.id)).map(label);
  const keptSet = new Set(keptMineNames);
  const outgoingNames = nodes
    .filter(n => !accepted.has(n.id) && (mineIds.has(n.id) || n.change === 'removed') && !keptSet.has(label(n)))
    .map(label);
  // Os dois lados de cada linha listada, pro diff da Central. Os tokens de
  // sessão já saíram (dos dois lados) lá em cima.
  const values: EnvRebaseResult['values'] = {};
  for (const node of nodes) {
    const pair = pairs.get(node.rootId);
    if (node.kind === 'variable') {
      const key = node.path[node.path.length - 1];
      values[label(node)] = {
        local: pair?.local ? enabledByKey(withoutSessionTokens([pair.local])[0].values).get(key)?.value : undefined,
        remote: pair?.remote ? enabledByKey(pair.remote.values).get(key)?.value : undefined,
      };
    } else {
      values[label(node)] = {
        local: envAsText(pair?.local ? withoutSessionTokens([pair.local])[0] : undefined),
        remote: envAsText(pair?.remote),
      };
    }
  }
  return {
    merged: applyEnvironmentChanges(localEnvs, remoteEnvs, accepted),
    incoming, keptMine, keptMineNames, incomingNames, outgoingNames, sessionTokenNames, values,
  };
}
