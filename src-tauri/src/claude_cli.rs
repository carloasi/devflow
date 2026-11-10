// ─────────────────────────────────────────────────────────────────────────
// Painel do Claude embutido no DevFlow (DevFlow → Claude Code)
//
// Roda o `claude` em modo headless (-p com --output-format stream-json) e
// vai emitindo cada linha do stdout como evento Tauri, pro frontend montar
// a conversa. NÃO é um terminal: o modo interativo do claude é uma TUI que
// exigiria PTY + emulador de terminal; o headless devolve JSON estruturado,
// que é o que a gente quer pra renderizar com a cara do app.
//
// O prompt vai pelo STDIN, nunca por argumento. Além de não ter limite de
// tamanho nem problema de aspas, no Windows o fallback passa por `cmd /C` —
// e um prompt com `&` ou `|` em argv viraria injeção de comando.
// ─────────────────────────────────────────────────────────────────────────

use std::process::Stdio;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};

// O processo em execução, junto com o id do envio que o criou.
//
// O id existe porque o slot é um só: sem ele, clicar Stop e mandar outra
// mensagem logo em seguida fazia o fim do envio ANTIGO (que só termina de ler
// o stdout depois do kill) tirar do slot o processo NOVO — o envio velho ficava
// esperando o novo, o novo emitia "done" sem código enquanto ainda rodava, e o
// Stop seguinte não achava nada pra matar.
struct RunningChild {
    run_id: String,
    child: Child,
}

fn running_child() -> &'static Mutex<Option<RunningChild>> {
    static CHILD: OnceLock<Mutex<Option<RunningChild>>> = OnceLock::new();
    CHILD.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeLineEvent {
    // Envio a que a linha pertence: o frontend descarta o que vier de um envio
    // que ele já cancelou ou abandonou.
    run_id: String,
    // Linha crua do stream-json. O parsing fica no frontend, junto com a
    // renderização — assim adicionar suporte a um tipo de evento novo não
    // exige recompilar o Rust.
    line: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeDoneEvent {
    run_id: String,
    code: Option<i32>,
    stderr: String,
}

// Ferramentas nativas do Claude Code que o painel nunca usa. As do MCP do
// DevFlow (mcp__devflow__*) ficam de fora desta lista e seguem liberadas.
const PANEL_DISALLOWED_TOOLS: &str =
    "Bash,BashOutput,KillShell,Read,Edit,MultiEdit,Write,NotebookEdit,Glob,Grep,WebFetch,WebSearch";

/// Arquivo do --mcp-config de um envio. Apagado no Drop, então some em
/// qualquer saída do claude_send — fim normal, erro ou cancelamento.
struct TempConfigFile {
    path: std::path::PathBuf,
}

impl TempConfigFile {
    fn write(app: &AppHandle, run_id: &str, content: &str) -> Result<Self, String> {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| format!("Could not find the app config folder: {e}"))?
            .join("claude-panel");
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        // O run_id vem do frontend: no nome do arquivo só entra o que é
        // seguro num caminho.
        let safe: String = run_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .take(80)
            .collect();
        let path = dir.join(format!("mcp-{safe}.json"));
        std::fs::write(&path, content)
            .map_err(|e| format!("Could not write the MCP config for Claude: {e}"))?;
        Ok(Self { path })
    }
}

impl Drop for TempConfigFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// Mata o processo e, no Windows, a árvore inteira dele.
///
/// No fallback `cmd /C claude` (instalação via npm) o filho direto é o
/// cmd.exe; o `claude` de verdade é um node neto. O TerminateProcess do
/// start_kill derruba só o cmd.exe — o node seguia rodando, com o pipe do
/// stdout aberto, e as respostas continuavam chegando depois do Stop.
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    if let Some(pid) = child.id() {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/T", "/F", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(0x0800_0000)
            .status();
    }
    let _ = child.start_kill();
}

/// Aponta o CLI pra um diretório de configuração próprio do DevFlow.
///
/// Sem isso o `claude auth login` grava em ~/.claude, que é global do usuário:
/// logar pelo painel substituiria a conta que a pessoa já usa no terminal. Com
/// um diretório separado, o DevFlow tem a PRÓPRIA identidade — dá pra usar a
/// conta pessoal aqui e manter a outra lá fora, sem uma derrubar a outra.
///
/// Em troca, esta instância não enxerga as configurações globais (settings,
/// MCP, CLAUDE.md do usuário): é um perfil limpo. Por isso é opcional.
fn apply_config_dir(cmd: &mut Command, app: &AppHandle, isolated: bool) {
    if !isolated {
        return;
    }
    let Ok(base) = app.path().app_config_dir() else {
        return;
    };
    let dir = base.join("claude");
    // Precisa existir antes: um caminho inexistente faz o login falhar sem
    // motivo aparente.
    let _ = std::fs::create_dir_all(&dir);
    cmd.env("CLAUDE_CONFIG_DIR", dir);
}

/// Monta o comando base. No Windows, uma instalação via npm cria
/// `claude.cmd`, que o CreateProcess não executa direto — daí o fallback
/// via `cmd /C`. O instalador nativo põe um .exe de verdade, que é
/// preferido quando existe (evita passar pelo shell).
fn build_command(binary_path: Option<String>) -> Command {
    if let Some(path) = binary_path.filter(|p| !p.trim().is_empty()) {
        return Command::new(path);
    }

    #[cfg(windows)]
    {
        if let Ok(home) = std::env::var("USERPROFILE") {
            let native = std::path::Path::new(&home)
                .join(".local")
                .join("bin")
                .join("claude.exe");
            if native.exists() {
                return Command::new(native);
            }
        }
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "claude"]);
        cmd
    }

    #[cfg(not(windows))]
    {
        Command::new("claude")
    }
}

/// Estado de autenticação do CLI, cru como o `claude auth status --json`
/// devolve (loggedIn, authMethod, apiProvider, ...). O parsing fica no
/// frontend, pelo mesmo motivo do stream-json: campo novo no CLI não deve
/// exigir recompilar o Rust.
///
/// Isso responde "com qual conta o painel está falando", que antes não tinha
/// resposta nenhuma: o `claude --version` funciona igual deslogado, então dava
/// pra ter o CLI instalado, o painel "disponível", e toda mensagem falhando
/// por falta de credencial.
#[tauri::command]
pub async fn claude_auth_status(
    app: AppHandle,
    binary_path: Option<String>,
    isolated: bool,
) -> Result<String, String> {
    let mut cmd = build_command(binary_path);
    apply_config_dir(&mut cmd, &app, isolated);
    cmd.args(["auth", "status", "--json"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run the claude CLI: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();

    // Deslogado costuma sair com código != 0 mas ainda imprime o JSON; só é
    // erro de verdade quando não veio nada aproveitável.
    if stdout.is_empty() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "claude auth status returned nothing".to_string()
        } else {
            err
        });
    }

    Ok(stdout)
}

/// Abre o login numa JANELA DE TERMINAL de verdade, em vez de capturar a
/// saída. O fluxo é interativo (abre o navegador e pode pedir que o usuário
/// cole um código de volta), então rodar escondido com stdio em pipe deixaria
/// ele travado esperando uma entrada que ninguém consegue digitar.
///
/// `use_console` escolhe a origem do faturamento: false = assinatura Claude
/// (`--claudeai`), true = Anthropic Console, com cobrança por uso de API
/// (`--console`).
#[tauri::command]
pub async fn claude_auth_login(
    app: AppHandle,
    binary_path: Option<String>,
    use_console: bool,
    isolated: bool,
) -> Result<(), String> {
    let mode = if use_console { "--console" } else { "--claudeai" };

    // O binário configurado pelo usuário pode ter espaço no caminho, então vai
    // entre aspas; `start` trata o primeiro argumento entre aspas como TÍTULO
    // da janela, daí o "" antes.
    let program = binary_path
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "claude".to_string());

    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args([
            "/C",
            "start",
            "",
            "cmd",
            "/K",
            &format!("\"{program}\" auth login {mode}"),
        ]);
        // A variável precisa chegar na janela nova: é o `claude` que roda LÁ
        // que grava a credencial, e sem ela o login cairia no ~/.claude global.
        apply_config_dir(&mut cmd, &app, isolated);
        cmd.spawn()
            .map_err(|e| format!("Could not open a terminal for the login: {e}"))?;
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(program);
        cmd.args(["auth", "login", mode]);
        apply_config_dir(&mut cmd, &app, isolated);
        cmd.spawn()
            .map_err(|e| format!("Could not start the login: {e}"))?;
        Ok(())
    }
}

#[tauri::command]
pub async fn claude_auth_logout(
    app: AppHandle,
    binary_path: Option<String>,
    isolated: bool,
) -> Result<(), String> {
    let mut cmd = build_command(binary_path);
    apply_config_dir(&mut cmd, &app, isolated);
    cmd.args(["auth", "logout"]);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run the claude CLI: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "claude auth logout failed".to_string()
        } else {
            err
        });
    }

    Ok(())
}

/// Verifica se o `claude` está instalado e acessível. Devolve a versão.
#[tauri::command]
pub async fn claude_available(
    app: AppHandle,
    binary_path: Option<String>,
    isolated: bool,
) -> Result<String, String> {
    let mut cmd = build_command(binary_path);
    apply_config_dir(&mut cmd, &app, isolated);
    cmd.arg("--version");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // CREATE_NO_WINDOW: sem isso, no Windows cada chamada pisca uma janela
    // de console por cima do app. (tokio::process::Command expõe
    // creation_flags nativamente no Windows.)
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let output = cmd
        .output()
        .await
        .map_err(|e| format!("Could not run the claude CLI: {e}"))?;

    if !output.status.success() {
        let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if err.is_empty() {
            "claude --version failed".to_string()
        } else {
            err
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

#[tauri::command]
pub fn claude_cancel() {
    // Tira do slot antes de matar: o taskkill é síncrono e não deve rodar
    // segurando o lock.
    let running = running_child().lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut running) = running {
        kill_tree(&mut running.child);
    }
}

/// Envia um prompt. Emite `claude-chat-line` por linha do stream-json e
/// `claude-chat-done` no fim.
///
/// - `session_id`: continua uma conversa anterior (--resume).
/// - `mcp_config`: JSON do --mcp-config; o painel manda o servidor MCP local
///   já preenchido, então o Claude enxerga as collections sem o usuário
///   precisar rodar `claude mcp add`.
/// - `allowed_tools`: pré-aprova ferramentas (o painel não tem UI de
///   permissão, então o que não estiver aqui é negado sem travar a execução).
#[tauri::command]
pub async fn claude_send(
    app: AppHandle,
    prompt: String,
    session_id: Option<String>,
    mcp_config: Option<String>,
    allowed_tools: Option<String>,
    append_system_prompt: Option<String>,
    cwd: Option<String>,
    binary_path: Option<String>,
    api_key: Option<String>,
    isolated: bool,
    run_id: Option<String>,
) -> Result<(), String> {
    claude_cancel();

    // Frontend antigo (sem runId) continua funcionando: ganha um id local.
    let run_id = run_id.filter(|id| !id.trim().is_empty()).unwrap_or_else(|| {
        use std::sync::atomic::{AtomicU64, Ordering};
        static COUNTER: AtomicU64 = AtomicU64::new(1);
        format!("local-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
    });

    let mut cmd = build_command(binary_path);
    // Se o envio for abandonado no meio (erro ao escrever o prompt, task
    // derrubada), o processo não fica órfão.
    cmd.kill_on_drop(true);
    apply_config_dir(&mut cmd, &app, isolated);

    // Com uma chave aqui, o CLI passa a cobrar pela API (Console) em vez de
    // usar a conta logada — é assim que o Claude Code escolhe entre as duas.
    // Vai por variável de ambiente, nunca por argumento: argv é visível pra
    // qualquer processo da máquina na lista de processos, e no Windows o
    // fallback ainda passa por `cmd /C`.
    if let Some(key) = api_key.filter(|k| !k.trim().is_empty()) {
        cmd.env("ANTHROPIC_API_KEY", key.trim());
    } else {
        // Modo conta: tira qualquer ANTHROPIC_API_KEY herdada do ambiente do
        // app (variável do Windows, terminal que abriu o `tauri dev`...). O
        // CLI dá preferência a essa variável sobre a conta logada, e uma chave
        // velha ali virava "Invalid API key · Fix external API key" mesmo com
        // o painel configurado pra usar a conta Claude.
        cmd.env_remove("ANTHROPIC_API_KEY");
    }

    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages");

    // Sem prompt de permissão: nada aqui pode ficar esperando alguém
    // responder, então o que não está pré-aprovado é negado e a execução
    // continua.
    cmd.arg("--permission-mode").arg("dontAsk");

    // Só o MCP do DevFlow, nunca os do usuário. Sem isto, com o perfil
    // compartilhado (isolated=false) o painel carregava também os servidores
    // MCP globais da pessoa (~/.claude.json).
    cmd.arg("--strict-mcp-config");
    // Nem shell, nem arquivo, nem web. O dontAsk só nega o que não está
    // pré-aprovado — e no perfil compartilhado valem as regras de allow globais
    // do usuário (um "Bash(*)" no settings.json dele, por exemplo). O system
    // prompt do painel já diz que essas ferramentas não existem aqui; isto faz
    // valer.
    cmd.arg("--disallowedTools").arg(PANEL_DISALLOWED_TOOLS);

    if let Some(tools) = allowed_tools.filter(|t| !t.trim().is_empty()) {
        cmd.arg("--allowedTools").arg(tools);
    }
    // O config leva o token do MCP. Por argv ele ficava visível na lista de
    // processos — o mesmo motivo que já fazia a API key ir por variável de
    // ambiente. Vai num arquivo do diretório do app, apagado no fim do envio.
    let _mcp_config_file = match mcp_config.filter(|c| !c.trim().is_empty()) {
        Some(config) => {
            let file = TempConfigFile::write(&app, &run_id, &config)?;
            cmd.arg("--mcp-config").arg(&file.path);
            Some(file)
        }
        None => None,
    };
    if let Some(extra) = append_system_prompt.filter(|s| !s.trim().is_empty()) {
        cmd.arg("--append-system-prompt").arg(extra);
    }
    if let Some(id) = session_id.filter(|s| !s.trim().is_empty()) {
        cmd.arg("--resume").arg(id);
    }
    if let Some(dir) = cwd.filter(|d| !d.trim().is_empty()) {
        cmd.current_dir(dir);
    }

    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // CREATE_NO_WINDOW: sem isso, no Windows cada chamada pisca uma janela
    // de console por cima do app. (tokio::process::Command expõe
    // creation_flags nativamente no Windows.)
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Could not start the claude CLI: {e}"))?;

    // Prompt pelo stdin (ver comentário no topo do arquivo).
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(prompt.as_bytes())
            .await
            .map_err(|e| format!("Failed to send the prompt: {e}"))?;
        stdin.flush().await.ok();
        // Fecha o stdin: sem isso o claude fica esperando mais entrada.
        drop(stdin);
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    if let Ok(mut slot) = running_child().lock() {
        *slot = Some(RunningChild {
            run_id: run_id.clone(),
            child,
        });
    }

    // stderr num task à parte, pra não bloquear a leitura do stdout.
    let stderr_task = tokio::spawn(async move {
        let mut collected = String::new();
        if let Some(err) = stderr {
            let mut lines = BufReader::new(err).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                collected.push_str(&line);
                collected.push('\n');
            }
        }
        collected
    });

    if let Some(out) = stdout {
        let mut lines = BufReader::new(out).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }
                    let _ = app.emit(
                        "claude-chat-line",
                        ClaudeLineEvent {
                            run_id: run_id.clone(),
                            line,
                        },
                    );
                }
                Ok(None) => break,
                Err(e) => {
                    log::warn!("claude stdout read error: {e}");
                    break;
                }
            }
        }
    }

    // Tira o child do mutex ANTES do await: o guard do std::sync::Mutex não
    // é Send, então segurá-lo através de um .await nem compila.
    //
    // Só leva o que é DESTE envio. Se o slot tem outro id, este foi cancelado
    // e um envio novo já ocupou o lugar — aquele processo não é nosso.
    let child_opt = {
        let mut slot = running_child().lock().map_err(|e| e.to_string())?;
        if slot.as_ref().is_some_and(|r| r.run_id == run_id) {
            slot.take()
        } else {
            None
        }
    };

    let status = match child_opt {
        Some(mut running) => running.child.wait().await.ok(),
        None => None, // cancelado pelo usuário (ou substituído por outro envio)
    };

    let stderr_text = stderr_task.await.unwrap_or_default();

    let _ = app.emit(
        "claude-chat-done",
        ClaudeDoneEvent {
            run_id,
            code: status.and_then(|s| s.code()),
            stderr: stderr_text,
        },
    );

    Ok(())
}
