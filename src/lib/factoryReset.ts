import { LazyStore } from '@tauri-apps/plugin-store';
import { deleteSecret } from '@/lib/secureStorage';

const GH_TOKEN_KEY = 'gh_sync_token';

// Todo arquivo de Tauri Store usado pelo app:
// - workspaces.json / open-tabs.json / active-environment.json / tab-sessions.json
//   (workspaceStore.ts, tabsStore.ts, activeEnvironmentStore.ts, tabSessionsStore.ts)
// - runner-history.json: último run de cada collection (runHistory.ts)
// - sync-base.json: estado comum da última sincronização (syncBase.ts)
// - settings.json: compartilhado por store_get/set/delete e save_local_store no
//   backend Rust — guarda collections e environments de TODOS os workspaces
//   (gh_local_collections_*/gh_local_environments_*), a config do GitHub sync
//   (gh_sync_config) e o histórico de load test (load_test_history:*).
const STORE_FILES = [
  'settings.json',
  'workspaces.json',
  'open-tabs.json',
  'active-environment.json',
  'tab-sessions.json',
  'runner-history.json',
  'sync-base.json',
];

// Apaga TUDO que o app persiste — coleções, environments, workspaces, abas,
// config e token do GitHub sync, histórico de respostas/load test e
// preferências de UI (tema, zoom, tamanhos de painel) — deixando o app como
// se tivesse acabado de ser instalado. Usado pelo botão "Reset everything"
// nas configurações. Não tem como desfazer.
export async function resetAppToFactoryDefaults(): Promise<void> {
  await Promise.all(
    STORE_FILES.map(async (file) => {
      const store = new LazyStore(file);
      await store.clear();
      await store.save();
    })
  );

  // O token do GitHub fica no Credential Manager do Windows (keyring), fora
  // dos stores acima — precisa ser apagado à parte. Falhar aqui (ex: nenhum
  // token salvo) não pode impedir o resto do reset.
  try {
    await deleteSecret(GH_TOKEN_KEY);
  } catch (err) {
    console.error('Erro ao apagar o token do GitHub durante o reset:', err);
  }

  // Tema, zoom, histórico de respostas, indicador de pending push, tamanhos
  // de painel etc. — tudo específico desse app, já que o webview do Tauri
  // tem origem própria e exclusiva.
  localStorage.clear();
}
