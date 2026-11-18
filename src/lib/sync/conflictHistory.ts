import { LazyStore } from '@tauri-apps/plugin-store';

// ─────────────────────────────────────────────────────────────────────────
// Histórico das decisões de conflito, NESTA máquina: o que foi escolhido em
// cada item que mudou dos dois lados (na revisão), e o que o push manteve
// sozinho. Serve pra entender depois "por que isto ficou assim" — o GitHub
// guarda o resultado, não a escolha.
//
// Arquivo próprio (o localStorage é cota compartilhada), só os mais recentes.
// ─────────────────────────────────────────────────────────────────────────

export type ConflictChoice = 'mine' | 'github' | 'merged' | 'kept-mine-auto';

export interface ConflictDecision {
  /** ISO. */
  at: string;
  workspace: string;
  /** Caminho legível do item ("Sprints / Flow 04 / Token v1"). */
  item: string;
  choice: ConflictChoice;
  /** Campos envolvidos, quando se sabe. */
  fields?: string[];
}

const MAX_ENTRIES = 300;
const KEY = 'entries';
const store = new LazyStore('conflict-history.json', { autoSave: 300 });

/** Mais recentes primeiro, já cortado no limite. Pura — exportada pros testes. */
export function appendDecisions(current: ConflictDecision[], added: ConflictDecision[]): ConflictDecision[] {
  return [...added, ...current].slice(0, MAX_ENTRIES);
}

export async function loadConflictHistory(): Promise<ConflictDecision[]> {
  try {
    const entries = await store.get<ConflictDecision[]>(KEY);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
}

// Uma gravação por vez: ler-somar-gravar em paralelo (duas revisões
// seguidas, o relatório do push logo depois) fazia a segunda partir do
// histórico de antes da primeira — e as decisões da primeira sumiam.
let writing: Promise<void> = Promise.resolve();

export function recordConflictDecisions(added: ConflictDecision[]): Promise<void> {
  if (added.length === 0) return writing;
  writing = writing.then(async () => {
    try {
      await store.set(KEY, appendDecisions(await loadConflictHistory(), added));
    } catch (e) {
      // Perder o histórico não pode atrapalhar a sincronização.
      console.log('Could not record the conflict history:', e);
    }
  });
  return writing;
}
