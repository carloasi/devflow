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
// ─────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

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

// Handle da task do listener, pra conseguir parar o servidor.
fn server_task() -> &'static Mutex<Option<JoinHandle<()>>> {
    static TASK: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
    TASK.get_or_init(|| Mutex::new(None))
}

fn server_token() -> &'static Mutex<String> {
    static TOKEN: OnceLock<Mutex<String>> = OnceLock::new();
    TOKEN.get_or_init(|| Mutex::new(String::new()))
}

#[derive(Clone, Serialize)]
struct McpRequestEvent {
    id: u64,
    // Corpo JSON-RPC cru, repassado sem interpretar.
    payload: String,
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

/// O frontend devolve aqui o resultado de uma requisição repassada.
#[tauri::command]
pub fn mcp_respond(id: u64, payload: String) {
    let entry = pending().lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(entry) = entry {
        let _ = entry.tx.send(payload);
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

/// Inicia o servidor. Devolve a porta efetivamente usada (passar 0 deixa o
/// SO escolher uma porta livre).
#[tauri::command]
pub async fn start_mcp_server(app: AppHandle, port: u16, token: String) -> Result<u16, String> {
    stop_mcp_server();

    if token.trim().is_empty() {
        return Err("MCP token cannot be empty".to_string());
    }

    // A porta que deu certo fica salva, pra que o `claude mcp add` que o usuário
    // já rodou continue valendo entre reinícios. Só que no Windows o Hyper-V/WSL
    // reserva faixas de portas altas e as sorteia de novo a cada boot: uma porta
    // que o próprio SO entregou ontem pode recusar o bind hoje com o erro 10013
    // ("acesso proibido" — diferente de 10048, "já em uso"). Como a porta fica
    // fixada, sem o fallback o botão Turn on morre de vez, e a mensagem do SO não
    // dá nenhuma pista do que fazer. Perder a porta fixa é melhor que não ligar.
    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(pinned) if port != 0 => {
            log::warn!("MCP: 127.0.0.1:{port} indisponível ({pinned}); caindo para porta efêmera");
            TcpListener::bind(("127.0.0.1", 0)).await.map_err(|e| {
                format!("Failed to bind 127.0.0.1:{port} ({pinned}), and no ephemeral port was available either: {e}")
            })?
        }
        Err(e) => return Err(format!("Failed to bind 127.0.0.1:{port}: {e}")),
    };

    let bound_port = listener
        .local_addr()
        .map_err(|e| e.to_string())?
        .port();

    if let Ok(mut slot) = server_token().lock() {
        *slot = token;
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

    if let Ok(mut slot) = server_task().lock() {
        *slot = Some(handle);
    }

    Ok(bound_port)
}

#[tauri::command]
pub fn stop_mcp_server() {
    if let Ok(mut slot) = server_task().lock() {
        if let Some(handle) = slot.take() {
            handle.abort();
        }
    }
    if let Ok(mut map) = pending().lock() {
        map.clear();
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
            return write_response(&mut stream, 431, "{}").await;
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").to_string();

    let mut content_length = 0usize;
    let mut auth_header = String::new();
    let mut accepts_sse = false;
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        } else if lower.starts_with("authorization:") {
            auth_header = line["authorization:".len()..].trim().to_string();
        } else if let Some(rest) = lower.strip_prefix("accept:") {
            accepts_sse = rest.contains("text/event-stream");
        }
    }

    // Preflight / probes simples: responde OK sem envolver o frontend.
    if request_line.starts_with("OPTIONS") || request_line.starts_with("DELETE") {
        return write_response(&mut stream, 200, "{}").await;
    }

    // O transporte streamable-HTTP do MCP permite que o cliente abra um
    // canal SSE via GET pra receber mensagens iniciadas pelo servidor. Aqui
    // não há nada disso (o servidor só responde ao que é pedido), e a forma
    // correta de dizer isso é 405 — assim o cliente segue só com POST em vez
    // de ficar esperando um stream que nunca vem.
    if request_line.starts_with("GET") {
        return write_response(
            &mut stream,
            405,
            r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"SSE stream not supported; use POST"},"id":null}"#,
        )
        .await;
    }

    let expected = server_token().lock().map(|t| t.clone()).unwrap_or_default();
    let provided = auth_header.strip_prefix("Bearer ").unwrap_or("").trim();
    if expected.is_empty() || provided != expected {
        return write_response(
            &mut stream,
            401,
            r#"{"jsonrpc":"2.0","error":{"code":-32001,"message":"Unauthorized"},"id":null}"#,
        )
        .await;
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
        return write_response(&mut stream, 200, "{}").await;
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

    // Só tools/call pode demorar (é o que executa request, fluxo, load test e
    // login). O resto responde em milissegundos e segue em JSON simples.
    let is_tool_call = parsed
        .as_ref()
        .and_then(|v| v.get("method"))
        .and_then(|m| m.as_str())
        == Some("tools/call");
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
            },
        );
    }

    if let Err(e) = app.emit("mcp-request", McpRequestEvent { id, payload: body }) {
        remove_pending(id);
        return write_response(
            &mut stream,
            500,
            &error_response(&format!("Failed to reach the app window: {e}"), &rpc_id),
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

    write_response(&mut stream, 200, &response_body).await
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

async fn write_response(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        401 => "Unauthorized",
        431 => "Request Header Fields Too Large",
        _ => "Internal Server Error",
    };

    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.as_bytes().len()
    );

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}
