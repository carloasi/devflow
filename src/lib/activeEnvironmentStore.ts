import { LazyStore } from '@tauri-apps/plugin-store';

// Arquivo próprio em app_data_dir — mesmo padrão de tabsStore.ts (activeTabId).
// Guarda, por workspace, o id da Environment ativa. É a fonte de verdade
// AUTORITATIVA: ao trocar de workspace, o AppLayout lê explicitamente o
// id salvo aqui pra ESSE workspace, em vez de inferir "o id que já estava
// selecionado ainda existe na lista nova?" — essa heurística de presença dá
// falso positivo quando duas Environments de workspaces diferentes têm o
// MESMO id (ex: puxadas do GitHub a partir de uma pasta copiada/duplicada),
// fazendo o app achar erroneamente que a env antiga "ainda é válida" no
// workspace novo.
const store = new LazyStore('active-environment.json', { autoSave: 300 });

const ACTIVE_ENV_KEY_PREFIX = 'activeEnvironmentId';

function workspaceKey(workspace: string): string {
  const suffix = workspace || 'default';
  return `${ACTIVE_ENV_KEY_PREFIX}:${suffix}`;
}

export async function loadActiveEnvironmentId(workspace: string): Promise<string | null> {
  return (await store.get<string>(workspaceKey(workspace))) ?? null;
}

export async function saveActiveEnvironmentId(workspace: string, id: string | null): Promise<void> {
  const key = workspaceKey(workspace);
  if (id) await store.set(key, id);
  else await store.delete(key);
}
