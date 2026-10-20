import { LazyStore } from '@tauri-apps/plugin-store';

// Arquivo próprio em app_data_dir — lista de workspaces e qual está selecionado.
// Totalmente desacoplado do GitHub: existe e funciona mesmo sem nenhuma
// configuração de sincronização remota.
const store = new LazyStore('workspaces.json', { autoSave: 300 });

const WORKSPACES_KEY = 'workspaces';
const SELECTED_WORKSPACE_KEY = 'selectedWorkspace';

export interface WorkspaceInfo {
  name: string;
  path: string;
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9-_ ]+/g, '').trim();
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return (await store.get<WorkspaceInfo[]>(WORKSPACES_KEY)) ?? [];
}

export async function saveWorkspaces(workspaces: WorkspaceInfo[]): Promise<void> {
  await store.set(WORKSPACES_KEY, workspaces);
}

export async function getSelectedWorkspace(): Promise<string> {
  return (await store.get<string>(SELECTED_WORKSPACE_KEY)) ?? '';
}

export async function setSelectedWorkspace(path: string): Promise<void> {
  await store.set(SELECTED_WORKSPACE_KEY, path);
}

/**
 * Cria um novo workspace local. Retorna null se o nome for inválido
 * ou já existir um workspace com o mesmo path.
 */
export async function createWorkspace(name: string): Promise<WorkspaceInfo | null> {
  const sanitized = sanitizeName(name);
  if (!sanitized) return null;

  const path = sanitized;
  const workspaces = await listWorkspaces();

  if (workspaces.some(w => w.path === path)) {
    return null;
  }

  const newWorkspace: WorkspaceInfo = { name: sanitized, path };
  await saveWorkspaces([...workspaces, newWorkspace]);
  return newWorkspace;
}

/**
 * Renomeia um workspace local (só o registro — mover dados de
 * tabs/collections/environments é responsabilidade de quem chama,
 * já que essas chaves são namespaced pelo path).
 */
export async function renameWorkspace(
  oldPath: string,
  newName: string
): Promise<WorkspaceInfo | null> {
  const sanitized = sanitizeName(newName);
  if (!sanitized) return null;

  const newPath = sanitized;
  const workspaces = await listWorkspaces();

  if (newPath !== oldPath && workspaces.some(w => w.path === newPath)) {
    return null;
  }

  const updated = workspaces.map(w =>
    w.path === oldPath ? { name: sanitized, path: newPath } : w
  );
  await saveWorkspaces(updated);
  return { name: sanitized, path: newPath };
}

export async function deleteWorkspace(path: string): Promise<void> {
  const workspaces = await listWorkspaces();
  await saveWorkspaces(workspaces.filter(w => w.path !== path));
}