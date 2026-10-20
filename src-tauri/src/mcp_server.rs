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
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

// Requisições aguardando resposta do frontend, por id.
type PendingMap = Mutex<HashMap<u64, oneshot::Sender<String>>>;

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

// Tempo máximo esperando o frontend responder. Existe pra uma janela
// travada (ou o app minimizado com o handler quebrado) não deixar conexões
// penduradas pra sempre do lado do Claude Code.
const FRONTEND_TIMEOUT_SECS: u64 = 120;

/// O frontend devolve aqui o resultado de uma requisição repassada.
#[tauri::command]
pub fn mcp_respond(id: u64, payload: String) {
    let sender = pending().lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(tx) = sender {
        let _ = tx.send(payload);
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
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        } else if lower.starts_with("authorization:") {
            auth_header = line["authorization:".len()..].trim().to_string();
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

    // ── Repassa pro frontend e espera a resposta ──────────────────────────
    let id = next_id();
    let (tx, rx) = oneshot::channel::<String>();
    if let Ok(mut map) = pending().lock() {
        map.insert(id, tx);
    }

    if let Err(e) = app.emit("mcp-request", McpRequestEvent { id, payload: body }) {
        if let Ok(mut map) = pending().lock() {
            map.remove(&id);
        }
        return write_response(
            &mut stream,
            500,
            &error_response(&format!("Failed to reach the app window: {e}")),
        )
        .await;
    }

    let result = tokio::time::timeout(Duration::from_secs(FRONTEND_TIMEOUT_SECS), rx).await;

    let response_body = match result {
        Ok(Ok(payload)) => payload,
        Ok(Err(_)) => error_response("The app window dropped the request"),
        Err(_) => {
            if let Ok(mut map) = pending().lock() {
                map.remove(&id);
            }
            error_response("Timed out waiting for the DevFlow window to answer")
        }
    };

    write_response(&mut stream, 200, &response_body).await
}

fn find_header_end(buf: &[u8]) -> Option<usize> {
    buf.windows(4).position(|w| w == b"\r\n\r\n")
}

fn error_response(message: &str) -> String {
    format!(
        r#"{{"jsonrpc":"2.0","error":{{"code":-32603,"message":{}}},"id":null}}"#,
        serde_json::to_string(message).unwrap_or_else(|_| "\"internal error\"".to_string())
    )
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
