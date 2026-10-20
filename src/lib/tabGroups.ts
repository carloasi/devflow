import type { Tab } from '@/app/types/Tab';

// ─────────────────────────────────────────────────────────────────────────
// Agrupamento de abas na própria barra, como o Chrome faz: uma pílula
// colorida com nome, as abas do grupo logo atrás dela, e clique na pílula
// para recolher.
//
// Não confundir com os "session groups", que são outra coisa: lá se guarda um
// CONJUNTO de abas para reabrir depois. Aqui as abas continuam abertas; o
// grupo só organiza a barra.
//
// A regra que amarra tudo é a CONTIGUIDADE: as abas de um grupo ficam sempre
// lado a lado. Sem isso a pílula não teria onde começar e terminar, e um
// grupo "partido" apareceria como dois. Toda operação que mexe em grupo
// reordena para manter isso — é o que este módulo garante, e por isso ele é
// puro e testado.
// ─────────────────────────────────────────────────────────────────────────

export interface TabGroup {
  id: string;
  name: string;
  /** Índice em GROUP_COLORS. */
  color: number;
  collapsed?: boolean;
}

// Paleta no espírito da do Chrome: tons distinguíveis entre si e legíveis
// sobre o fundo escuro do app.
export const GROUP_COLORS = [
  '#5BA4CF', // azul
  '#6BCB77', // verde
  '#E5C07B', // amarelo
  '#F0883E', // laranja
  '#E06C75', // vermelho
  '#C678DD', // roxo
  '#56B6C2', // ciano
  '#ABB2BF', // cinza
] as const;

export function colorOf(group: TabGroup): string {
  return GROUP_COLORS[group.color % GROUP_COLORS.length];
}

/** Próxima cor livre, para que dois grupos vizinhos não nasçam iguais. */
export function nextColor(groups: TabGroup[]): number {
  const used = new Set(groups.map(g => g.color % GROUP_COLORS.length));
  for (let i = 0; i < GROUP_COLORS.length; i++) {
    if (!used.has(i)) return i;
  }
  return groups.length % GROUP_COLORS.length;
}

// ── Modelo de renderização ───────────────────────────────────────────────

export type TabSegment =
  | { kind: 'tab'; tab: Tab }
  | { kind: 'group'; group: TabGroup; tabs: Tab[] };

/**
 * Converte a lista plana em segmentos para a barra desenhar.
 *
 * Assume contiguidade; se por algum motivo ela quebrar (dado antigo, bug),
 * cada trecho vira um segmento próprio em vez de o render explodir. Barra
 * estranha é melhor que barra vazia.
 */
export function buildSegments(tabs: Tab[], groups: TabGroup[]): TabSegment[] {
  const byId = new Map(groups.map(g => [g.id, g]));
  const segments: TabSegment[] = [];

  for (const tab of tabs) {
    const group = tab.groupId ? byId.get(tab.groupId) : undefined;
    if (!group) {
      segments.push({ kind: 'tab', tab });
      continue;
    }

    const last = segments[segments.length - 1];
    if (last && last.kind === 'group' && last.group.id === group.id) {
      last.tabs.push(tab);
    } else {
      segments.push({ kind: 'group', group, tabs: [tab] });
    }
  }

  return segments;
}

/** Abas que a barra mostra: as de um grupo recolhido somem. */
export function visibleTabs(tabs: Tab[], groups: TabGroup[]): Tab[] {
  const collapsed = new Set(groups.filter(g => g.collapsed).map(g => g.id));
  return tabs.filter(t => !t.groupId || !collapsed.has(t.groupId));
}

// ── Operações ────────────────────────────────────────────────────────────

/**
 * Põe abas num grupo, deixando-as contíguas.
 *
 * As que entram vão para junto das que já estão no grupo (ou para a posição
 * da primeira que entrou, se o grupo é novo). Sem esse reposicionamento,
 * agrupar duas abas distantes deixaria tudo entre elas dentro da pílula.
 */
export function assignToGroup(tabs: Tab[], tabIds: string[], groupId: string): Tab[] {
  const moving = new Set(tabIds);
  if (moving.size === 0) return tabs;

  const anchor = tabs.findIndex(t => t.groupId === groupId || moving.has(t.id));
  if (anchor === -1) return tabs;

  const members: Tab[] = [];
  const others: Tab[] = [];
  for (const tab of tabs) {
    if (tab.groupId === groupId || moving.has(tab.id)) {
      members.push(moving.has(tab.id) ? { ...tab, groupId } : tab);
    } else {
      others.push(tab);
    }
  }

  // `anchor` é índice na lista original; converte para a posição equivalente
  // em `others` contando quantos não-membros vinham antes dele.
  const before = tabs.slice(0, anchor).filter(t => !(t.groupId === groupId || moving.has(t.id))).length;
  return [...others.slice(0, before), ...members, ...others.slice(before)];
}

/** Tira a aba do grupo; ela fica onde está, agora solta. */
export function removeFromGroup(tabs: Tab[], tabId: string): Tab[] {
  return tabs.map(tab => {
    if (tab.id !== tabId || !tab.groupId) return tab;
    const next = { ...tab };
    delete next.groupId;
    return next;
  });
}

/** Desfaz o grupo inteiro, mantendo as abas abertas e na mesma ordem. */
export function ungroup(tabs: Tab[], groupId: string): Tab[] {
  return tabs.map(tab => {
    if (tab.groupId !== groupId) return tab;
    const next = { ...tab };
    delete next.groupId;
    return next;
  });
}

export function tabsOfGroup(tabs: Tab[], groupId: string): Tab[] {
  return tabs.filter(t => t.groupId === groupId);
}

/**
 * Descarta grupos sem nenhuma aba.
 *
 * Fechar a última aba de um grupo tem que apagar o grupo: senão ele fica
 * invisível na barra mas vivo no disco, e reaparece quando uma aba cair nele
 * por acaso — um id reaproveitado basta.
 */
export function pruneEmptyGroups(tabs: Tab[], groups: TabGroup[]): TabGroup[] {
  const alive = new Set(tabs.map(t => t.groupId).filter(Boolean));
  return groups.filter(g => alive.has(g.id));
}

/**
 * Nome padrão de grupo novo: "Group 1", "Group 2"…
 *
 * Numerado em vez de vazio porque a pílula sem texto vira um ponto colorido
 * que não dá para distinguir de outro.
 */
export function defaultGroupName(groups: TabGroup[]): string {
  const taken = new Set(groups.map(g => g.name));
  for (let n = 1; n <= groups.length + 1; n++) {
    const candidate = `Group ${n}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `Group ${groups.length + 1}`;
}

/**
 * Reordenação vinda do arrastar: a aba herda o grupo do vizinho.
 *
 * É como o Chrome se comporta — soltar entre duas abas de um grupo põe a aba
 * dentro dele; soltar fora tira. Sem isso, arrastar para o meio de um grupo
 * deixaria uma aba solta no meio da pílula, quebrando a contiguidade que o
 * resto do módulo mantém.
 */
export function regroupAfterReorder(tabs: Tab[], movedId: string): Tab[] {
  const index = tabs.findIndex(t => t.id === movedId);
  if (index === -1) return tabs;

  const previous = tabs[index - 1];
  const next = tabs[index + 1];

  // Só assume o grupo quando os DOIS vizinhos são dele: no meio não há
  // dúvida. Na borda, a aba fica de fora, que é a leitura menos destrutiva.
  const inside = previous?.groupId && previous.groupId === next?.groupId ? previous.groupId : undefined;

  return tabs.map((tab, i) => {
    if (i !== index) return tab;
    if (inside) return { ...tab, groupId: inside };
    const next = { ...tab };
    delete next.groupId;
    return next;
  });
}
