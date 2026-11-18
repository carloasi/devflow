import { stripStarredFlags } from '@/components/collection-tree/utils/tree.utils';

// ─────────────────────────────────────────────────────────────────────────
// O QUE um push vai gravar no GitHub — separado de COMO grava.
//
// Antes, cada caminho de push (workspace atual, workspace pelo menu, uma
// collection, um environment) remontava os nomes de arquivo, a checagem de
// nomes que colidem e o cálculo de "arquivos que sobraram lá" dentro do
// próprio laço de envio. A regra do nome de arquivo de environment estava
// copiada em quatro lugares; bastava um divergir pra renomear virar "criar
// outro arquivo".
//
// Aqui fica só a decisão, sem rede: dá pra testar, e o envio (um commit só,
// ver GitHubStorageClient.commitFiles) só executa o plano.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Catálogo de marcadores do workspace. Sem o sufixo `.postman_`: não é
 * formato Postman, e a listagem do workspace procura justamente esse sufixo
 * pra achar collections e environments.
 */
export const MARKERS_FILE = 'devflow-markers.json';

/** Nome → trecho de path. A MESMA regra em todo lugar que grava no GitHub. */
export function sanitizeFileName(raw: string | undefined | null): string {
  return (raw || 'collection').toLowerCase().replace(/[^a-z0-9-_]/g, '-');
}

export function collectionNameOf(col: unknown): string {
  const c = col as { name?: string; info?: { name?: string } } | null;
  return c?.info?.name || c?.name || 'collection';
}

export function collectionFilePath(wsRemotePath: string, col: unknown): string {
  return `${wsRemotePath}/${sanitizeFileName(collectionNameOf(col))}.postman_collection.json`;
}

export function environmentFilePath(wsRemotePath: string, env: unknown): string {
  const name = (env as { name?: string } | null)?.name;
  const file = name ? `${sanitizeFileName(name)}.postman_environment.json` : 'environment.postman_environment.json';
  return `${wsRemotePath}/environments/${file}`;
}

export function markersFilePath(wsRemotePath: string): string {
  return `${wsRemotePath}/${MARKERS_FILE}`;
}

/**
 * Nomes diferentes podem virar o MESMO arquivo — "API's Tests" e "API S
 * Tests" viram os dois "api-s-tests". Como os ids são diferentes, o GitHub
 * nunca vê isso como conflito: quem fosse gravado por último apagaria o
 * outro em silêncio. Detecta ANTES de gravar.
 */
export function findNameCollisions<T>(items: T[], pathOf: (item: T) => string): T[][] {
  const byPath = new Map<string, T[]>();
  for (const item of items) {
    if (!item) continue;
    const key = pathOf(item);
    const list = byPath.get(key) ?? [];
    list.push(item);
    byPath.set(key, list);
  }
  return [...byPath.values()].filter((list) => list.length > 1);
}

export type PlannedKind = 'collection' | 'environment' | 'markers';

export interface PlannedFile {
  path: string;
  kind: PlannedKind;
  /** Nome legível, pra mensagens. */
  name: string;
  /** Conteúdo ainda em claro — quem grava é quem cifra. */
  content: unknown;
}

export interface PushPlan {
  files: PlannedFile[];
  /**
   * Grupos de nomes que gravariam no mesmo arquivo. Qualquer grupo aqui
   * cancela o push inteiro: gravar o resto deixaria o workspace pela metade.
   */
  collisions: { kind: 'collection' | 'environment'; names: string[] }[];
  /** Existem no GitHub e não correspondem a nada daqui: apagados aqui. */
  stalePaths: string[];
}

export function buildPushPlan(input: {
  wsRemotePath: string;
  collections: unknown[];
  environments: unknown[];
  /** `null` = não enviar o catálogo (push que não é do workspace inteiro). */
  markers: unknown[] | null;
  /** Collections e environments que a listagem do GitHub tem hoje. */
  existingPaths: string[];
}): PushPlan {
  const { wsRemotePath } = input;
  const collections = input.collections.filter(Boolean);
  const environments = input.environments.filter(Boolean);

  const collisions: PushPlan['collisions'] = [
    ...findNameCollisions(collections, (c) => collectionFilePath(wsRemotePath, c)).map((group) => ({
      kind: 'collection' as const,
      names: group.map(collectionNameOf),
    })),
    ...findNameCollisions(environments, (e) => environmentFilePath(wsRemotePath, e)).map((group) => ({
      kind: 'environment' as const,
      names: group.map((e) => (e as { name?: string })?.name || 'environment'),
    })),
  ];

  const files: PlannedFile[] = [
    ...collections.map((col) => ({
      path: collectionFilePath(wsRemotePath, col),
      kind: 'collection' as const,
      name: collectionNameOf(col),
      // Favorito é marca local: nunca sobe (ver tree.utils).
      content: stripStarredFlags(col as Parameters<typeof stripStarredFlags>[0]),
    })),
    ...environments.map((env) => ({
      path: environmentFilePath(wsRemotePath, env),
      kind: 'environment' as const,
      name: (env as { name?: string })?.name || 'environment',
      content: env,
    })),
  ];

  // Catálogo vazio também sobe: "nunca teve marcador" e "apagaram todos"
  // chegam aqui iguais, e pular o segundo ressuscitaria os antigos no pull.
  if (input.markers) {
    files.push({
      path: markersFilePath(wsRemotePath),
      kind: 'markers',
      name: 'markers',
      content: { markers: input.markers },
    });
  }

  const planned = new Set(files.map((f) => f.path));
  const stalePaths = input.existingPaths.filter((path) => !planned.has(path));

  return { files, collisions, stalePaths };
}

/**
 * Arquivos que sobraram lá mas são RENOMEAÇÕES: tudo o que eles guardam
 * (pelos ids) está sendo gravado neste push com outro nome. Apagá-los não
 * perde nada — e mantê-los deixava dois arquivos com o mesmo id no GitHub,
 * e o pull seguinte podia trazer a versão velha por cima da nova.
 * `idsOf` = ids das collections/environments de cada arquivo (vazio ou
 * ausente = não se sabe: fica de fora, e a pessoa decide como antes).
 */
export function renamedStalePaths(
  stalePaths: string[],
  idsOf: (path: string) => string[] | undefined,
  writtenIds: ReadonlySet<string>
): string[] {
  return stalePaths.filter((path) => {
    const ids = idsOf(path);
    return !!ids && ids.length > 0 && ids.every((id) => writtenIds.has(id));
  });
}

/** Id de uma collection ou environment como está no arquivo. */
export function rootIdOf(item: unknown): string | undefined {
  const c = item as { id?: unknown; info?: { _postman_id?: unknown } } | null;
  const id = c?.id ?? c?.info?._postman_id;
  return typeof id === 'string' ? id : undefined;
}

/**
 * Grupos de arquivos que guardam o mesmo id (uma renomeação que manteve o
 * arquivo antigo). Cada grupo tem 2+ caminhos, em ordem.
 */
export function duplicateIdGroups(idsByPath: Record<string, string[]>, paths: string[]): string[][] {
  // Union-find nos caminhos: dois arquivos com algum id em comum se juntam.
  const parent = new Map(paths.map((p) => [p, p]));
  const find = (p: string): string => {
    let root = p;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  const firstPathOf = new Map<string, string>();
  for (const path of paths) {
    for (const id of idsByPath[path] ?? []) {
      const other = firstPathOf.get(id);
      if (other === undefined) firstPathOf.set(id, path);
      else parent.set(find(path), find(other));
    }
  }
  const groups = new Map<string, string[]>();
  for (const path of paths) {
    const root = find(path);
    groups.set(root, [...(groups.get(root) ?? []), path]);
  }
  return [...groups.values()].filter((g) => g.length > 1).map((g) => [...g].sort());
}

/**
 * De um grupo de arquivos com o mesmo id, o que vale: o do commit mais
 * recente. `null` quando falta a data de algum (não dá pra decidir sem
 * adivinhar — quem chama não aplica nada).
 */
export function newestOf(group: string[], dateOf: (path: string) => string | undefined): string | null {
  let best: string | null = null;
  let bestTime = -Infinity;
  for (const path of group) {
    const time = Date.parse(dateOf(path) ?? '');
    if (Number.isNaN(time)) return null;
    if (time > bestTime) {
      best = path;
      bestTime = time;
    }
  }
  return best;
}

/** Mensagem de commit do push de um workspace — em inglês, como o resto. */
export function pushCommitMessage(workspaceName: string, plan: PushPlan, removed: number): string {
  const count = (kind: PlannedKind) => plan.files.filter((f) => f.kind === kind).length;
  const parts = [
    `${count('collection')} collection(s)`,
    `${count('environment')} environment(s)`,
    removed > 0 ? `${removed} file(s) removed` : null,
  ].filter(Boolean);
  return `sync(${workspaceName}): ${parts.join(', ')}`;
}

export function collisionMessage(collisions: PushPlan['collisions']): string {
  const groups = collisions.map((g) => g.names.map((n) => `"${n}"`).join(' / ')).join('; ');
  return `Push cancelled: these names are too similar and would overwrite each other on GitHub: ${groups}. Rename one of them first.`;
}
