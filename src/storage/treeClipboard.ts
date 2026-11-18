import { CollectionItem } from '@/app/types/CollectionItem'

// Clipboard persistido em localStorage pra Copy/Paste de itens da árvore de
// collections — persistido (não só em memória) pra permitir copiar em uma
// collection, fechar/trocar de aba, abrir outra collection e colar lá.
const STORAGE_KEY = 'devflow_tree_clipboard'
// Ids do que foi RECORTADO (Ctrl+X): o próximo colar move esses itens em
// vez de criar cópias. Ausente = o clipboard é uma cópia comum.
const CUT_KEY = 'devflow_tree_clipboard_cut'

export function copyItemsToClipboard(items: CollectionItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    localStorage.removeItem(CUT_KEY)
  } catch (e) {
    console.error('Erro ao copiar itens para o clipboard:', e)
  }
}

/**
 * Recortar: guarda os itens (pra colar como cópia se os originais não
 * estiverem mais na árvore — outro workspace, apagados) e os ids deles.
 */
export function cutItemsToClipboard(items: CollectionItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
    localStorage.setItem(CUT_KEY, JSON.stringify(items.map(i => i.id)))
  } catch (e) {
    console.error('Erro ao recortar itens para o clipboard:', e)
  }
}

/** Ids recortados esperando o colar, ou [] se o clipboard é uma cópia. */
export function getCutIds(): string[] {
  try {
    const raw = localStorage.getItem(CUT_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []
  } catch {
    return []
  }
}

/** O recorte foi colado (ou desistido): o que sobra no clipboard é cópia. */
export function clearCut(): void {
  try {
    localStorage.removeItem(CUT_KEY)
  } catch {
    // sem storage: nada a limpar
  }
}

export function getClipboardItems(): CollectionItem[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (e) {
    console.error('Erro ao ler itens do clipboard:', e)
    return []
  }
}

export function hasClipboardItems(): boolean {
  return getClipboardItems().length > 0
}

export function clearClipboard(): void {
  localStorage.removeItem(STORAGE_KEY)
  localStorage.removeItem(CUT_KEY)
}
