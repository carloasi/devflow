import { CollectionItem } from '@/app/types/CollectionItem'

// Clipboard persistido em localStorage pra Copy/Paste de itens da árvore de
// collections — persistido (não só em memória) pra permitir copiar em uma
// collection, fechar/trocar de aba, abrir outra collection e colar lá.
const STORAGE_KEY = 'devflow_tree_clipboard'

export function copyItemsToClipboard(items: CollectionItem[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch (e) {
    console.error('Erro ao copiar itens para o clipboard:', e)
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
}
