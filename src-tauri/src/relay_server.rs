// ─────────────────────────────────────────────────────────────────────────
// Relay local do "HTML runner" (flow exportado como .html → DevFlow).
//
// O HTML de um flow roda no navegador, que não envia pra host com
// certificado da empresa (.corp) nem pra API que não libera CORS. Com o
// relay ligado, o HTML manda cada requisição pra cá e o DevFlow a envia com
// o MESMO cliente HTTP do botão Send (perform_http_request): mesma opção de
// Verify SSL, mesmo timeout, mesmos cookies.
//
// Segurança — um relay que envia qualquer requisição é perigoso se qualquer
// página aberta no navegador puder usá-lo:
//   • desligado por padrão (Settings → Network);
//   • escuta só em 127.0.0.1;
//   • toda chamada exige `X-DevFlow-Relay-Key` com a chave gerada no app —
//     uma página que não a conhece recebe 401 e nada é enviado.
// ─────────────────────────────────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;

use crate::{perform_http_request, CookieJarState, RequestTimeoutState, SslVerifyState};

fn relay_task() -> &'static Mutex<Option<JoinHandle<()>>> {
    static TASK: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();
    TASK.get_or_init(|| Mutex::new(None))
}

fn relay_key() -> &'static Mutex<String> {
    static KEY: OnceLock<Mutex<String>> = OnceLock::new();
    KEY.get_or_init(|| Mutex::new(String::new()))
}

// Corpo máximo aceito (requisição do HTML). Bodies de API cabem com folga.
const MAX_BODY_BYTES: usize = 20 * 1024 * 1024;

#[derive(Deserialize)]
struct RelayRequest {
    method: String,
    url: String,
    #[serde(default)]
    headers: HashMap<String, String>,
    #[serde(default)]
    body: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RelayResponse {
    status: u16,
    headers: HashMap<String, String>,
    body: String,
    is_binary: bool,
    time_ms: u128,
}

/// Liga o relay. Devolve a porta usada (se a pedida estiver ocupada, o SO
/// escolhe outra — a tela de Settings mostra a que valeu).
#[tauri::command]
pub async fn start_relay_server(app: AppHandle, port: u16, key: String) -> Result<u16, String> {
    stop_relay_server();
    if key.trim().len() < 16 {
        return Err("The relay key is too short".to_string());
    }

    let listener = match TcpListener::bind(("127.0.0.1", port)).await {
        Ok(listener) => listener,
        Err(pinned) if port != 0 => {
            log::warn!("Relay: 127.0.0.1:{port} indisponível ({pinned}); caindo para porta efêmera");
            TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| format!("Failed to bind 127.0.0.1:{port} ({pinned}), and no other port was available: {e}"))?
        }
        Err(e) => return Err(format!("Failed to bind 127.0.0.1:{port}: {e}")),
    };
    let bound_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    if let Ok(mut slot) = relay_key().lock() {
        *slot = key;
    }

    let handle = tokio::spawn(async move {
        loop {
            let (stream, _addr) = match listener.accept().await {
                Ok(pair) => pair,
                Err(e) => {
                    log::warn!("Relay accept error: {e}");
                    continue;
                }
            };
            let app_for_conn = app.clone();
            tokio::spawn(async move {
                if let Err(e) = handle_connection(stream, app_for_conn).await {
                    log::warn!("Relay connection error: {e}");
                }
            });
        }
    });

    if let Ok(mut slot) = relay_task().lock() {
        *slot = Some(handle);
    }
    Ok(bound_port)
}

#[tauri::command]
pub fn stop_relay_server() {
    if let Ok(mut slot) = relay_task().lock() {
        if let Some(handle) = slot.take() {
            handle.abort();
        }
    }
    if let Ok(mut key) = relay_key().lock() {
        key.clear();
    }
}

async fn handle_connection(mut stream: tokio::net::TcpStream, app: AppHandle) -> Result<(), String> {
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];

    let header_end = loop {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos;
        }
        if buf.len() > 64 * 1024 {
            return write_json(&mut stream, 431, r#"{"error":"Request headers too large"}"#).await;
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let request_line = lines.next().unwrap_or("").to_string();
    let mut content_length = 0usize;
    let mut provided_key = String::new();
    for line in lines {
        let lower = line.to_ascii_lowercase();
        if let Some(rest) = lower.strip_prefix("content-length:") {
            content_length = rest.trim().parse().unwrap_or(0);
        } else if lower.starts_with("x-devflow-relay-key:") {
            provided_key = line["x-devflow-relay-key:".len()..].trim().to_string();
        }
    }

    // Preflight do navegador: só diz o que é permitido — não envia nada e
    // não precisa da chave (o navegador não a manda no OPTIONS).
    if request_line.starts_with("OPTIONS") {
        return write_json(&mut stream, 204, "").await;
    }

    let expected = relay_key().lock().map(|k| k.clone()).unwrap_or_default();
    if expected.is_empty() || provided_key != expected {
        return write_json(&mut stream, 401, r#"{"error":"Wrong or missing DevFlow relay key"}"#).await;
    }

    // GET /ping — o HTML confere a conexão antes de rodar.
    if request_line.starts_with("GET") {
        return write_json(&mut stream, 200, r#"{"ok":true,"app":"DevFlow"}"#).await;
    }
    if !request_line.starts_with("POST") {
        return write_json(&mut stream, 405, r#"{"error":"Use POST"}"#).await;
    }
    if content_length > MAX_BODY_BYTES {
        return write_json(&mut stream, 413, r#"{"error":"Request body too large"}"#).await;
    }

    let body_start = header_end + 4;
    let mut body = buf[body_start.min(buf.len())..].to_vec();
    while body.len() < content_length {
        let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        body.extend_from_slice(&chunk[..n]);
    }

    let request: RelayRequest = match serde_json::from_slice(&body) {
        Ok(r) => r,
        Err(e) => {
            let msg = serde_json::json!({ "error": format!("Invalid relay request: {e}") }).to_string();
            return write_json(&mut stream, 400, &msg).await;
        }
    };

    let started = Instant::now();
    let result = perform_http_request(
        app.state::<SslVerifyState>(),
        app.state::<RequestTimeoutState>(),
        app.state::<CookieJarState>(),
        request.method,
        request.url,
        request.body,
        Some(request.headers),
    )
    .await;

    match result {
        Ok(response) => {
            let payload = RelayResponse {
                status: response.status,
                headers: response.headers,
                body: response.body,
                is_binary: response.is_binary,
                time_ms: started.elapsed().as_millis(),
            };
            let json = serde_json::to_string(&payload).map_err(|e| e.to_string())?;
            write_json(&mut stream, 200, &json).await
        }
        // 502: o relay funcionou, quem falhou foi a requisição (DNS, TLS…).
        Err(message) => {
            let json = serde_json::json!({ "error": message }).to_string();
            write_json(&mut stream, 502, &json).await
        }
    }
}

async fn write_json(stream: &mut tokio::net::TcpStream, status: u16, body: &str) -> Result<(), String> {
    let reason = match status {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        405 => "Method Not Allowed",
        413 => "Payload Too Large",
        431 => "Request Header Fields Too Large",
        502 => "Bad Gateway",
        _ => "Internal Server Error",
    };
    // CORS aberto de propósito: quem protege é a chave. A página do flow é
    // aberta de um arquivo (origem "null"), e
    // Access-Control-Allow-Private-Network é o que o Chrome exige pra uma
    // página falar com 127.0.0.1.
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: application/json\r\n\
         Content-Length: {}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n\
         Access-Control-Allow-Headers: content-type, x-devflow-relay-key\r\n\
         Access-Control-Allow-Private-Network: true\r\n\
         Access-Control-Max-Age: 600\r\n\
         Connection: close\r\n\
         \r\n\
         {body}",
        body.as_bytes().len()
    );
    stream.write_all(response.as_bytes()).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}
