import { useSyncExternalStore } from 'react';

// ─────────────────────────────────────────────────────────────────────────
// Central de Sincronização: quem abre e o que ela já sabe.
//
// Abre de vários lugares (o indicador da barra de título, a árvore, o card
// de mudança no GitHub), e o card nem fica montado na árvore do app — por
// isso um store, como o da janela de diferença (mergeDiffStore), e não um
// Provider.
//
// Guarda também quantos conflitos a última verificação achou por workspace:
// o indicador ⚠N da barra mostra esse número sem precisar ler o GitHub.
// ─────────────────────────────────────────────────────────────────────────

export type SyncCenterTab = 'incoming' | 'outgoing' | 'conflicts';

/** Os botões da Central: receber, enviar, os dois, ou abrir a revisão dos conflitos. */
export type SyncAction = 'receive' | 'send' | 'all' | 'resolve';

/** Uma mensagem que o push ou o pull deu durante a ação (sucesso, aviso ou erro). */
export interface SyncStatusMessage {
  type: 'success' | 'info' | 'error';
  message: string;
  /** Ação oferecida junto, como o "Desfazer" do pull. */
  action?: { label: string; run: () => void };
}

/**
 * Como a ação terminou:
 *   'review' = parou na tela de revisão (conflito de verdade);
 *   'failed' = algum passo deu erro (a mensagem está em `messages`);
 *   'done'   = terminou.
 *
 * `messages` é o que o push e o pull disseram no caminho. Antes isso ia só
 * pra linha de status do painel do GitHub — que, com a Central aberta, está
 * fechado: um push que falhava (rede, colisão, "Push cancelled") parecia não
 * ter feito nada.
 */
export interface SyncActionResult {
  result: 'done' | 'review' | 'failed';
  messages: SyncStatusMessage[];
  /**
   * "Sincronizar tudo" que parou num conflito ainda no RECEBER: o envio não
   * chegou a rodar, e deve continuar depois da revisão.
   */
  continueSend?: boolean;
}

/** As mensagens sem as ações (o "Desfazer" de um pull já não vale depois da revisão). */
export function withoutActions(messages: SyncStatusMessage[]): SyncStatusMessage[] {
  return messages.map(({ type, message }) => ({ type, message }));
}

/**
 * Escopo do envio: a Central filtrada (collection, pasta, request ou
 * environment), ou o "Enviar" de uma linha da lista.
 */
export interface SyncActionScope {
  rootId?: string;
  /** Pasta ou request dentro de uma collection. */
  itemId?: string;
  environmentName?: string;
  /** Nome pra mensagem quando o item não existe mais aqui. */
  label?: string;
}

/** Recorte da Central: uma collection, uma pasta/request dentro dela, ou um environment. */
export interface SyncCenterFilter {
  rootId?: string;
  /** Pasta ou request: só ela e o que está dentro. */
  itemId?: string;
  /** Caminho de nomes até a pasta/request (inclusive) — pega também o que é novo lá dentro. */
  pathPrefix?: string[];
  environmentName?: string;
  label?: string;
}

/**
 * Por cima das mensagens, pra filtrar: o progresso ("Checking GitHub…",
 * "Encrypting and sending files…") não é resultado, e na faixa da Central
 * empurrava pra fora o que importava (o "Pulled N change(s) [Desfazer]").
 */
export function resultMessages(result: SyncActionResult): SyncStatusMessage[] {
  if (result.result === 'failed') return result.messages.filter(m => m.type === 'error');
  return result.messages.filter(m => m.type !== 'info' || !/(\.\.\.|…)\s*$/.test(m.message));
}

// ── Captura das mensagens de uma ação ───────────────────────────────────
// O push e o pull avisam em lugares diferentes (status do painel, toast).
// Enquanto uma ação da Central roda, tudo que eles reportam aqui é guardado
// e volta no resultado — sem mudar a assinatura de cada função de envio.
let capture: SyncStatusMessage[] | null = null;

export function reportSyncStatus(
  type: SyncStatusMessage['type'],
  message: string,
  action?: SyncStatusMessage['action']
): void {
  if (!message) return;
  capture?.push({ type, message, ...(action ? { action } : {}) });
}

/** Uma ação da Central (ou o retorno dela depois da revisão) está guardando mensagens? */
export function isCapturingSyncStatus(): boolean {
  return capture !== null;
}

/**
 * Começa a guardar. `peek` lê o que já chegou sem parar; `stop` para e
 * entrega tudo.
 */
export function captureSyncStatus(): { peek: () => SyncStatusMessage[]; stop: () => SyncStatusMessage[] } {
  const list: SyncStatusMessage[] = [];
  capture = list;
  return {
    peek: () => [...list],
    stop: () => {
      if (capture === list) capture = null;
      return list;
    },
  };
}

// ── Cancelar a ação em curso ──────────────────────────────────────────
// O "Cancelar" da Central não interrompe no meio de uma escrita: ele levanta
// este sinal, e cada passo do pull e do push o confere num ponto SEGURO —
// antes de aplicar aqui o que veio do GitHub, antes da mescla que o push faz
// aqui, antes de criar o commit lá. O que já tinha terminado fica; o que não
// tinha começado não acontece. Nada fica pela metade.
export const SYNC_CANCELLED_MESSAGE = 'Cancelled before this step — nothing more was changed.';

export class SyncCancelledError extends Error {
  constructor() {
    super(SYNC_CANCELLED_MESSAGE);
    this.name = 'SyncCancelledError';
  }
}

let cancelRequested = false;

/** Pede pra parar no próximo ponto seguro. */
export function requestSyncCancel(): void {
  cancelRequested = true;
}

/** Zera o pedido (no começo e no fim de cada ação da Central). */
export function resetSyncCancel(): void {
  cancelRequested = false;
}

export function isSyncCancelRequested(): boolean {
  return cancelRequested;
}

/** Num ponto seguro: para aqui se pediram pra cancelar. */
export function throwIfSyncCancelled(): void {
  if (cancelRequested) throw new SyncCancelledError();
}

/**
 * O resultado de uma ação cancelada: os erros que o cancelamento causou (o
 * push diz "Push failed: Cancelled…") saem, e entra um aviso só. Puro.
 */
export function asCancelled(messages: SyncStatusMessage[], note: string): SyncActionResult {
  const kept = messages.filter(m => !m.message.includes(SYNC_CANCELLED_MESSAGE));
  return { result: 'done', messages: [...kept, { type: 'info', message: note }] };
}

// Ação em curso: a Central não fecha no Esc nem no clique fora enquanto
// isso — o push pode estar esperando uma resposta num aviso por cima dela
// ("apagar no GitHub?"), e o Esc desse aviso fecharia a Central junto.
let busy = false;
export function setSyncCenterBusy(value: boolean): void {
  busy = value;
}
export function isSyncCenterBusy(): boolean {
  return busy;
}

// O "↓N" da barra: arquivos que mudaram no GitHub desde a última
// sincronização desta máquina. A Central usa pra liberar o "Receber" mesmo
// quando o merge não acha nada a trazer (mudança igual à sua, só
// marcadores): é o pull que marca esses arquivos como lidos e zera o ↓.
const behind = new Map<string, number>();
let behindVersion = 0;

export function setRemoteBehind(workspace: string, count: number | null): void {
  if (!workspace) return;
  const before = behind.get(workspace);
  if (count === null) behind.delete(workspace);
  else behind.set(workspace, count);
  if (before !== (count ?? undefined)) {
    behindVersion++;
    emit();
  }
}

export function useRemoteBehind(workspace: string): number | null {
  useSyncExternalStore(subscribe, () => behindVersion, () => 0);
  return behind.get(workspace) ?? null;
}

export interface SyncCenterRequest {
  /** Aba aberta primeiro. */
  tab?: SyncCenterTab;
  /** Só o que é desta collection, pasta/request ou environment. */
  filter?: SyncCenterFilter;
  /** Resultado a mostrar na faixa ao abrir (a ação que terminou depois da revisão). */
  result?: SyncActionResult;
  /** Muda a cada abertura: a Central recarrega mesmo se já estava aberta. */
  nonce: number;
}

// ── Volta pra Central depois da revisão ─────────────────────────────────
// Uma ação da Central que esbarra num conflito fecha a Central e abre a
// revisão; ao aplicar, o envio continua sozinho. Antes a Central não
// voltava, e o resultado desse envio (sucesso ou erro) não aparecia em lugar
// nenhum. Fica guardado aqui como reabri-la e o que já foi dito no caminho.
export interface SyncCenterResume {
  tab?: SyncCenterTab;
  filter?: SyncCenterFilter;
  messages: SyncStatusMessage[];
  /** Continuar o envio de "Sincronizar tudo" depois da revisão. */
  continueSend?: boolean;
  /** A Central mostrava algo em "Para enviar" (ver runSyncAction). */
  outgoing?: boolean;
}
let resume: SyncCenterResume | null = null;

export function markResumeAfterReview(value: SyncCenterResume): void {
  resume = value;
}

/** Tira o retorno pendente (null = a revisão não veio da Central). */
export function takeResumeAfterReview(): SyncCenterResume | null {
  const value = resume;
  resume = null;
  return value;
}

let request: SyncCenterRequest | null = null;
const conflicts = new Map<string, number>();
const listeners = new Set<() => void>();
// Snapshot estável pro useSyncExternalStore (um objeto novo a cada leitura
// faria o React renderizar em laço).
let conflictsVersion = 0;

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function openSyncCenter(options: Omit<SyncCenterRequest, 'nonce'> = {}): void {
  request = { ...options, nonce: Date.now() };
  emit();
}

export function closeSyncCenter(): void {
  request = null;
  emit();
}

export function useSyncCenter(): SyncCenterRequest | null {
  return useSyncExternalStore(subscribe, () => request, () => null);
}

/** O que a última verificação achou. `null` = não verificado ainda. */
export function setKnownConflicts(workspace: string, count: number | null): void {
  if (!workspace) return;
  const before = conflicts.get(workspace);
  if (count === null) conflicts.delete(workspace);
  else conflicts.set(workspace, count);
  if (before !== (count ?? undefined)) {
    conflictsVersion++;
    emit();
  }
}

export function useKnownConflicts(workspace: string): number | null {
  useSyncExternalStore(subscribe, () => conflictsVersion, () => 0);
  return conflicts.get(workspace) ?? null;
}
