// ─────────────────────────────────────────────────────────────────────────
// Extensões do DevFlow — leitura do disco e scaffold.
//
// Uma extensão é só uma pasta com um manifesto e um HTML. O Rust aqui não
// executa nada dela: lê, valida o manifesto e devolve o conteúdo pro
// frontend, que renderiza dentro de um iframe isolado (ver
// src/extensions/useExtensionHost.ts).
//
// Duas origens:
//   • instaladas  → %APPDATA%/<identificador>/extensions/<id>/
//   • dev         → qualquer pasta que o usuário apontar nas Settings, pra
//                   desenvolver sem ficar copiando arquivo pro AppData.
// ─────────────────────────────────────────────────────────────────────────

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionManifest {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default = "default_entry")]
    entry: String,
    #[serde(default)]
    contributes: serde_json::Value,
    #[serde(default)]
    permissions: Vec<String>,
    #[serde(default)]
    description: String,
}

fn default_entry() -> String {
    "index.html".to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionRecord {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub contributes: serde_json::Value,
    pub permissions: Vec<String>,
    pub path: String,
    /// "installed" ou "dev"
    pub source: String,
    /// Conteúdo do arquivo de entrada. Vai pro iframe via srcdoc — por isso
    /// já sobe junto, em vez de o frontend fazer outra chamada por arquivo.
    pub html: String,
    /// Preenchido quando a pasta existe mas não deu pra carregar; a extensão
    /// aparece na lista marcada como quebrada em vez de sumir sem explicação.
    pub error: Option<String>,
}

fn extensions_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Could not resolve the app data folder: {e}"))?;
    Ok(base.join("extensions"))
}

fn broken(path: &Path, message: String) -> ExtensionRecord {
    let fallback_id = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "unknown".to_string());

    ExtensionRecord {
        id: fallback_id.clone(),
        name: fallback_id,
        version: String::new(),
        description: String::new(),
        contributes: serde_json::Value::Null,
        permissions: Vec::new(),
        path: path.to_string_lossy().to_string(),
        source: String::new(),
        html: String::new(),
        error: Some(message),
    }
}

fn read_extension(path: &Path, source: &str) -> ExtensionRecord {
    let manifest_path = path.join("devflow-extension.json");

    let raw = match fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(e) => return broken(path, format!("devflow-extension.json not found or unreadable: {e}")),
    };

    let manifest: ExtensionManifest = match serde_json::from_str(&raw) {
        Ok(m) => m,
        Err(e) => return broken(path, format!("Invalid manifest: {e}")),
    };

    if manifest.id.trim().is_empty() {
        return broken(path, "Manifest is missing an \"id\".".to_string());
    }

    // Impede que o manifesto aponte pra fora da pasta da extensão
    // (ex: "../../settings.json").
    if manifest.entry.contains("..") {
        return broken(path, "The \"entry\" path cannot navigate outside the extension folder.".to_string());
    }

    let html = match fs::read_to_string(path.join(&manifest.entry)) {
        Ok(text) => text,
        Err(e) => return broken(path, format!("Could not read \"{}\": {e}", manifest.entry)),
    };

    ExtensionRecord {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        contributes: manifest.contributes,
        permissions: manifest.permissions,
        path: path.to_string_lossy().to_string(),
        source: source.to_string(),
        html,
        error: None,
    }
}

/// Lista as extensões instaladas mais as pastas de desenvolvimento passadas
/// pelo frontend (guardadas nas settings do app).
#[tauri::command]
pub fn list_extensions(app: AppHandle, dev_paths: Vec<String>) -> Result<Vec<ExtensionRecord>, String> {
    let mut found: Vec<ExtensionRecord> = Vec::new();

    let installed_root = extensions_dir(&app)?;
    if installed_root.is_dir() {
        let entries = fs::read_dir(&installed_root)
            .map_err(|e| format!("Could not read the extensions folder: {e}"))?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                found.push(read_extension(&path, "installed"));
            }
        }
    }

    for dev in dev_paths {
        let path = PathBuf::from(&dev);
        if path.is_dir() {
            found.push(read_extension(&path, "dev"));
        } else {
            found.push(broken(&path, "Folder not found.".to_string()));
        }
    }

    Ok(found)
}

/// Caminho da pasta de extensões instaladas — mostrado nas Settings pra
/// pessoa saber onde as coisas moram.
#[tauri::command]
pub fn extensions_folder(app: AppHandle) -> Result<String, String> {
    Ok(extensions_dir(&app)?.to_string_lossy().to_string())
}

/// Escreve um exemplo funcionando numa pasta. Sem isso, criar uma extensão
/// exigiria ler documentação antes de ver qualquer coisa na tela; assim a
/// pessoa abre um arquivo que já roda e vai editando.
#[tauri::command]
pub fn scaffold_extension(dir: String, id: String) -> Result<String, String> {
    let root = PathBuf::from(&dir);
    if !root.is_dir() {
        return Err("Pick an existing folder.".to_string());
    }

    let safe_id = id
        .trim()
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect::<String>();
    let safe_id = if safe_id.is_empty() { "my-extension".to_string() } else { safe_id };

    let target = root.join(&safe_id);
    if target.exists() {
        return Err(format!("\"{}\" already exists in that folder.", safe_id));
    }
    fs::create_dir_all(&target).map_err(|e| format!("Could not create the folder: {e}"))?;

    let manifest = format!(
        r#"{{
  "id": "{safe_id}",
  "name": "My extension",
  "version": "1.0.0",
  "description": "A clock in the status bar that also compares dates.",
  "entry": "index.html",
  "contributes": {{
    "statusBarItems": [{{ "id": "clock" }}]
  }},
  "permissions": ["storage"]
}}
"#
    );

    fs::write(target.join("devflow-extension.json"), manifest)
        .map_err(|e| format!("Could not write the manifest: {e}"))?;
    fs::write(target.join("index.html"), SCAFFOLD_HTML)
        .map_err(|e| format!("Could not write index.html: {e}"))?;
    fs::write(target.join("devflow.d.ts"), SCAFFOLD_TYPES)
        .map_err(|e| format!("Could not write devflow.d.ts: {e}"))?;

    Ok(target.to_string_lossy().to_string())
}

// O exemplo é justamente o relógio com diferença de datas — a mesma feature
// que existe embutida no app. Serve de prova de que a API dá pra reconstruir
// algo real, e de ponto de partida pra quem for escrever a própria.
const SCAFFOLD_HTML: &str = r#"<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <style>
      /* O host injeta as CSS variables do tema do DevFlow, então usar
         var(--color-pm-*) faz a extensão acompanhar o tema escolhido. */
      body {
        margin: 0;
        font-family: system-ui, sans-serif;
        color: var(--color-pm-text-muted, #9aa0a6);
        background: transparent;
        overflow: hidden;
      }
      #bar { display: flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; cursor: pointer; font-size: 11px; }
      #bar:hover { color: var(--color-pm-text, #e8eaed); }
      #panel { display: none; padding: 10px; }
      #panel.open { display: block; }
      input { width: 100%; box-sizing: border-box; margin-bottom: 6px; padding: 6px; font-size: 12px;
              color: var(--color-pm-text, #e8eaed); background: var(--color-pm-hover, #2a2a2a);
              border: 1px solid var(--color-pm-border, #3a3a3a); border-radius: 6px; outline: none; }
      #result { font-size: 12px; color: var(--color-pm-text, #e8eaed); min-height: 32px; }
    </style>
  </head>
  <body>
    <div id="bar"><span id="clock"></span></div>

    <div id="panel">
      <input id="date" placeholder="Paste or type a date..." />
      <div id="result">Difference from now appears here.</div>
    </div>

    <script>
      const bar = document.getElementById('bar');
      const panel = document.getElementById('panel');
      const clock = document.getElementById('clock');
      const dateInput = document.getElementById('date');
      const result = document.getElementById('result');

      // Dentro do iframe existe um contexto de navegador de verdade, então
      // setInterval funciona normalmente (diferente do sandbox dos scripts
      // de request, que roda em QuickJS sem timers).
      setInterval(tick, 1000);
      tick();

      function tick() {
        clock.textContent = new Date().toLocaleString();
        if (!panel.classList.contains('open')) {
          // Widget de status bar: o host não sabe a largura do conteúdo, a
          // extensão informa.
          devflow.ui.resize({ width: bar.scrollWidth, height: 22 });
        }
      }

      bar.addEventListener('click', () => {
        const opening = !panel.classList.contains('open');
        panel.classList.toggle('open', opening);
        // Um popover não caberia nos 22px do widget — o host cresce o
        // iframe pra cima quando a extensão pede expansão.
        if (opening) devflow.ui.expand({ width: 300, height: 130 });
        else devflow.ui.collapse();
      });

      dateInput.addEventListener('input', () => {
        const parsed = new Date(dateInput.value.trim());
        if (!dateInput.value.trim() || isNaN(parsed.getTime())) {
          result.textContent = 'Difference from now appears here.';
          return;
        }
        const diffMs = Date.now() - parsed.getTime();
        const abs = Math.abs(diffMs);
        const days = Math.floor(abs / 86400000);
        const hours = Math.floor((abs % 86400000) / 3600000);
        const minutes = Math.floor((abs % 3600000) / 60000);
        result.textContent =
          days + 'd ' + hours + 'h ' + minutes + 'm ' + (diffMs >= 0 ? 'ago' : 'from now');

        // Storage é isolado por extensão: outra extensão não enxerga isso.
        devflow.storage.set('lastDate', dateInput.value);
      });

      devflow.storage.get('lastDate').then(saved => {
        if (saved) dateInput.value = saved;
      });
    </script>
  </body>
</html>
"#;

const SCAFFOLD_TYPES: &str = r#"// Tipos da API disponível dentro de uma extensão do DevFlow.
// O objeto `devflow` é injetado pelo host — não precisa importar nada.

interface DevflowApi {
  /** Operações sobre as requests do workspace atual. */
  requests: {
    /** Requer a permissão "requests:read". */
    list(params?: { search?: string }): Promise<any>;
    /** Requer a permissão "requests:read". */
    get(params: { requestId: string }): Promise<any>;
    /** Requer a permissão "requests:run". Executa com o motor do app. */
    run(params: { requestId: string; environment?: string }): Promise<any>;
  };
  /** Resposta que está na tela. Requer "response:read". */
  response: {
    get(params?: { requestId?: string; maxBytes?: number }): Promise<any>;
  };
  /** Environments do workspace (só nomes de variável). Requer "environments:read". */
  environments: {
    list(): Promise<any>;
  };
  /** Chave/valor isolado por extensão. Requer "storage". */
  storage: {
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
  ui: {
    /** Ajusta o tamanho do widget (status bar não sabe a largura do conteúdo). */
    resize(size: { width: number; height: number }): Promise<void>;
    /** Abre o widget como painel flutuante ancorado. */
    expand(size: { width: number; height: number }): Promise<void>;
    /** Volta ao tamanho de widget. */
    collapse(): Promise<void>;
    /** Mensagem curta na interface do app. */
    toast(message: string): Promise<void>;
  };
}

declare const devflow: DevflowApi;
"#;
