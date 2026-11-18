import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Tab } from '@/app/types/Tab';
import { sameContent } from '@/lib/canonicalCompare';

// ─────────────────────────────────────────────────────────────────────────
// Abas abertas depois de um merge ou pull.
//
// A aba é uma CÓPIA do item (url, headers, body...) feita quando foi aberta.
// O merge trocava o item na árvore e a aba continuava mostrando a versão de
// antes, e o Save seguinte gravava essa versão velha por cima do que tinha
// acabado de vir do GitHub.
//
// Agora, quando a árvore é trocada por uma sincronização:
//   • aba sem edição de um item que mudou → recarrega com a versão nova,
//     mantendo a resposta, a sub-aba e o grupo;
//   • aba com edição não salva → não é tocada (seria perder trabalho); quem
//     chama avisa e oferece recarregar.
// ─────────────────────────────────────────────────────────────────────────

/** O que da aba é a request (vem do item) — o que o merge pode ter mudado. */
function tabFacing(item: CollectionItem) {
  return {
    name: item.name,
    method: item.method,
    request: item.request,
    example: item.example,
    protocol: item.protocol,
    grpc: item.grpc,
  };
}

function indexTree(roots: CollectionItem[] | null | undefined): Map<string, CollectionItem> {
  const out = new Map<string, CollectionItem>();
  const walk = (items: CollectionItem[] | undefined) => {
    for (const item of items ?? []) {
      if (!item?.id) continue;
      out.set(item.id, item);
      walk(item.item);
    }
  };
  walk(roots ?? []);
  return out;
}

/** A aba reconstruída a partir do item, sem perder o que é só da aba. */
export function reloadedTab(tab: Tab, item: CollectionItem, build: (item: CollectionItem) => Tab): Tab {
  const fresh = build(item);
  return {
    ...fresh,
    response: tab.response,
    responseTime: tab.responseTime,
    testResults: tab.testResults,
    activeRequestTab: tab.activeRequestTab,
    groupId: tab.groupId,
    ...(tab.grpcResult !== undefined ? { grpcResult: tab.grpcResult } : {}),
    ...(tab.grpcStream !== undefined ? { grpcStream: tab.grpcStream } : {}),
    isDirty: false,
  };
}

export interface TabsAfterSync {
  tabs: Tab[];
  /** Recarregadas com a versão nova. */
  reloaded: Tab[];
  /** Mudaram na sincronização, mas têm edição não salva: ficaram como estavam. */
  dirty: Tab[];
}

/**
 * As abas depois de a árvore passar de `before` para `after` por uma
 * sincronização. Só mexe nas abas cujo item mudou; item apagado deixa a aba
 * como está (fechar seria perder a resposta sem aviso).
 */
export function tabsAfterSync(
  tabs: Tab[],
  before: CollectionItem[] | null | undefined,
  after: CollectionItem[] | null | undefined,
  build: (item: CollectionItem) => Tab
): TabsAfterSync {
  const prev = indexTree(before);
  const next = indexTree(after);
  const reloaded: Tab[] = [];
  const dirty: Tab[] = [];
  const out = tabs.map(tab => {
    const now = next.get(tab.id);
    if (!now) return tab;
    const was = prev.get(tab.id);
    if (was && sameContent(tabFacing(was), tabFacing(now))) return tab;
    if (tab.isDirty) {
      dirty.push(tab);
      return tab;
    }
    const fresh = reloadedTab(tab, now, build);
    reloaded.push(fresh);
    return fresh;
  });
  return { tabs: reloaded.length > 0 ? out : tabs, reloaded, dirty };
}
