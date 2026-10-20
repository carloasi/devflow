import { getLocalStore, saveLocalStore, clearLocalStorePrefix } from '@/lib/localStore';
import { LoadTestRunRecord } from './types';

// Persistência via o mesmo key/value store usado pras settings do app
// (backend Rust: save_local_store/get_local_store, gravado em settings.json).
// Uma chave por item testado, pra listar/comparar runs de UMA request/pasta
// sem carregar o histórico de todas as outras de uma vez.
const HISTORY_KEY_PREFIX = 'load_test_history:';
const MAX_HISTORY_PER_ITEM = 20;

function historyKey(itemId: string): string {
  return `${HISTORY_KEY_PREFIX}${itemId}`;
}

export async function loadLoadTestHistory(itemId: string): Promise<LoadTestRunRecord[]> {
  try {
    const raw = await getLocalStore(historyKey(itemId));
    return Array.isArray(raw) ? (raw as LoadTestRunRecord[]) : [];
  } catch {
    return [];
  }
}

// Adiciona um registro no topo da lista (mais recente primeiro) e recorta
// pro limite máximo, pra não deixar o settings.json crescer sem limite.
export async function appendLoadTestHistory(
  record: LoadTestRunRecord
): Promise<LoadTestRunRecord[]> {
  const existing = await loadLoadTestHistory(record.itemId);
  const updated = [record, ...existing].slice(0, MAX_HISTORY_PER_ITEM);
  await saveLocalStore(historyKey(record.itemId), updated);
  return updated;
}

export async function deleteLoadTestHistoryRecord(
  itemId: string,
  recordId: string
): Promise<LoadTestRunRecord[]> {
  const existing = await loadLoadTestHistory(itemId);
  const updated = existing.filter(r => r.id !== recordId);
  await saveLocalStore(historyKey(itemId), updated);
  return updated;
}

export async function clearLoadTestHistory(itemId: string): Promise<void> {
  await saveLocalStore(historyKey(itemId), []);
}

// Limpa o histórico de load test de TODOS os itens de uma vez (usado pelo
// "Clear all history" das settings) — diferente de clearLoadTestHistory,
// que só zera um item específico.
export async function clearAllLoadTestHistory(): Promise<void> {
  await clearLocalStorePrefix(HISTORY_KEY_PREFIX);
}

// Exporta um registro (ou o resumo de uma run ao vivo ainda não salva) como
// JSON num arquivo escolhido pelo usuário — mesmo padrão do "Export
// Collection" (save() + writeTextFile()).
export async function exportLoadTestRecord(record: LoadTestRunRecord): Promise<void> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');

  const safeName = record.itemName.replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60) || 'load-test';
  const dateStamp = record.startedAt.slice(0, 19).replace(/[:T]/g, '-');

  const filePath = await save({
    defaultPath: `${safeName}_${dateStamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (!filePath) return;

  await writeTextFile(filePath, JSON.stringify(record, null, 2));
}
