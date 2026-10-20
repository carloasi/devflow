import { LazyStore } from '@tauri-apps/plugin-store';
import { Tab } from '@/app/types/Tab';
import type { TabGroup } from '@/lib/tabGroups';

// Arquivo próprio em app_data_dir — sobrevive à limpeza de localStorage/cache do webview.
// autoSave com debounce de 300ms evita gravar em disco a cada tecla digitada.
const store = new LazyStore('open-tabs.json', { autoSave: 300 });

const TABS_KEY_PREFIX = 'tabs';
const ACTIVE_TAB_KEY_PREFIX = 'activeTabId';
// Grupos da barra. Chave própria, no mesmo arquivo das abas: eles só fazem
// sentido junto delas, e separar em outro arquivo abriria a chance de um ser
// gravado sem o outro.
const TAB_GROUPS_KEY_PREFIX = 'tabGroups';

// Workspace "" (GitHub Sync não configurado / ainda não resolvido) cai no
// bucket "default" — é também o destino da migração de dados legados,
// que eram globais (uma única lista de tabs pra todo o app).
function workspaceKey(prefix: string, workspace: string): string {
  const suffix = workspace || 'default';
  return `${prefix}:${suffix}`;
}

let migrationPromise: Promise<void> | null = null;

function migrateLegacyIfNeeded(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const alreadyMigrated = await store.get<boolean>('migratedFromLocalStorage');
      if (alreadyMigrated) return;

      try {
        const legacyTabs = localStorage.getItem('postman_clone_tabs');
        const legacyActiveId = localStorage.getItem('postman_clone_active_tab');

        // Dados legados eram globais — não pertenciam a nenhum workspace
        // específico, então migram pro bucket "default".
        if (legacyTabs) {
          await store.set(workspaceKey(TABS_KEY_PREFIX, ''), JSON.parse(legacyTabs));
          localStorage.removeItem('postman_clone_tabs');
        }
        if (legacyActiveId) {
          await store.set(workspaceKey(ACTIVE_TAB_KEY_PREFIX, ''), legacyActiveId);
          localStorage.removeItem('postman_clone_active_tab');
        }
      } catch (e) {
        console.error('Erro ao migrar tabs antigas:', e);
      } finally {
        await store.set('migratedFromLocalStorage', true);
      }
    })();
  }
  return migrationPromise;
}

// `requestHeadersValue` mudou de Record<string,string> pra um array
// {id,key,value,enabled} (ver Tab.ts — o Record não conseguia representar
// header desabilitado sem apagar ele). Tabs já salvas em disco ANTES dessa
// mudança ainda têm o formato antigo (um objeto, não array) — sem essa
// migração, `.forEach`/`.map`/`.some` chamados nesse campo (buildFinalHeaders,
// HeadersManager, etc) quebravam com "forEach is not a function" assim que a
// tab salva era recarregada.
function migrateTabHeaders(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => {
    const raw = tab.requestHeadersValue as unknown;
    if (Array.isArray(raw)) return tab;

    const record = (raw && typeof raw === 'object' ? raw : {}) as Record<string, string>;
    return {
      ...tab,
      requestHeadersValue: Object.entries(record).map(([key, value]) => ({
        id: crypto.randomUUID(),
        key,
        value,
        enabled: true,
      })),
    };
  });
}

export async function loadTabs(workspace: string): Promise<Tab[]> {
  await migrateLegacyIfNeeded();
  const tabs = (await store.get<Tab[]>(workspaceKey(TABS_KEY_PREFIX, workspace))) ?? [];
  return migrateTabHeaders(tabs);
}

export async function saveTabs(workspace: string, tabs: Tab[]): Promise<void> {
  await store.set(workspaceKey(TABS_KEY_PREFIX, workspace), tabs);
}

export async function loadTabGroups(workspace: string): Promise<TabGroup[]> {
  const groups = await store.get<TabGroup[]>(workspaceKey(TAB_GROUPS_KEY_PREFIX, workspace));
  return Array.isArray(groups) ? groups : [];
}

export async function saveTabGroups(workspace: string, groups: TabGroup[]): Promise<void> {
  await store.set(workspaceKey(TAB_GROUPS_KEY_PREFIX, workspace), groups);
}

export async function loadActiveTabId(workspace: string): Promise<string | null> {
  await migrateLegacyIfNeeded();
  return (await store.get<string>(workspaceKey(ACTIVE_TAB_KEY_PREFIX, workspace))) ?? null;
}

export async function saveActiveTabId(workspace: string, id: string | null): Promise<void> {
  const key = workspaceKey(ACTIVE_TAB_KEY_PREFIX, workspace);
  if (id) await store.set(key, id);
  else await store.delete(key);
}

// import { LazyStore } from '@tauri-apps/plugin-store';
// import { Tab } from '@/app/types/Tab';

// // Arquivo próprio em app_data_dir — sobrevive à limpeza de localStorage/cache do webview.
// // autoSave com debounce de 300ms evita gravar em disco a cada tecla digitada.
// const store = new LazyStore('open-tabs.json', { autoSave: 300 });

// const TABS_KEY = 'tabs';
// const ACTIVE_TAB_KEY = 'activeTabId';

// let migrationPromise: Promise<void> | null = null;

// function migrateLegacyIfNeeded(): Promise<void> {
//   if (!migrationPromise) {
//     migrationPromise = (async () => {
//       const alreadyMigrated = await store.get<boolean>('migratedFromLocalStorage');
//       if (alreadyMigrated) return;

//       try {
//         const legacyTabs = localStorage.getItem('postman_clone_tabs');
//         const legacyActiveId = localStorage.getItem('postman_clone_active_tab');

//         if (legacyTabs) {
//           await store.set(TABS_KEY, JSON.parse(legacyTabs));
//           localStorage.removeItem('postman_clone_tabs');
//         }
//         if (legacyActiveId) {
//           await store.set(ACTIVE_TAB_KEY, legacyActiveId);
//           localStorage.removeItem('postman_clone_active_tab');