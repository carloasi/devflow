import type { Environment, EnvironmentValue } from '@/app/types/Environment';
import { hashContent } from '@/lib/contentHash';
import {
  applyEnvironmentChanges,
  diffEnvironments,
  enabledByKey,
  matchEnvironments,
} from '@/lib/environmentDiff';
import type { NodeHashes } from '@/lib/syncBase';

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
}

export function rebaseEnvironments(
  local: Environment[] | null | undefined,
  remote: Environment[] | null | undefined,
  base: NodeHashes | null
): EnvRebaseResult {
  const localEnvs = local ?? [];
  const remoteEnvs = remote ?? [];
  const nodes = diffEnvironments(localEnvs, remoteEnvs);
  if (nodes.length === 0) return { merged: localEnvs, incoming: 0, keptMine: 0, keptMineNames: [], incomingNames: [], outgoingNames: [] };
  // O que é seu: o mesmo critério da revisão (envKeepMineIds), menos o que
  // mudou dos dois lados (esse vai em keptMineNames).
  const mineIds = envKeepMineIds(localEnvs, remoteEnvs, base);

  // Os dois lados de cada environment, pelo id que o diff usa (o local).
  const pairs = new Map<string, EnvPair>();
  for (const pair of matchEnvironments(localEnvs, remoteEnvs)) {
    pairs.set(pair.local?.id ?? pair.remote!.id, pair);
  }

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
  return {
    merged: applyEnvironmentChanges(localEnvs, remoteEnvs, accepted),
    incoming, keptMine, keptMineNames, incomingNames, outgoingNames,
  };
}
