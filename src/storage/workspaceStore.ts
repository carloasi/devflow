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
 * Núcleo puro do rename — separado de `renameWorkspace` pra poder testar as
 * regras (nome inválido, path já existente, `oldPath` fantasma) sem depender
 * do LazyStore.
 */
export function computeRenamedWorkspaces(
  workspaces: WorkspaceInfo[],
  oldPath: string,
  newName: string
): { workspaces: WorkspaceInfo[]; renamed: WorkspaceInfo } | null {
  const sanitized = sanitizeName(newName);
  if (!sanitized) return null;

  const newPath = sanitized;

  // Sem isso, um `oldPath` que não existe mais na lista (corrida com outra
  // aba, ou chamada com um path já renomeado) ainda devolvia um WorkspaceInfo
  // "de sucesso" — o chamador migrava os dados pra `newPath` sem que ele
  // jamais tivesse entrado no registro, virando um workspace fantasma: com
  // dados no disco, mas invisível na lista.
  if (!workspaces.some(w => w.path === oldPath)) return null;

  if (newPath !== oldPath && workspaces.some(w => w.path === newPath)) {
    return null;
  }

  const renamed: WorkspaceInfo = { name: sanitized, path: newPath };
  const updated = workspaces.map(w => (w.path === oldPath ? renamed : w));
  return { workspaces: updated, renamed };
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
  const workspaces = await listWorkspaces();
  const result = computeRenamedWorkspaces(workspaces, oldPath, newName);
  if (!result) return null;

  await saveWorkspaces(result.workspaces);
  return result.renamed;
}

export async function deleteWorkspace(path: string): Promise<void> {
  const workspaces = await listWorkspaces();
  await saveWorkspaces(workspaces.filter(w => w.path !== path));
}