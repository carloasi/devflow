import { LazyStore } from '@tauri-apps/plugin-store';
import { TabSession } from '@/components/TabSessionSelector';

// Arquivo próprio em app_data_dir — sobrevive à limpeza de localStorage/cache do webview.
// autoSave com debounce de 300ms evita gravar em disco a cada tecla ao renomear.
const store = new LazyStore('tab-sessions.json', { autoSave: 300 });

const SESSIONS_KEY = 'sessions';
const CURRENT_ID_KEY = 'currentSessionId';

// Migração única: se ainda existir dado antigo em localStorage e o store
// estiver vazio, importa uma vez e depois limpa o localStorage.
// A promise é cacheada pra garantir que, mesmo se loadTabSessions e
// loadCurrentSessionId forem chamados em paralelo, a migração roda uma única vez.
let migrationPromise: Promise<void> | null = null;

function migrateLegacyIfNeeded(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      const alreadyMigrated = await store.get<boolean>('migratedFromLocalStorage');
      if (alreadyMigrated) return;

      try {
        const legacySessions = localStorage.getItem('postman_clone_tab_sessions');
        const legacyCurrentId = localStorage.getItem('postman_clone_current_session_id');

        if (legacySessions) {
          await store.set(SESSIONS_KEY, JSON.parse(legacySessions));
          localStorage.removeItem('postman_clone_tab_sessions');
        }
        if (legacyCurrentId) {
          await store.set(CURRENT_ID_KEY, legacyCurrentId);
          localStorage.removeItem('postman_clone_current_session_id');
        }
      } catch (e) {
        console.error('Erro ao migrar sessões antigas:', e);
      } finally {
        await store.set('migratedFromLocalStorage', true);
      }
    })();
  }
  return migrationPromise;
}

export async function loadTabSessions(): Promise<TabSession[]> {
  await migrateLegacyIfNeeded();
  return (await store.get<TabSession[]>(SESSIONS_KEY)) ?? [];
}

export async function saveTabSessions(sessions: TabSession[]): Promise<void> {
  await store.set(SESSIONS_KEY, sessions);
}

export async function loadCurrentSessionId(): Promise<string | null> {
  await migrateLegacyIfNeeded();
  return (await store.get<string>(CURRENT_ID_KEY)) ?? null;
}

export async function saveCurrentSessionId(id: string | null): Promise<void> {
  if (id) await store.set(CURRENT_ID_KEY, id);
  else await store.delete(CURRENT_ID_KEY);
}

// import { LazyStore } from '@tauri-apps/plugin-store';
// import { TabSession } from '@/components/TabSessionSelector';

// // Arquivo próprio em app_data_dir — sobrevive à limpeza de localStorage/cache do webview.
// // autoSave com debounce de 300ms evita gravar em disco a cada tecla ao renomear.
// const store = new LazyStore('tab-sessions.json', { autoSave: 300 });

// const SESSIONS_KEY = 'sessions';
// const CURRENT_ID_KEY = 'currentSessionId';

// // Migração única: se ainda existir dado antigo em localStorage e o store
// // estiver vazio, importa uma vez e depois limpa o localStorage.
// async function migrateLegacyIfNeeded(): Promise<void> {
//   const alreadyMigrated = await store.get<boolean>('migratedFromLocalStorage');
//   if (alreadyMigrated) return;

//   try {
//     const legacySessions = localStorage.getItem('postman_clone_tab_sessions');
//     const legacyCurrentId = localStorage.getItem('postman_clone_current_session_id');

//     if (legacySessions) {
//       await store.set(SESSIONS_KEY, JSON.parse(legacySessions));
//       localStorage.removeItem('postman_clone_tab_sessions');
//     }
//     if (legacyCurrentId) {
//       await store.set(CURRENT_ID_KEY, legacyCurrentId);
//       localStorage.removeItem('postman_clone_current_session_id');