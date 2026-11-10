import type { ReactNode } from 'react'
import type { StatusKey } from '@/lib/diffOrigin'
import { useLanguage, type Language } from './language'

// Textos da tela de revisão do GitHub (SyncDiffDialog + EntryDiffTable).
// Primeira tela com idioma: o formato serve de modelo pras próximas — um
// objeto por idioma com as MESMAS chaves (o tipo de `en` obriga o `pt-BR` a
// ter todas), funções onde entra número ou nome.

const strong = (text: string) => <strong className="font-semibold">{text}</strong>

const en = {
  // Escolha por item
  mine: 'Mine',
  github: 'GitHub',
  merge: 'Merge',
  mineTitle: 'Keep your version here',
  githubTitle: "Take GitHub's version",
  mergeTitle: 'Combine field by field — opens the fields on the right',

  // Campo a campo
  none: 'none',
  empty: '(empty)',
  edited: 'edited',
  fieldChangedHere: 'changed here',
  fieldChangedGithub: 'changed on GitHub',
  fieldChangedBoth: 'changed on both sides',
  viewDiff: 'Diff',
  viewSideBySide: 'Side by side',
  lastSync: 'Last sync',
  whatYouChanged: 'What you changed',
  whatGithubChanged: 'What changed on GitHub',
  noChangeHere: 'You did not change this field.',
  noChangeGithub: 'GitHub did not change this field.',
  notInLastSync: 'This item did not exist at the last sync.',
  loadingLastSync: 'Loading the last synced version…',
  collapsedLines: (n: number) => `${n} unchanged line(s)`,

  // Relatório do merge, prévia do push, desfazer, histórico, quem mudou
  changeLabels: {
    new: 'new', deleted: 'deleted', changed: 'changed', moved: 'moved to another folder', reordered: 'reordered',
  } as Record<'new' | 'deleted' | 'changed' | 'moved' | 'reordered', string>,
  reportTitle: (ws: string) => `What the merge brought into "${ws}"`,
  reportFromGithub: 'From GitHub',
  reportKeptMine: 'Changed on both sides — your version stayed',
  reportYours: 'Yours, waiting to be pushed',
  reportDetails: 'Details',
  previewTitle: (ws: string) => `Push preview — "${ws}"`,
  previewSubtitle: 'Nothing is sent until you click Push now. What changed on GitHub is merged in first.',
  previewYours: 'Your changes — go to GitHub',
  previewIncoming: 'From GitHub — merged in before pushing',
  previewConflicts: 'Need your decision — the review opens',
  previewKeptMine: "Changed on both sides — yours replaces GitHub's",
  previewNothing: 'Nothing here.',
  pushNow: 'Push now',
  undo: 'Undo',
  undoDone: 'Back to how it was before the pull.',
  undoExpired: 'Too late to undo — it only lasts 10 minutes.',
  undoLosesEdits: 'You edited things after the pull. Undoing goes back to before the pull and discards those edits too.',
  undoAnyway: 'Undo anyway',
  historyButton: 'History',
  historyTitle: 'Conflict decisions',
  historySubtitle: 'What was chosen in each conflict, on this computer — latest first.',
  historyEmpty: 'No conflict decided yet.',
  choiceLabels: {
    mine: 'kept yours', github: "took GitHub's", merged: 'merged field by field', 'kept-mine-auto': 'kept yours automatically (push)',
  } as Record<'mine' | 'github' | 'merged' | 'kept-mine-auto', string>,
  whoChanged: 'Who changed this item on GitHub?',
  whoChangedLoading: 'Looking through the file history…',
  whoChangedBy: (author: string, ago: string) => `Last changed by ${author} · ${ago}`,
  whoCreatedBy: (author: string, ago: string) => `Created by ${author} · ${ago}`,
  whoDeletedBy: (author: string, ago: string) => `Deleted by ${author} · ${ago}`,
  whoChangedFields: (fields: string) => `Fields: ${fields}`,
  whoChangedNotFound: (n: number) => `No change to this item in the last ${n} commit(s) of its file.`,
  showSensitive: 'Show sensitive values',
  hideSensitive: 'Hide sensitive values',
  show: 'Show',
  hide: 'Hide',
  useMine: 'Use mine',
  useGithub: 'Use GitHub',
  keepBoth: 'Keep both',
  yourVersion: 'Your version',
  result: 'Result — what gets saved',
  invalidJson: (error: string) => `Invalid JSON: ${error}`,
  orderNote:
    "The order of items can't be edited here. Choosing GitHub for this item uses GitHub's order; Mine keeps yours.",
  notEditable: "This one can't be edited here — accept it or leave it as is.",

  // Cabeçalho e aviso do push
  titlePush: 'Before you push: review changes on GitHub',
  titlePull: 'Review changes from GitHub',
  titleRestore: (sha: string) => `Restore from commit ${sha}`,
  dragTitle: 'Drag to move — double-click to recenter',
  resizeTitle: 'Drag to resize — double-click to restore the size',
  close: 'Close',
  pushBanner: (): ReactNode => (
    <>
      GitHub has changes you don&apos;t have yet, so your push is on hold. Items set to {strong('GitHub')} take
      GitHub&apos;s version, items set to {strong('Mine')} keep yours. The result is pushed as soon as you confirm.
    </>
  ),
  allMatch: 'Everything here matches GitHub.',

  // Barra de contagem e atalhos
  fromGithub: 'from GitHub',
  fromGithubTitle: 'Changed only on GitHub — accepting loses nothing of yours',
  yours: 'yours',
  yoursTitle: 'Changed only here and not pushed yet. Set to Mine, they stay as they are and go out with your next push.',
  needDecision: 'need your decision',
  needDecisionTitle: 'Changed on both sides — pick which version to keep',
  hiddenByFilter: (n: number) => `${n} hidden by the filter`,
  safeDefaults: 'Safe defaults',
  safeDefaultsTitle: 'GitHub where only GitHub changed; Mine everywhere else — nothing of yours is lost',
  allGithub: 'All GitHub',
  allGithubTitle: "Take GitHub's version of everything shown",
  allMine: 'All mine',
  allMineTitle: 'Keep your version of everything shown',
  autoMerge: 'Auto merge',
  autoMergeTitle:
    'Resolve everything shown that can be resolved safely: GitHub where only GitHub changed, Mine where only you did, and items changed on both sides combined field by field (the body line by line). Only real conflicts are left for you. Nothing is sent until you confirm.',
  autoMerging: 'Merging…',
  autoMergeSummary: (s: { github: number; mine: number; merged: number; combined: number }) =>
    `Auto merge: ${s.github} from GitHub, ${s.mine} yours, ${s.merged} combined${s.combined ? ` (${s.combined} line by line)` : ''}.`,
  autoMergeConflictsLeft: (n: number) => `${n} real conflict(s) still need your decision.`,
  autoMergeNoConflicts: 'No conflict left — review and confirm.',
  autoMergeSkipped: (n: number) => `${n} item(s) you merged by hand were left as they are.`,
  autoMergeFailed: 'Could not load the last synced version — items changed in the same field stay as conflicts.',
  showConflicts: 'Show conflicts',
  dismiss: 'Dismiss',
  autoTag: 'auto',
  autoTagTitle: 'Resolved by Auto merge',
  conflictFields: (fields: string) => `Real conflict in: ${fields}`,
  conflictWholeItem: 'Real conflict: deleted on one side and changed on the other.',
  restField: 'other settings',
  autoCombinedNote: 'Both changes were combined here — check the result below.',
  conflictFieldNote: 'Changed on both sides in the same place — this one needs your decision.',
  resultMine: 'your version',
  resultGithub: 'GitHub version',
  resultEdited: 'edited',
  resultReadOnly: 'This item also differs in something without its own box here (order or other settings), so it cannot be edited while set to Mine. Choose Merge or GitHub to edit.',

  // Editor de merge de três painéis (layout do merge do Visual Studio)
  mvIncomingSub: 'incoming',
  mvCurrentSub: 'current · local',
  mvResult: 'Result',
  mvResultSub: 'what gets saved',
  mvConflicts: (n: number) => (n === 1 ? '1 conflict' : `${n} conflicts`),
  mvNoConflicts: 'no conflicts',
  mvAutoJoined: (n: number) => `${n} change(s) combined on their own`,
  mvPrev: 'Previous conflict',
  mvNext: 'Next conflict',
  mvAcceptGithub: 'Accept GitHub',
  mvAcceptMine: 'Accept mine',
  mvAcceptBoth: 'Accept both',
  mvAcceptTitle: 'Applies to the conflicts only — what combined on its own stays as it is',
  mvInclude: 'Include this change in the result',
  mvUnresolved: 'Unresolved conflict — tick one side above',
  mvTwoWay: 'No last synced version to compare with: every difference needs your decision.',
  mvEditResult: 'Edit result',
  mvBackToBoxes: 'Back to the checkboxes',
  mvManualNote: 'Edited by hand — the checkboxes no longer apply.',
  mvShowLines: (n: number) => `Show ${n} unchanged line(s)`,
  mvResolveFirst: (n: number) => `Resolve ${n} conflict(s) in the merge first`,

  // Aviso "alguém mudou no GitHub"
  rcTitle: 'Changes on GitHub',
  rcConflictTitle: 'Conflict ahead on GitHub',
  rcChangedFile: (name: string) => `changed ${name}`,
  rcRemovedFile: (name: string) => `removed ${name}`,
  rcOtherFiles: (n: number) => `+${n} more file(s)`,
  rcItemsTitle: (n: number) => (n === 1 ? '1 item changed' : `${n} items changed`),
  rcMoreItems: (n: number) => `+${n} more — see them all in the review`,
  rcConflictNote: (n: number) =>
    `${n} item(s) were also changed here in the same place — Pull brings the rest in and opens only these.`,
  rcMergesAlone: 'No conflict with your unpushed changes — Pull merges everything automatically.',
  rcFromCommitTitle: (n: number) => (n === 1 ? '1 item changed in the last commit' : `${n} items changed in the last commit`),
  rcAlreadyHere: 'You already have these changes here — nothing to pull for them.',
  rcEnvironments: 'Environment variables',
  rcHere: 'Here',
  rcPreview: 'Preview',
  rcHide: 'Hide',
  rcNoPreview: 'Open the review to see what changed in this file.',
  rcPull: 'Review and pull',
  rcResolve: 'Resolve now',
  rcLater: 'Later',
  rcViewDiff: 'View diff',
  rcViewDiffTitle: 'Open the differences side by side (Visual Studio style)',
  mdTitle: 'Differences',
  mdSimulation: 'Simulation — tick the boxes to see the outcome. Nothing is applied from here.',
  mdNoFields: 'Nothing to compare line by line: the item was created, deleted or moved.',
  mdEnvNote: 'Environment variables are listed by name only — their values are often tokens.',
  mdItems: (n: number) => (n === 1 ? '1 item' : `${n} items`),
  rcBadge: { new: 'new', deleted: 'deleted', changed: 'changed', moved: 'moved', reordered: 'reordered', conflict: 'conflict' } as Record<
    'new' | 'deleted' | 'changed' | 'moved' | 'reordered' | 'conflict',
    string
  >,
  authMaskedResult: 'Sensitive values hidden. Click Show to see and edit the result.',
  escapeArmed: 'Press Esc again to close and discard your choices and merges.',
  maximize: 'Maximize',
  restore: 'Restore size',
  splitterTitle: 'Drag (or use the arrow keys) to resize the item list and the merge panel — double-click to reset',

  // Filtro
  filterPlaceholder: 'Filter by name or folder',
  anyChange: 'Any change',
  changedOption: 'Changed',
  onlyOnGithubOption: 'Only on GitHub',
  onlyHereOption: 'Only here',
  conflicts: 'Conflicts',
  conflictsTitle: 'Show only what changed on both sides',
  clear: 'Clear',
  nothingMatches: 'Nothing matches this filter.',

  // Lista
  rootPendingTitle: 'You have local changes here that were never pushed',
  yoursTag: 'yours',
  yoursTagLabel: 'Your unpushed change — choosing GitHub undoes it',
  conflictLabel: 'Changed on both sides — choosing GitHub discards your version',

  // Detalhe
  pickItem: 'Pick an item to see what changed.',
  checkingWho: 'Checking who changed it on GitHub…',
  lastCommitTitle: (message: string, date: string) => `Last commit to this collection on GitHub: "${message}" — ${date}`,
  lastChangedBy: 'Collection last changed on GitHub by',
  pendingFallbackDetail:
    "You have changes in this collection that were never pushed. Choosing GitHub replaces your copy with GitHub's, and there is no undo.",
  nowGithub: '(Now: GitHub.)',
  nowMerged: '(Now: Merge.)',
  nowMine: '(Now: Mine.)',

  // Rodapé
  footerSummary: (fromGithub: number, mine: number) => `${fromGithub} from GitHub · ${mine} mine`,
  discardLocal: (n: number) => ` · ${n} discard local work`,
  cancelPush: 'Cancel push',
  cancelPushTitle: 'Close without pushing anything',
  fixJsonFirst: (n: number) => `Fix ${n} invalid JSON value(s) first`,
  pushMineTitle: "Push your version as is. GitHub's changes listed here are replaced by yours.",
  mergePushTitle: (n: number) =>
    `Take GitHub's version of the ${n} item(s) set to GitHub, keep yours for the rest, then push the result`,
  keepAsIsTitle: 'Accept nothing from GitHub and keep everything here as is',
  pushMine: 'Push mine (overwrite GitHub)',
  mergePush: (n: number) => `Merge & push (${n})`,
  keepAsIs: 'Keep as is',
  apply: (n: number) => `Apply ${n}`,

  // Tempo relativo
  justNow: 'just now',
  minAgo: (n: number) => `${n} min ago`,
  hoursAgo: (n: number) => `${n} h ago`,
  daysAgo: (n: number) => `${n} day${n === 1 ? '' : 's'} ago`,

  // Headers e variáveis (EntryDiffTable)
  entriesChanged: (changed: number, total: number) =>
    `${changed} of ${total} ${total === 1 ? 'entry' : 'entries'} changed`,
  showValue: 'Show value',
  hideValue: 'Hide value',
  disabledSide: 'Disabled on this side',
  off: 'off',
  here: 'Here',
  notHere: 'Not here',
  goneOnGithub: 'Gone on GitHub',
  fixJsonToChoose: 'Fix the JSON below to choose per entry',
  keepSide: (side: string) => `Keep the ${side} version`,

  // Quem mexeu em cada item (lib/diffOrigin)
  status: {
    onlyOnGithub: { label: 'Only on GitHub', detail: 'This exists only on GitHub — accepting adds it here.' },
    onlyHere: { label: 'Only here', detail: 'This exists only here — accepting removes it.' },
    changed: { label: 'Changed', detail: "Accepting replaces your version with GitHub's." },
    newOnGithub: { label: 'New on GitHub', detail: 'Someone added this on GitHub — accepting adds it here.' },
    deletedHereChangedOnGithub: {
      label: 'Deleted here, changed on GitHub',
      detail:
        'You deleted this, and someone changed it on GitHub. Choose GitHub to bring back their version, or Mine to keep it deleted.',
    },
    deletedHere: {
      label: 'Deleted here',
      detail: "You deleted this and haven't pushed yet. Mine keeps it deleted; GitHub brings it back.",
    },
    newHere: {
      label: 'New here',
      detail:
        "You created this and haven't pushed it yet. Mine keeps it — it goes out with your next push. GitHub deletes your copy.",
    },
    changedHereDeletedOnGithub: {
      label: 'Changed here, deleted on GitHub',
      detail: 'Someone deleted this on GitHub after you changed it here. GitHub deletes your copy; Mine keeps it.',
    },
    deletedOnGithub: { label: 'Deleted on GitHub', detail: 'Someone deleted this on GitHub — accepting deletes it here too.' },
    changedBoth: {
      label: 'Changed on both sides',
      detail:
        'You and someone on GitHub both changed this. GitHub takes their version, Mine keeps yours, Merge lets you combine them field by field below.',
    },
    changedHere: {
      label: 'Changed here',
      detail: 'Only you changed this. Mine keeps your version; GitHub reverts it to theirs.',
    },
    changedOnGithub: { label: 'Changed on GitHub', detail: 'Only GitHub changed this — accepting is safe.' },
  } satisfies Record<StatusKey, { label: string; detail: string }>,
}

export type SyncDiffStrings = typeof en

const ptBR: SyncDiffStrings = {
  mine: 'Minha',
  github: 'GitHub',
  merge: 'Mesclar',
  mineTitle: 'Manter a sua versão',
  githubTitle: 'Usar a versão do GitHub',
  mergeTitle: 'Combinar campo a campo — abre os campos à direita',

  none: 'nenhum',
  empty: '(vazio)',
  edited: 'editado',
  fieldChangedHere: 'alterado aqui',
  fieldChangedGithub: 'alterado no GitHub',
  fieldChangedBoth: 'alterado dos dois lados',
  viewDiff: 'Diff',
  viewSideBySide: 'Lado a lado',
  lastSync: 'Última sincronização',
  whatYouChanged: 'O que você mudou',
  whatGithubChanged: 'O que mudou no GitHub',
  noChangeHere: 'Você não mudou este campo.',
  noChangeGithub: 'O GitHub não mudou este campo.',
  notInLastSync: 'Este item não existia na última sincronização.',
  loadingLastSync: 'Carregando a versão da última sincronização…',
  collapsedLines: (n: number) => `${n} linha(s) sem mudança`,

  changeLabels: {
    new: 'novo', deleted: 'apagado', changed: 'alterado', moved: 'movido de pasta', reordered: 'reordenado',
  },
  reportTitle: (ws: string) => `O que o merge trouxe para "${ws}"`,
  reportFromGithub: 'Do GitHub',
  reportKeptMine: 'Mudou dos dois lados — ficou a sua versão',
  reportYours: 'Seus, esperando o push',
  reportDetails: 'Detalhes',
  previewTitle: (ws: string) => `Prévia do push — "${ws}"`,
  previewSubtitle: 'Nada é enviado até você clicar em Enviar agora. O que mudou no GitHub entra antes.',
  previewYours: 'Suas mudanças — vão para o GitHub',
  previewIncoming: 'Do GitHub — entram antes do envio',
  previewConflicts: 'Precisam da sua decisão — a revisão abre',
  previewKeptMine: 'Mudou dos dois lados — a sua substitui a do GitHub',
  previewNothing: 'Nada aqui.',
  pushNow: 'Enviar agora',
  undo: 'Desfazer',
  undoDone: 'Voltou ao estado de antes do pull.',
  undoExpired: 'Não dá mais para desfazer — vale por 10 minutos.',
  undoLosesEdits: 'Você editou coisas depois do pull. Desfazer volta ao estado de antes dele e descarta essas edições também.',
  undoAnyway: 'Desfazer mesmo assim',
  historyButton: 'Histórico',
  historyTitle: 'Decisões de conflito',
  historySubtitle: 'O que foi escolhido em cada conflito, neste computador — mais recentes primeiro.',
  historyEmpty: 'Nenhum conflito decidido ainda.',
  choiceLabels: {
    mine: 'ficou a sua', github: 'ficou a do GitHub', merged: 'mesclado campo a campo', 'kept-mine-auto': 'ficou a sua automaticamente (push)',
  },
  whoChanged: 'Quem mudou este item no GitHub?',
  whoChangedLoading: 'Procurando no histórico do arquivo…',
  whoChangedBy: (author: string, ago: string) => `Alterado por último por ${author} · ${ago}`,
  whoCreatedBy: (author: string, ago: string) => `Criado por ${author} · ${ago}`,
  whoDeletedBy: (author: string, ago: string) => `Apagado por ${author} · ${ago}`,
  whoChangedFields: (fields: string) => `Campos: ${fields}`,
  whoChangedNotFound: (n: number) => `Nenhuma mudança neste item nos últimos ${n} commit(s) do arquivo.`,
  showSensitive: 'Mostrar valores sensíveis',
  hideSensitive: 'Ocultar valores sensíveis',
  show: 'Mostrar',
  hide: 'Ocultar',
  useMine: 'Usar a minha',
  useGithub: 'Usar a do GitHub',
  keepBoth: 'Manter as duas',
  yourVersion: 'Sua versão',
  result: 'Resultado — o que será salvo',
  invalidJson: (error: string) => `JSON inválido: ${error}`,
  orderNote:
    'A ordem dos itens não pode ser editada aqui. Escolher GitHub neste item usa a ordem do GitHub; Minha mantém a sua.',
  notEditable: 'Este não pode ser editado aqui — aceite ou deixe como está.',

  titlePush: 'Antes do push: revise as mudanças no GitHub',
  titlePull: 'Revisar mudanças do GitHub',
  titleRestore: (sha: string) => `Restaurar do commit ${sha}`,
  dragTitle: 'Arraste para mover — clique duas vezes para centralizar',
  resizeTitle: 'Arraste para redimensionar — clique duas vezes para voltar ao tamanho padrão',
  close: 'Fechar',
  pushBanner: (): ReactNode => (
    <>
      O GitHub tem mudanças que você ainda não tem, então o seu push está em espera. Itens em {strong('GitHub')} recebem
      a versão do GitHub; itens em {strong('Minha')} mantêm a sua. O resultado é enviado assim que você confirmar.
    </>
  ),
  allMatch: 'Tudo aqui está igual ao GitHub.',

  fromGithub: 'do GitHub',
  fromGithubTitle: 'Mudou só no GitHub — aceitar não perde nada seu',
  yours: 'seus',
  yoursTitle: 'Mudou só aqui e ainda não foi enviado. Em Minha, fica como está e vai no seu próximo push.',
  needDecision: 'precisam da sua decisão',
  needDecisionTitle: 'Mudou dos dois lados — escolha qual versão manter',
  hiddenByFilter: (n: number) => `${n} ocultos pelo filtro`,
  safeDefaults: 'Padrão seguro',
  safeDefaultsTitle: 'GitHub onde só o GitHub mudou; Minha no resto — nada seu se perde',
  allGithub: 'Tudo do GitHub',
  allGithubTitle: 'Usar a versão do GitHub em tudo que está na lista',
  allMine: 'Tudo meu',
  allMineTitle: 'Manter a sua versão em tudo que está na lista',
  autoMerge: 'Auto merge',
  autoMergeTitle:
    'Resolve sozinho tudo o que está na lista e dá pra resolver sem risco: GitHub onde só o GitHub mudou, Minha onde só você mudou, e itens alterados dos dois lados combinados campo a campo (o body linha a linha). Só os conflitos reais ficam pra você. Nada é enviado antes da sua confirmação.',
  autoMerging: 'Mesclando…',
  autoMergeSummary: (s: { github: number; mine: number; merged: number; combined: number }) =>
    `Auto merge: ${s.github} do GitHub, ${s.mine} seus, ${s.merged} combinados${s.combined ? ` (${s.combined} linha a linha)` : ''}.`,
  autoMergeConflictsLeft: (n: number) => `${n} conflito(s) real(is) ainda pede(m) a sua decisão.`,
  autoMergeNoConflicts: 'Nenhum conflito sobrou — revise e confirme.',
  autoMergeSkipped: (n: number) => `${n} item(ns) que você mesclou à mão ficaram como estavam.`,
  autoMergeFailed: 'Não deu pra carregar a versão da última sincronização — itens alterados no mesmo campo continuam como conflito.',
  showConflicts: 'Ver conflitos',
  dismiss: 'Fechar',
  autoTag: 'auto',
  autoTagTitle: 'Resolvido pelo Auto merge',
  conflictFields: (fields: string) => `Conflito real em: ${fields}`,
  conflictWholeItem: 'Conflito real: apagado de um lado e alterado do outro.',
  restField: 'outras configurações',
  autoCombinedNote: 'As duas mudanças foram juntadas aqui — confira o resultado abaixo.',
  conflictFieldNote: 'Mudou dos dois lados no mesmo trecho — este precisa da sua decisão.',
  resultMine: 'sua versão',
  resultGithub: 'versão do GitHub',
  resultEdited: 'editado',
  resultReadOnly: 'Este item também difere em algo sem caixa própria aqui (ordem ou outras configurações), então não dá pra editar com ele em Minha. Escolha Merge ou GitHub para editar.',

  mvIncomingSub: 'incoming',
  mvCurrentSub: 'current · local',
  mvResult: 'Resultado',
  mvResultSub: 'o que vai ser salvo',
  mvConflicts: (n: number) => (n === 1 ? '1 conflito' : `${n} conflitos`),
  mvNoConflicts: 'sem conflitos',
  mvAutoJoined: (n: number) => `${n} trecho(s) juntado(s) sozinho(s)`,
  mvPrev: 'Conflito anterior',
  mvNext: 'Próximo conflito',
  mvAcceptGithub: 'Aceitar GitHub',
  mvAcceptMine: 'Aceitar minha',
  mvAcceptBoth: 'Aceitar ambos',
  mvAcceptTitle: 'Vale só para os conflitos — o que juntou sozinho continua como está',
  mvInclude: 'Incluir este trecho no resultado',
  mvUnresolved: 'Conflito sem decisão — marque um dos lados acima',
  mvTwoWay: 'Sem a versão da última sincronização pra comparar: toda diferença precisa da sua decisão.',
  mvEditResult: 'Editar resultado',
  mvBackToBoxes: 'Voltar às caixinhas',
  mvManualNote: 'Editado à mão — as caixinhas deixaram de valer.',
  mvShowLines: (n: number) => `Mostrar ${n} linha(s) sem mudança`,
  mvResolveFirst: (n: number) => `Resolva antes ${n} conflito(s) no merge`,

  rcTitle: 'Mudanças no GitHub',
  rcConflictTitle: 'Conflito à vista no GitHub',
  rcChangedFile: (name: string) => `alterou ${name}`,
  rcRemovedFile: (name: string) => `removeu ${name}`,
  rcOtherFiles: (n: number) => `+${n} arquivo(s)`,
  rcItemsTitle: (n: number) => (n === 1 ? '1 item alterado' : `${n} itens alterados`),
  rcMoreItems: (n: number) => `+${n} — veja todos na revisão`,
  rcConflictNote: (n: number) =>
    `${n} item(ns) também mudaram aqui no mesmo ponto — o Pull traz o resto e abre só esses.`,
  rcMergesAlone: 'Sem conflito com o que você ainda não enviou — o Pull junta tudo sozinho.',
  rcFromCommitTitle: (n: number) => (n === 1 ? '1 item alterado no último commit' : `${n} itens alterados no último commit`),
  rcAlreadyHere: 'Você já tem essas mudanças aqui — não há nada delas para puxar.',
  rcEnvironments: 'Variáveis de environment',
  rcHere: 'Aqui',
  rcPreview: 'Prévia',
  rcHide: 'Ocultar',
  rcNoPreview: 'Abra a revisão para ver o que mudou neste arquivo.',
  rcPull: 'Revisar e puxar',
  rcResolve: 'Resolver agora',
  rcLater: 'Depois',
  rcViewDiff: 'Ver diferença',
  rcViewDiffTitle: 'Abrir as diferenças lado a lado (formato do Visual Studio)',
  mdTitle: 'Diferenças',
  mdSimulation: 'Simulação — marque as caixinhas para ver o resultado. Nada é aplicado daqui.',
  mdNoFields: 'Nada para comparar linha a linha: o item foi criado, apagado ou movido.',
  mdEnvNote: 'Variáveis de environment aparecem só pelo nome — o valor costuma ser token.',
  mdItems: (n: number) => (n === 1 ? '1 item' : `${n} itens`),
  rcBadge: { new: 'novo', deleted: 'apagado', changed: 'alterado', moved: 'movido', reordered: 'reordenado', conflict: 'conflito' },
  authMaskedResult: 'Valores sensíveis ocultos. Clique em Mostrar para ver e editar o resultado.',
  escapeArmed: 'Aperte Esc de novo para fechar e descartar suas escolhas e merges.',
  maximize: 'Maximizar',
  restore: 'Restaurar tamanho',
  splitterTitle: 'Arraste (ou use as setas) para mudar a largura da lista de itens e do painel de merge — clique duas vezes para voltar ao padrão',

  filterPlaceholder: 'Filtrar por nome ou pasta',
  anyChange: 'Qualquer mudança',
  changedOption: 'Alterado',
  onlyOnGithubOption: 'Só no GitHub',
  onlyHereOption: 'Só aqui',
  conflicts: 'Conflitos',
  conflictsTitle: 'Mostrar só o que mudou dos dois lados',
  clear: 'Limpar',
  nothingMatches: 'Nada corresponde a este filtro.',

  rootPendingTitle: 'Você tem mudanças locais aqui que nunca foram enviadas',
  yoursTag: 'seu',
  yoursTagLabel: 'Mudança sua ainda não enviada — escolher GitHub a desfaz',
  conflictLabel: 'Mudou dos dois lados — escolher GitHub descarta a sua versão',

  pickItem: 'Escolha um item para ver o que mudou.',
  checkingWho: 'Verificando quem alterou no GitHub…',
  lastCommitTitle: (message: string, date: string) => `Último commit desta collection no GitHub: "${message}" — ${date}`,
  lastChangedBy: 'Collection alterada por último no GitHub por',
  pendingFallbackDetail:
    'Você tem mudanças nesta collection que nunca foram enviadas. Escolher GitHub substitui a sua cópia pela do GitHub, e não dá para desfazer.',
  nowGithub: '(Agora: GitHub.)',
  nowMerged: '(Agora: Merge.)',
  nowMine: '(Agora: Minha.)',

  footerSummary: (fromGithub: number, mine: number) => `${fromGithub} do GitHub · ${mine} minhas`,
  discardLocal: (n: number) => ` · ${n} descartam trabalho local`,
  cancelPush: 'Cancelar push',
  cancelPushTitle: 'Fechar sem enviar nada',
  fixJsonFirst: (n: number) => `Corrija antes ${n} valor(es) JSON inválido(s)`,
  pushMineTitle: 'Enviar a sua versão como está. As mudanças do GitHub listadas aqui são substituídas pelas suas.',
  mergePushTitle: (n: number) =>
    `Usar a versão do GitHub nos ${n} item(ns) em GitHub, manter a sua no resto e enviar o resultado`,
  keepAsIsTitle: 'Não aceitar nada do GitHub e manter tudo aqui como está',
  pushMine: 'Enviar a minha (sobrescrever o GitHub)',
  mergePush: (n: number) => `Mesclar e enviar (${n})`,
  keepAsIs: 'Manter como está',
  apply: (n: number) => `Aplicar ${n}`,

  justNow: 'agora mesmo',
  minAgo: (n: number) => `há ${n} min`,
  hoursAgo: (n: number) => `há ${n} h`,
  daysAgo: (n: number) => `há ${n} dia${n === 1 ? '' : 's'}`,

  entriesChanged: (changed: number, total: number) =>
    `${changed} de ${total} ${total === 1 ? 'entrada alterada' : 'entradas alteradas'}`,
  showValue: 'Mostrar valor',
  hideValue: 'Ocultar valor',
  disabledSide: 'Desativado deste lado',
  off: 'desl.',
  here: 'Aqui',
  notHere: 'Não existe aqui',
  goneOnGithub: 'Removido no GitHub',
  fixJsonToChoose: 'Corrija o JSON abaixo para escolher por entrada',
  keepSide: (side: string) => `Manter a versão de ${side}`,

  status: {
    onlyOnGithub: { label: 'Só no GitHub', detail: 'Isto existe só no GitHub — aceitar adiciona aqui.' },
    onlyHere: { label: 'Só aqui', detail: 'Isto existe só aqui — aceitar remove.' },
    changed: { label: 'Alterado', detail: 'Aceitar substitui a sua versão pela do GitHub.' },
    newOnGithub: { label: 'Novo no GitHub', detail: 'Alguém adicionou isto no GitHub — aceitar adiciona aqui.' },
    deletedHereChangedOnGithub: {
      label: 'Apagado aqui, alterado no GitHub',
      detail:
        'Você apagou isto, e alguém alterou no GitHub. Escolha GitHub para trazer de volta a versão de lá, ou Minha para manter apagado.',
    },
    deletedHere: {
      label: 'Apagado aqui',
      detail: 'Você apagou isto e ainda não enviou. Minha mantém apagado; GitHub traz de volta.',
    },
    newHere: {
      label: 'Novo aqui',
      detail: 'Você criou isto e ainda não enviou. Minha mantém — vai no seu próximo push. GitHub apaga a sua cópia.',
    },
    changedHereDeletedOnGithub: {
      label: 'Alterado aqui, apagado no GitHub',
      detail: 'Alguém apagou isto no GitHub depois que você alterou aqui. GitHub apaga a sua cópia; Minha mantém.',
    },
    deletedOnGithub: { label: 'Apagado no GitHub', detail: 'Alguém apagou isto no GitHub — aceitar apaga aqui também.' },
    changedBoth: {
      label: 'Alterado dos dois lados',
      detail:
        'Você e alguém no GitHub alteraram isto. GitHub usa a versão de lá, Minha mantém a sua, Mesclar deixa combinar campo a campo abaixo.',
    },
    changedHere: {
      label: 'Alterado aqui',
      detail: 'Só você alterou isto. Minha mantém a sua versão; GitHub volta para a de lá.',
    },
    changedOnGithub: { label: 'Alterado no GitHub', detail: 'Só o GitHub alterou isto — aceitar é seguro.' },
  },
}

const STRINGS: Record<Language, SyncDiffStrings> = { en, 'pt-BR': ptBR }

export function syncDiffStrings(language: Language): SyncDiffStrings {
  return STRINGS[language] ?? en
}

export function useSyncDiffStrings(): SyncDiffStrings {
  return syncDiffStrings(useLanguage())
}
