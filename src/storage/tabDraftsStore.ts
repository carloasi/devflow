import { Tab } from '@/app/types/Tab'

// Rascunhos locais de abas com alteração não salva — usado quando uma aba
// dirty precisa ser fechada sem exibir o modal de confirmação "Unsaved
// changes" (ex: ao trocar de pasta favorita). Em vez de descartar a edição
// ou forçar um save/push pro GitHub, o conteúdo é guardado aqui e restaurado
// (ainda marcado como dirty) na próxima vez que o mesmo request for aberto —
// o usuário decide, naquele momento, se quer salvar ou não.
const STORAGE_KEY = 'devflow_tab_drafts'

function readAll(): Record<string, Tab> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch (e) {
    console.error('Erro ao ler rascunhos de abas:', e)
    return {}
  }
}

function writeAll(drafts: Record<string, Tab>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts))
  } catch (e) {
    console.error('Erro ao salvar rascunhos de abas:', e)
  }
}

export function saveTabDraft(tab: Tab): void {
  const drafts = readAll()
  drafts[tab.id] = { ...tab, isDirty: true }
  writeAll(drafts)
}

export function getTabDraft(id: string): Tab | null {
  const drafts = readAll()
  return drafts[id] ?? null
}

export function removeTabDraft(id: string): void {
  const drafts = readAll()
  if (!(id in drafts)) return
  delete drafts[id]
  writeAll(drafts)
}

export function removeTabDrafts(ids: string[]): void {
  const drafts = readAll()
  let changed = false
  ids.forEach((id) => {
    if (id in drafts) {
      delete drafts[id]
      changed = true
    }
  })
  if (changed) writeAll(drafts)
}
