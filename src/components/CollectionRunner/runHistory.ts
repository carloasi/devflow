import { LazyStore } from '@tauri-apps/plugin-store';
import type { RunEntry } from './runCollectionRequest';

// ─────────────────────────────────────────────────────────────────────────
// Guarda o último run de cada collection, pra que fechar o painel não jogue
// fora o resultado. Antes, o Run era efêmero: quem fechasse a janela sem
// copiar o relatório perdia tudo e tinha que rodar o fluxo de novo — caro
// quando são 12 requests encadeadas que levam meio minuto.
//
// Arquivo próprio, e não localStorage: lá os ~5MB são do app INTEIRO, e por
// isso o corpo das respostas precisava ser cortado em 10k para não estourar
// a cota e derrubar as gravações de outras features. Numa resposta de 15KB
// isso já aparecia como "Showing 9.8 KB of 15.2 KB" ao reabrir o painel. Em
// arquivo o corte deixa de ser necessário, e o run restaurado passa a ser
// igual ao que estava na tela.
// ─────────────────────────────────────────────────────────────────────────

export interface StoredRun {
  collectionId: string;
  collectionName: string;
  /** ISO. É o que o painel mostra como "último run · <quando>". */
  finishedAt: string;
  /** ISO. Ausente em runs gravados antes do export existir. */
  startedAt?: string;
  /** Nome do environment usado, pro export dizer contra o quê o fluxo rodou. */
  environmentName?: string;
  entries: RunEntry[];
  /** Entradas foram descartadas pra caber na cota; o painel avisa. */
  truncated?: boolean;
}

// autoSave com debounce: um run grava uma vez no fim, mas execuções em
// sequência não precisam bater no disco a cada uma.
const store = new LazyStore('runner-history.json', { autoSave: 300 });

const KEY_PREFIX = 'lastRun:';

// Teto de segurança, não de cota: em arquivo não há o limite que havia no
// localStorage, mas um run com respostas gigantes também não deve virar um
// arquivo de centenas de MB.
export interface TrimLimits {
  budget: number;
  storedBodyMax: number;
  smallSnippet: number;
  maxEntries: number;
}

// Injetáveis pra que o teste exercite a DEGRADAÇÃO com números pequenos, em
// vez de precisar montar 20MB de dados — e pra que ajustar um limite não
// invalide testes que são sobre a ordem dos cortes, não sobre o valor deles.
export const DEFAULT_TRIM_LIMITS: TrimLimits = {
  budget: 20_000_000,
  storedBodyMax: 2_000_000,
  smallSnippet: 400,
  maxEntries: 200,
};

const size = (run: StoredRun): number => JSON.stringify(run).length;

// O corpo completo pode ter 200k (o limite que o MCP usa). Guardar inteiro
// estouraria a cota com dois ou três requests, e descartar fazia o run
// restaurado exibir 2000 caracteres de uma resposta que, na sessão viva,
// aparecia por completo. 10k cobre com folga a resposta de API típica.
function capFullBody(entry: RunEntry, max: number): RunEntry {
  const body = entry.outcome?.fullResponseBody;
  if (!body || body.length <= max) return entry;
  return { ...entry, outcome: { ...entry.outcome!, fullResponseBody: body.slice(0, max) } };
}

function stripFullBody(entry: RunEntry): RunEntry {
  if (!entry.outcome?.fullResponseBody) return entry;
  const { fullResponseBody: _dropped, ...outcome } = entry.outcome;
  return { ...entry, outcome };
}

function capSnippet(entry: RunEntry, max: number): RunEntry {
  const snippet = entry.outcome?.responseBodySnippet;
  if (!snippet || snippet.length <= max) return entry;
  return {
    ...entry,
    outcome: { ...entry.outcome!, responseBodySnippet: snippet.slice(0, max) },
  };
}

function dropSnippet(entry: RunEntry): RunEntry {
  if (!entry.outcome?.responseBodySnippet) return entry;
  const { responseBodySnippet: _dropped, ...outcome } = entry.outcome;
  return { ...entry, outcome };
}

/**
 * Reduz o run até caber no orçamento, perdendo o detalhe menos valioso
 * primeiro. A ordem é deliberada: status, tempo e testes de TODAS as linhas
 * valem mais que o corpo de resposta de algumas — o placar é o que se olha
 * primeiro ao reabrir.
 */
export function trimRunForStorage(run: StoredRun, limits: TrimLimits = DEFAULT_TRIM_LIMITS): StoredRun {
  const { budget, storedBodyMax, smallSnippet, maxEntries } = limits;
  const base: StoredRun = { ...run, entries: run.entries.map(e => capFullBody(e, storedBodyMax)) };
  if (size(base) <= budget) return base;

  // O corpo completo é o primeiro a cair: dele ainda sobra o snippet, então
  // a resposta não some da tela — só volta a aparecer recortada.
  const noFull: StoredRun = { ...base, entries: base.entries.map(stripFullBody) };
  if (size(noFull) <= budget) return noFull;

  const shorter: StoredRun = { ...noFull, entries: noFull.entries.map(e => capSnippet(e, smallSnippet)) };
  if (size(shorter) <= budget) return shorter;

  // A partir de noFull, não de base: senão este passo devolveria o corpo
  // completo que o anterior acabou de descartar.
  const noBodies: StoredRun = { ...noFull, entries: noFull.entries.map(dropSnippet) };
  if (size(noBodies) <= budget) return noBodies;

  // Só sobra cortar linhas. Mantém as PRIMEIRAS: o Runner roda um fluxo em
  // ordem, e quando algo quebra no meio o começo é o que explica o resto.
  return { ...noBodies, entries: noBodies.entries.slice(0, maxEntries), truncated: true };
}

export async function saveLastRun(run: StoredRun): Promise<void> {
  try {
    await store.set(KEY_PREFIX + run.collectionId, trimRunForStorage(run));
  } catch (e) {
    // Perder o histórico não pode derrubar o run que acabou de terminar: ele
    // continua na tela, só não sobrevive ao fechar.
    console.log("Could not store the last run:", e);
  }
}

export async function loadLastRun(collectionId: string): Promise<StoredRun | null> {
  try {
    const parsed = await store.get<StoredRun>(KEY_PREFIX + collectionId);
    // O formato pode ter mudado entre versões; um objeto sem entries
    // renderizaria quebrado em vez de simplesmente não restaurar nada.
    if (!parsed || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Todos os runs guardados, do mais recente para o mais antigo.
 *
 * Lista as chaves porque o armazenamento é indexado por collection, e quem
 * pergunta "o que rodou por último?" — o agente do MCP — não sabe de qual
 * collection se trata. Era exatamente o caso em que ele pedia pro usuário
 * executar de novo algo que já estava executado.
 */
export async function loadAllLastRuns(): Promise<StoredRun[]> {
  try {
    const keys = (await store.keys()).filter(k => k.startsWith(KEY_PREFIX));
    const runs = await Promise.all(keys.map(k => loadLastRun(k.slice(KEY_PREFIX.length))));
    return runs
      .filter((r): r is StoredRun => r !== null)
      .sort((a, b) => (a.finishedAt < b.finishedAt ? 1 : -1));
  } catch (e) {
    console.log("Could not list stored runs:", e);
    return [];
  }
}

export async function clearLastRun(collectionId: string): Promise<void> {
  try {
    await store.delete(KEY_PREFIX + collectionId);
  } catch (e) {
    console.log("Could not clear the last run:", e);
  }
}
