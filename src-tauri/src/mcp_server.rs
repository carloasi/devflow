// ─────────────────────────────────────────────────────────────────────────
// Servidor MCP local (Claude Code → DevFlow)
//
// Este módulo é SÓ TRANSPORTE. Ele não sabe nada sobre collections,
// environments ou execução de request: recebe um JSON-RPC via HTTP em
// 127.0.0.1, repassa pro frontend por evento Tauri, espera a resposta e
// devolve pro cliente.
//
// O motivo de a lógica ficar no frontend: todo o pipeline de execução
// (resolução multi-passe de {{vars}}, path params, os tipos de auth,
// sanitização do body, scripts pre/post) já existe em TypeScript
// (runCollectionRequest.ts). Reimplementar isso em Rust criaria duas
// versões que divergem na primeira mudança.
//
// Segurança: escuta só em 127.0.0.1 e exige `Authorization: Bearer <token>`
// em toda requisição. Sem isso, qualquer processo local conseguiria disparar
// requests autenticadas usando os seus environments.
//
// Quem está conectado: o MCP por HTTP não mantém conexão aberta (cada chamada
// é uma requisição). No `initialize` o servidor entrega um `Mcp-Session-Id`,
// que o cliente devolve em toda chamada e encerra com DELETE; junto com o
// User-Agent, isso vai pro frontend, que monta a lista de sessões.
// ─────────────────────────────────────────────────────────────────────────

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

// Requisição aguardando resposta do frontend. O prazo é renovado pelo
// heartbeat (mcp_heartbeat) enquanto a ferramenta trabalha.
struct PendingEntry {
    tx: oneshot::Sender<String>,
    deadline: Instant,
    // Sessão MCP da chamada: encerrar a sessão no painel devolve erro a ela.
    session: Option<String>,
}

// Resposta interna que o mcp_end_session manda pra uma chamada pendurada da
// sessão encerrada: o laço de espera troca pelo erro JSON-RPC com o id certo.
const ENDED_SENTINEL: &str = "\u{0}devflow-session-ended";

// Sessões encerradas pelo usuário no painel do DevFlow. Chamada com uma delas
// recebe 404 — pela especificação, o cliente precisa abrir sessão nova
// (initialize) — em vez de seguir usando o servidor sem ninguém ver.
fn ended_sessions() -> &'static Mutex<HashSet<String>> {
    static ENDED: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
    ENDED.get_or_init(|| Mutex::new(HashSet::new()))
}

// Requisições aguardando resposta do frontend, por id.
type PendingMap = Mutex<HashMap<u64, PendingEntry>>;

fn pending() -> &'static PendingMap {
    static PENDING: OnceLock<PendingMap> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_id() -> u64 {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNTER: AtomicU64 = AtomicU64::new(1);
    COUNTER.fetch_add(1, Ordering::Relaxed)
}

// Handle da task do listener, pra conseguir parar o servidor. Mutex do tokio
// porque start/stop ESPERAM o listener antigo morrer segurando o lock: assim
// dois starts seguidos (o religar da abertura roda duas vezes no modo dev, o
// "Regenerate token" reinicia) entram em fila em vez de se cruzarem.
fn server_task() -> &'static tokio::sync::Mutex<Option<JoinHandle<()>>> {
    static TASK: OnceLock<tokio::sync::Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
    TASK.get_or_init(|| tokio::sync::Mutex::new(None))
}

fn server_token() -> &'static Mutex<String> {
    static TOKEN: OnceLock<Mutex<String>> = OnceLock::new();
    TOKEN.get_or_init(|| Mutex::new(String::new()))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpRequestEvent {
    id: u64,
    // Corpo JSON-RPC cru, repassado sem interpretar.
    payload: String,
    // Sessão MCP da chamada (nova, no initialize; senão a que o cliente mandou).
    session_id: Option<String>,
    user_agent: Option<String>,
    // Marca que o próprio DevFlow põe no painel do Claude (X-DevFlow-Client).
    client_tag: Option<String>,
}

// Fora do fluxo de pedido/resposta: sessão encerrada (DELETE) ou chamada
// recusada por token. Serve só pra tela de conexões.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct McpActivityEvent {
    kind: &'static str,
    session_id: Option<String>,
    user_agent: Option<String>,
    // "missing" (sem Authorization) ou "wrong" (token diferente).
    reason: Option<&'static str>,
}

// Tempo máximo SEM SINAL DE VIDA do frontend. Existe pra uma janela travada
// (ou o handler quebrado) não deixar conexões penduradas pra sempre do lado do
// Claude Code.
//
// Não é mais um teto pra ferramenta: run_collection, run_load_test e o login
// do get_oauth2_token levam minutos, e um teto fixo de 120 s devolvia "Timed
// out" ao agente enquanto o fluxo seguia batendo na API real — e o agente,
// achando que falhou, rodava de novo. O frontend manda heartbeat enquanto
// trabalha; só o silêncio dele estoura o prazo.
const FRONTEND_IDLE_TIMEOUT_SECS: u64 = 120;

// Intervalo do keepalive SSE. O cliente HTTP do Claude Code (undici) desiste
// de uma resposta que fica 300 s sem mandar nada — nem cabeçalho, nem byte de
// corpo. Mandar o cabeçalho na hora e um comentário SSE de tempos em tempos
// mantém a conexão viva durante ferramentas longas.
const SSE_KEEPALIVE_SECS: u64 = 15;

// Portas fixas de reserva, ABAIXO da faixa dinâmica do Windows (49152–65535).
// É nessa faixa que o SO sorteia porta efêmera e que o Hyper-V/WSL reserva
// blocos novos a cada boot — uma porta efêmera salva hoje costuma recusar o
// bind amanhã, e a URL do `claude mcp add` muda junto. Com estas, a porta só
// muda se as dez estiverem ocupadas. O frontend usa a primeira como padrão.
const STABLE_PORTS: std::ops::RangeInclusive<u16> = 37650..=37659;

/// O frontend devolve aqui o resultado de uma requisição repassada.
#[tauri::command]
pub fn mcp_respond(id: u64, payload: String) {
    let entry = pending().lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(entry) = entry {
        let _ = entry.tx.send(payload);
    }
}

/// Encerra uma sessão MCP (botão "Disconnect" do painel): as próximas
/// chamadas dela recebem 404 e as que estão esperando resposta voltam com
/// erro na hora. A ferramenta que já estava rodando no app termina lá, mas o
/// resultado não vai mais pro cliente.
#[tauri::command]
pub fn mcp_end_session(session_id: String) {
    let session_id = session_id.trim().to_string();
    if session_id.is_empty() {
        return;
    }
    if let Ok(mut ended) = ended_sessions().lock() {
        ended.insert(session_id.clone());
    }
    let waiting: Vec<PendingEntry> = pending()
        .lock()
        .map(|mut map| {
            let ids: Vec<u64> = map
                .iter()
                .filter(|(_, e)| e.session.as_deref() == Some(session_id.as_str()))
                .map(|(id, _)| *id)
                .collect();
            ids.into_iter().filter_map(|id| map.remove(&id)).collect()
        })
        .unwrap_or_default();
    for entry in waiting {
        let _ = entry.tx.send(ENDED_SENTINEL.to_string());
    }
}

/// Sinal de vida do frontend enquanto uma ferramenta roda: empurra o prazo.
#[tauri::command]
pub fn mcp_heartbeat(id: u64) {
    if let Ok(mut map) = pending().lock() {
        if let Some(entry) = map.get_mut(&id) {
            entry.deadline = Instant::now() + Duration::from_secs(FRONTEND_IDLE_TIMEOUT_SECS);
        }
    }
}

// Para o listener atual e ESPERA ele soltar a porta. Antes o abort só
// agendava o cancelamento e o bind seguinte na mesma porta falhava (ainda
// ocupada), caindo pra uma porta sorteada — a URL registrada no cliente MCP
// mudava a cada abertura do app em modo dev.
async fn stop_listener(slot: &mut Option<JoinHandle<()>>) {
    if let Some(handle) = slot.take() {
        handle.abort();
        let _ = handle.await;
    }
    if let Ok(mut map) = pending().lock() {
        map.clear();
    }
}

async fn bind_first(port: u16) -> Result<TcpListener, String> {
    let mut candidates: Vec<u16> = Vec::new();
    if port != 0 {
        candidates.push(port);
    }
    candidates.extend(STABLE_PORTS.filter(|p| *p != port));

    // A porta pedida ocupada costuma ser o próprio DevFlow saindo (o modo dev
    // sobe o processo novo antes de o antigo soltar a porta): espera um pouco
    // antes de desistir dela, senão a URL registrada no cliente muda à toa.
    if port != 0 {
        for _ in 0..12 {
            match TcpListener::bind(("127.0.0.1", port)).await {
                Ok(listener) => return Ok(listener),
                Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(_) => break,
            }
        }
    }

    let mut last_error = String::new();
    for candidate in candidates {
        match TcpListener::bind(("127.0.0.1", candidate)).await {
            Ok(listener) => return Ok(listener),
            Err(e) => {
                log::warn!("MCP: 127.0.0.1:{candidate} indisponível ({e})");
                last_error = format!("127.0.0.1:{candidate}: {e}");
            }
        }
    }

    // Último recurso: qualquer porta livre. Perder a porta fixa é melhor que
    // não ligar; o frontend avisa que a URL mudou.
    TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| {
        format!("No port available for the MCP server (last tried {last_error}; ephemeral: {e})")
    })
}

/// Inicia o servidor. Devolve a porta efetivamente usada: a pedida, senão uma
/// das portas fixas de reserva, senão uma livre escolhida pelo SO.
#[tauri::command]
pub async fn start_mcp_server(app: AppHandle, port: u16, token: String) -> Result<u16, String> {
    if token.trim().is_empty() {
        return Err("MCP token cannot be empty".to_string());
    }

    let mut slot = server_task().lock().await;
    stop_listener(&mut slot).await;
    if let Ok(mut ended) = ended_sessions().lock() {
        ended.clear();
    }

    let listener = bind_first(port).await?;
    let bound_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    if let Ok(mut current) = server_token().lock() {
        *current = token;
    }

    let handle = tokio::spawn(async move {
        loop {
            let (stream, _addr) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    log::warn!("MCP accept error: {e}");
                    continue;
                }
            };

            let app_for_conn = app.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(stream, app_for_conn).await {
                    log::warn!("MCP connection error: {e}");
                }
            });
        }
    });

    *slot = Some(handle);
    Ok(bound_port)
}

#[tauri::command]
pub async fn stop_mcp_server() {
    let mut slot = server_task().lock().await;
    stop_listener(&mut slot).await;
}

// Id de sessão MCP. Não precisa ser segredo (quem autoriza é o token), só
// único: relógio em nanossegundos + contador.
fn new_session_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("df-{nanos:x}-{:x}", next_id())
}

fn emit_activity(app: &AppHandle, event: McpActivityEvent) {
    let _ = app.emit("mcp-activity", event);
}

// `Authorization: Bearer <token>`, sem diferenciar maiúscula no esquema.
fn bearer_token(header: &str) -> Option<&str> {
    let header = header.trim();
    if header.len() > 7 && header[..7].eq_ignore_ascii_case("bearer ") {
        Some(header[7..].trim())
    } else {
        None
    }
}

async fn handle_connection(
    mut stream: tokio::net::TcpStream,
    app: AppHandle,
) -> Result<(), String> {
    // ── Lê a requisição HTTP: cabeçalhos até \r\n\r\n, depois o corpo pelo
    //    Content-Length. Suficiente pro que o cliente MCP manda (POST JSON);
    //    não é um servidor HTTP de uso geral.
    let mut buf: Vec<u8> = Vec::with_capacity(4096);
    let mut chunk = [0u8; 2048];

    let header_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(()); // conexão fechada antes de mandar nada
        }
        buf.extend_from_slice(&chunk[..n]);

        if let Some(pos) = find_header_end(&buf) {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return write_response(&mut stream, 431, "{}", &[]).await;
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").to_string();
    let path = request_line.split_whitespace().nth(1).unwrap_or("/").to_string();

    let mut content_length = 0usize;
    let mut auth_header = String::new();
    let mut accepts_sse = false;
    let mut session_header: Option<String> = None;
    let mut user_agent: Option<String> = None;
    let mut client_tag: Option<String> = None;
    let mut expects_continue = false;
    let mut chunked = false;
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        match name.trim().to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.parse().unwrap_or(0),
            "authorization" => auth_header = value.to_string(),
            "accept" => accepts_sse = value.to_ascii_lowercase().contains("text/event-stream"),
            "mcp-session-id" if !value.is_empty() => session_header = Some(value.to_string()),
            "user-agent" if !value.is_empty() => user_agent = Some(value.chars().take(200).collect()),
            "x-devflow-client" if !value.is_empty() => client_tag = Some(value.chars().take(40).collect()),
            "expect" => expects_continue = value.eq_ignore_ascii_case("100-continue"),
            "transfer-encoding" => chunked = value.to_ascii_lowercase().contains("chunked"),
            _ => {}
        }
    }

    // Preflight: responde OK sem envolver o frontend.
    if request_line.starts_with("OPTIONS") {
        return write_response(&mut stream, 200, "{}", &[]).await;
    }

    if request_line.starts_with("GET") {
        // Com token errado o Claude Code entende o 401 como "precisa de OAuth"
        // e vem procurar os metadados aqui. 404 diz "não tem OAuth" sem
        // parecer um servidor quebrado (antes vinha 405).
        if path.starts_with("/.well-known/") {
            return write_response(&mut stream, 404, r#"{"error":"not_found"}"#, &[]).await;
        }
        // O transporte streamable-HTTP permite um canal SSE via GET pra
        // mensagens iniciadas pelo servidor. Aqui não há nada disso, e a forma
        // correta de dizer isso é 405 — o cliente segue só com POST.
        return write_response(
            &mut stream,
            405,
            r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"SSE stream not supported; use POST"},"id":null}"#,
            &[],
        )
        .await;
    }

    let expected = server_token().lock().map(|t| t.clone()).unwrap_or_default();
    let provided = bearer_token(&auth_header);
    if expected.is_empty() || provided != Some(expected.as_str()) {
        emit_activity(
            &app,
            McpActivityEvent {
                kind: "rejected",
                session_id: session_header.clone(),
                user_agent: user_agent.clone(),
                reason: Some(if provided.is_none() { "missing" } else { "wrong" }),
            },
        );
        return write_response(
            &mut stream,
            401,
            r#"{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized: the DevFlow MCP token is missing or wrong. Copy the command again in DevFlow → Settings → Claude Code (MCP) and re-add the server."},"id":null}"#,
            &[],
        )
        .await;
    }

    let session_ended = session_header
        .as_ref()
        .map(|s| ended_sessions().lock().map(|set| set.contains(s)).unwrap_or(false))
        .unwrap_or(false);
    // Fim de sessão: só depois do token, pra nenhum processo local "derrubar"
    // a sessão de outro na tela.
    if request_line.starts_with("DELETE") {
        if session_header.is_some() {
            emit_activity(
                &app,
                McpActivityEvent {
                    kind: "closed",
                    session_id: session_header,
                    user_agent,
                    reason: None,
                },
            );
        }
        return write_response(&mut stream, 200, "{}", &[]).await;
    }

    // Corpo em chunked não é lido aqui (só pelo Content-Length): sem isto ele
    // chegava vazio e o cliente recebia "200 {}" — uma resposta sem id.
    if chunked && content_length == 0 {
        return write_response(
            &mut stream,
            411,
            r#"{"jsonrpc":"2.0","error":{"code":-32600,"message":"Send the request with Content-Length (chunked bodies are not supported)."},"id":null}"#,
            &[],
        )
        .await;
    }

    // curl e afins esperam o "100 Continue" antes de mandar corpos grandes.
    if expects_continue && content_length > 0 {
        stream
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .await
            .map_err(|e| e.to_string())?;
    }

    // Corpo
    let body_start = header_end + 4;
    let mut body = buf[body_start.min(buf.len())..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }
    let body = String::from_utf8_lossy(&body).to_string();

    if body.trim().is_empty() {
        return write_response(&mut stream, 200, "{}", &[]).await;
    }

    // Id JSON-RPC do pedido, pra que um erro gerado aqui (timeout, janela
    // fora do ar) chegue ao cliente amarrado à chamada certa. Com `id: null`
    // o cliente não tem como saber qual chamada falhou, e numa resposta SSE
    // ficaria esperando pra sempre.
    let parsed: Option<serde_json::Value> = serde_json::from_str(&body).ok();
    let rpc_id = parsed
        .as_ref()
        .and_then(|v| v.get("id").cloned())
        .unwrap_or(serde_json::Value::Null);
    let method = parsed
        .as_ref()
        .and_then(|v| v.get("method"))
        .and_then(|m| m.as_str())
        .map(str::to_string);

    // Sessão encerrada no painel: 404 (o cliente precisa abrir sessão nova).
    // Um initialize, mesmo trazendo o id encerrado, É o cliente reconectando —
    // recusá-lo o deixaria preso; por isso a checagem vem depois do método.
    if session_ended && method.as_deref() != Some("initialize") {
        return write_response(
            &mut stream,
            404,
            r#"{"jsonrpc":"2.0","error":{"code":-32001,"message":"Session ended in DevFlow. Reconnect the MCP server (in Claude Code: /mcp → devflow → Reconnect) to start a new session."},"id":null}"#,
            &[],
        )
        .await;
    }

    // Notificação (ex. notifications/initialized, logo depois do initialize):
    // a especificação manda 202 sem corpo. Antes ia 200 com corpo vazio e
    // Content-Type JSON, que clientes mais rígidos tentam ler e quebram.
    let is_notification = parsed
        .as_ref()
        .map(|v| v.is_object() && v.get("id").map_or(true, |id| id.is_null()))
        .unwrap_or(false);
    if is_notification {
        return write_status_only(&mut stream, 202).await;
    }

    // Sessão: nova no initialize; nas outras, a que o cliente mandar. Sessão
    // desconhecida (o app reiniciou e o cliente ainda tem a antiga) é aceita
    // assim mesmo — recusar com 404 obrigaria o cliente a reconectar, e nem
    // todo cliente faz isso sozinho.
    let new_session = if method.as_deref() == Some("initialize") {
        Some(new_session_id())
    } else {
        None
    };
    let session_id = new_session.clone().or(session_header);
    let pending_session = session_id.clone();

    // Só tools/call pode demorar (é o que executa request, fluxo, load test e
    // login). O resto responde em milissegundos e segue em JSON simples.
    let is_tool_call = method.as_deref() == Some("tools/call");
    let use_sse = accepts_sse && is_tool_call && !rpc_id.is_null();

    // ── Repassa pro frontend e espera a resposta ──────────────────────────
    let id = next_id();
    let (tx, mut rx) = oneshot::channel::<String>();
    if let Ok(mut map) = pending().lock() {
        map.insert(
            id,
            PendingEntry {
                tx,
                deadline: Instant::now() + Duration::from_secs(FRONTEND_IDLE_TIMEOUT_SECS),
                session: pending_session,
            },
        );
    }

    let event = McpRequestEvent {
        id,
        payload: body,
        session_id,
        user_agent,
        client_tag,
    };
    if let Err(e) = app.emit("mcp-request", event) {
        remove_pending(id);
        return write_response(
            &mut stream,
            500,
            &error_response(&format!("Failed to reach the app window: {e}"), &rpc_id),
            &[],
        )
        .await;
    }

    if use_sse {
        // Cabeçalho já: é ele que o cliente espera pra não desistir.
        stream
            .write_all(
                b"HTTP/1.1 200 OK\r\n\
                  Content-Type: text/event-stream\r\n\
                  Cache-Control: no-cache\r\n\
                  Transfer-Encoding: chunked\r\n\
                  Connection: close\r\n\
                  \r\n",
            )
            .await
            .map_err(|e| e.to_string())?;
        stream.flush().await.map_err(|e| e.to_string())?;
    }

    let response_body = loop {
        let tick = Duration::from_secs(if use_sse { SSE_KEEPALIVE_SECS } else { 5 });
        match tokio::time::timeout(tick, &mut rx).await {
            Ok(Ok(payload)) if payload == ENDED_SENTINEL => {
                break error_response("Session ended in DevFlow. Reconnect the MCP server to start a new session.", &rpc_id)
            }
            Ok(Ok(payload)) => break payload,
            Ok(Err(_)) => break error_response("The app window dropped the request", &rpc_id),
            Err(_) => {
                if use_sse && write_chunk(&mut stream, ": keepalive\n\n").await.is_err() {
                    // O cliente foi embora (cancelou ou caiu): não há mais pra
                    // quem responder.
                    remove_pending(id);
                    return Ok(());
                }
                // Entrada ausente = a resposta acabou de chegar; o próximo
                // giro a lê do canal.
                let expired = pending()
                    .lock()
                    .map(|map| map.get(&id).map(|e| Instant::now() >= e.deadline).unwrap_or(false))
                    .unwrap_or(true);
                if expired {
                    remove_pending(id);
                    break error_response(
                        "The DevFlow window stopped answering (no sign of life for 120 s). Check that the app is open and responsive.",
                        &rpc_id,
                    );
                }
            }
        }
    };

    if use_sse {
        if !response_body.is_empty() {
            let mut event = String::from("event: message\n");
            for line in response_body.lines() {
                event.push_str("data: ");
                event.push_str(line);
                event.push('\n');
            }
            event.push('\n');
            write_chunk(&mut stream, &event).await?;
        }
        stream.write_all(b"0\r\n\r\n").await.map_err(|e| e.to_string())?;
        return stream.flush().await.map_err(|e| e.to_string());
    }

    // Lote só de notificações: nada a responder.
    if response_body.is_empty() {
        return write_status_only(&mut stream, 202).await;
    }

    let session_header_value = new_session.unwrap_or_default();
    let extra: &[(&str, &str)] = if session_header_value.is_empty() {
        &[]
    } else {
        &[("Mcp-Session-Id", session_header_value.as_str())]
    };
    write_response(&mut stream, 200, &response_body, extra).await
}

fn remove_pending(id: u64) {
    if let Ok(mut map) = pending().lock() {
        map.remove(&id);
    }
}

// Um pedaço da resposta em Transfer-Encoding: chunked.
async fn write_chunk(stream: &mut tokio::net::TcpStream, data: &str) -> Result<(), String> {
    let framed = format!("{:x}\r\n{data}\r\n", data.len());
    stream
        .write_all(framed.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn error_response(message: &str, id: &serde_json::Value) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "error": { "code": -32603, "message": message },
        "id": id,
    })
    .to_string()
}

fn reason_phrase(status: u16) -> &'static str {
    match status {
        200 => "OK",
        202 => "Accepted",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        411 => "Length Required",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    }
}

async fn write_status_only(stream: &mut tokio::net::TcpStream, status: u16) -> Result<(), String> {
    let response = format!(
        "HTTP/1.1 {status} {}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        reason_phrase(status)
    );
    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
    extra_headers: &[(&str, &str)],
) -> Result<(), String> {
    let extra: String = extra_headers
        .iter()
        .map(|(name, value)| format!("{name}: {value}\r\n"))
        .collect();

    let response = format!(
        "HTTP/1.1 {status} {}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         {extra}\
         Connection: close\r\n\
         \r\n\
         {body}",
        reason_phrase(status),
        body.as_bytes().len()
    );

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bearer_ignora_maiuscula_do_esquema() {
        assert_eq!(bearer_token("Bearer abc"), Some("abc"));
        assert_eq!(bearer_token("bearer abc "), Some("abc"));
        assert_eq!(bearer_token("BEARER abc"), Some("abc"));
        assert_eq!(bearer_token("Basic abc"), None);
        assert_eq!(bearer_token(""), None);
    }

    #[tokio::test]
    async fn encerrar_sessao_devolve_erro_a_chamada_pendurada() {
        let (tx, rx) = oneshot::channel::<String>();
        pending().lock().unwrap().insert(
            9_999_001,
            PendingEntry { tx, deadline: Instant::now(), session: Some("s-fim".into()) },
        );
        mcp_end_session("s-fim".into());
        assert_eq!(rx.await.unwrap(), ENDED_SENTINEL);
        assert!(ended_sessions().lock().unwrap().contains("s-fim"));
        assert!(!pending().lock().unwrap().contains_key(&9_999_001));
    }

    #[test]
    fn portas_fixas_ficam_fora_da_faixa_dinamica_do_windows() {
        assert_eq!(reason_phrase(411), "Length Required");
        assert!(*STABLE_PORTS.end() < 49152);
    }

    #[tokio::test]
    async fn reinicio_na_mesma_porta_nao_cai_pra_porta_sorteada() {
        // O que o start faz: para o listener antigo ESPERANDO e religa na
        // mesma porta. Sem o await do abort, este bind falhava.
        let first = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = first.local_addr().unwrap().port();
        let mut slot = Some(tokio::spawn(async move {
            loop {
                let _ = first.accept().await;
            }
        }));
        stop_listener(&mut slot).await;
        let again = TcpListener::bind(("127.0.0.1", port)).await;
        assert!(again.is_ok(), "porta {port} ainda ocupada depois do stop");
    }
}
