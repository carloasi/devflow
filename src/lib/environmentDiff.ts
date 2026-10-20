import type { Environment, EnvironmentValue } from '@/app/types/Environment';
import type { DiffNode, FieldDiff } from './collectionDiff';

// ─────────────────────────────────────────────────────────────────────────
// Diff de environments contra o que está no GitHub.
//
// Devolve os mesmos DiffNode do diff de collections, de propósito: a tela de
// comparação já sabe agrupar, marcar conflito, deixar editar o valor final e
// aplicar só o selecionado. Um segundo componente só para variáveis
// duplicaria tudo isso — e as duas telas divergiriam no primeiro ajuste.
//
// A identidade de uma variável é a KEY, não o id: o pull regenera os ids dos
// valores (crypto.randomUUID em handlePullWorkspaceData), então comparar por
// id acusaria "tudo diferente" em toda sincronização.
// ─────────────────────────────────────────────────────────────────────────

const nodeId = (envId: string, key: string) => `${envId}:${key}`;

/** Só a entrada habilitada de cada key — a mesma regra do lib/envMap. */
function enabledByKey(values: EnvironmentValue[] | undefined): Map<string, EnvironmentValue> {
  const map = new Map<string, EnvironmentValue>();
  for (const v of values ?? []) {
    if (!v.key || !v.enabled) continue;
    if (!map.has(v.key)) map.set(v.key, v);
  }
  return map;
}

function fieldsOf(local: EnvironmentValue, remote: EnvironmentValue): FieldDiff[] {
  const out: FieldDiff[] = [];
  if (String(local.value ?? '') !== String(remote.value ?? '')) {
    out.push({ field: 'value', local: local.value, remote: remote.value });
  }
  if ((local.description ?? '') !== (remote.description ?? '')) {
    out.push({ field: 'description', local: local.description, remote: remote.description });
  }
  return out;
}

/**
 * Casa os environments por id, com o nome como alternativa.
 *
 * Mesma razão do diff de collections: duas máquinas que criaram "o mesmo"
 * environment têm ids diferentes, e sem o nome o diff mostraria um para
 * adicionar e um para remover em vez de uma comparação.
 */
function matchEnvironments(local: Environment[], remote: Environment[]) {
  const pairs: { local?: Environment; remote?: Environment }[] = [];
  const used = new Set<string>();

  for (const l of local) {
    const byId = remote.find(r => r.id === l.id && !used.has(r.id));
    const byName = byId ?? remote.find(r => r.name === l.name && !used.has(r.id));
    if (byName) used.add(byName.id);
    pairs.push({ local: l, remote: byName });
  }
  for (const r of remote) {
    if (!used.has(r.id)) pairs.push({ remote: r });
  }
  return pairs;
}

export function diffEnvironments(
  local: Environment[] | undefined | null,
  remote: Environment[] | undefined | null
): DiffNode[] {
  const out: DiffNode[] = [];

  for (const pair of matchEnvironments(local ?? [], remote ?? [])) {
    const env = pair.local ?? pair.remote!;
    const envId = pair.local?.id ?? pair.remote!.id;

    // Environment inteiro novo ou removido entra como UM nó: listar as 155
    // variáveis dele uma a uma afogaria o resto da comparação.
    if (!pair.remote || !pair.local) {
      out.push({
        id: envId,
        path: [env.name],
        rootId: envId,
        ancestorIds: [],
        kind: 'folder',
        change: pair.remote ? 'added' : 'removed',
        fields: [],
      });
      continue;
    }

    const localValues = enabledByKey(pair.local.values);
    const remoteValues = enabledByKey(pair.remote.values);

    for (const [key, localValue] of localValues) {
      const remoteValue = remoteValues.get(key);
      if (!remoteValue) {
        out.push({
          id: nodeId(envId, key),
          path: [pair.local.name, key],
          rootId: envId,
          ancestorIds: [envId],
          kind: 'variable',
          change: 'removed',
          fields: [],
        });
        continue;
      }
      const fields = fieldsOf(localValue, remoteValue);
      if (fields.length > 0) {
        out.push({
          id: nodeId(envId, key),
          path: [pair.local.name, key],
          rootId: envId,
          ancestorIds: [envId],
          kind: 'variable',
          change: 'modified',
          fields,
        });
      }
    }

    for (const key of remoteValues.keys()) {
      if (localValues.has(key)) continue;
      out.push({
        id: nodeId(envId, key),
        path: [pair.local.name, key],
        rootId: envId,
        ancestorIds: [envId],
        kind: 'variable',
        change: 'added',
        fields: [],
      });
    }
  }

  return out;
}

/**
 * Aplica só as variáveis escolhidas.
 *
 * Mexe apenas na entrada HABILITADA de cada key, preservando as duplicatas
 * desabilitadas, a descrição e o id local — é a mesma regra que o resto do
 * app usa pra escrever em environment (ver patchEnvironmentVariables). Trocar
 * o array inteiro pelo remoto apagaria o valor arquivado numa duplicata.
 */
export function applyEnvironmentChanges(
  local: Environment[],
  remote: Environment[],
  selected: ReadonlySet<string>,
  overrides: Record<string, Record<string, unknown>> = {}
): Environment[] {
  const pairs = matchEnvironments(local, remote);
  const result: Environment[] = [];

  for (const pair of pairs) {
    const envId = pair.local?.id ?? pair.remote!.id;

    if (!pair.local) {
      // Environment só no remoto: entra inteiro, ou não entra.
      if (selected.has(envId)) result.push(pair.remote!);
      continue;
    }
    if (!pair.remote) {
      // Só local: aceitar a remoção é não copiá-lo pro resultado.
      if (!selected.has(envId)) result.push(pair.local);
      continue;
    }

    const remoteValues = enabledByKey(pair.remote.values);
    const values = [...pair.local.values];
    const localIndex = new Map<string, number>();
    values.forEach((v, i) => {
      if (v.key && v.enabled && !localIndex.has(v.key)) localIndex.set(v.key, i);
    });

    const valueFor = (key: string, fallback: string) => {
      const edited = overrides[nodeId(envId, key)]?.value;
      return edited === undefined ? fallback : String(edited);
    };

    for (const [key, remoteValue] of remoteValues) {
      if (!selected.has(nodeId(envId, key))) continue;
      const at = localIndex.get(key);
      const next = valueFor(key, String(remoteValue.value ?? ''));
      if (at === undefined) {
        values.push({ ...remoteValue, id: crypto.randomUUID(), value: next, enabled: true });
      } else {
        values[at] = { ...values[at], value: next, description: remoteValue.description ?? values[at].description };
      }
    }

    // Removidas: existem aqui e não lá. Aceitar tira só a entrada habilitada.
    for (const [key, at] of localIndex) {
      if (remoteValues.has(key)) continue;
      if (!selected.has(nodeId(envId, key))) continue;
      values[at] = { ...values[at], __removed: true } as EnvironmentValue & { __removed: true };
    }

    result.push({
      ...pair.local,
      values: values.filter(v => !(v as { __removed?: boolean }).__removed),
    });
  }

  return result;
}
