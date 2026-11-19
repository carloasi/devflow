import { useSyncExternalStore } from 'react';
import type { RemoteChangeItem } from './remoteChangeAlert';

// ─────────────────────────────────────────────────────────────────────────
// A janela "ver a diferença" (formato de três painéis do Visual Studio)
// aberta de QUALQUER aviso de merge: o toast de mudança no GitHub, o
// relatório do merge, a prévia do push. Esses avisos moram em lugares
// diferentes (um toast nem fica montado na árvore do app), então a janela é
// uma só, montada no layout (MergeDiffHost), e quem quer abri-la chama
// openMergeDiff — sem Provider, como o idioma (lib/i18n/language).
// ─────────────────────────────────────────────────────────────────────────

export interface MergeDiffRequest {
  title: string;
  subtitle?: string;
  items: RemoteChangeItem[];
  /** Item aberto primeiro. */
  focusId?: string;
  /** Workspace dos itens — a edição à mão vale só pra revisão dele. */
  workspace?: string;
  /** Ação de quem abriu (ex. "Resolver agora" do aviso), no rodapé da janela. */
  action?: { label: string; onClick: () => void };
}

let current: MergeDiffRequest | null = null;
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

export function openMergeDiff(request: MergeDiffRequest): void {
  current = request;
  emit();
}

export function closeMergeDiff(): void {
  current = null;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useMergeDiff(): MergeDiffRequest | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
