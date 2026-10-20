// ─────────────────────────────────────────────────────────────────────────────
// gRPC — fase 1: chamadas unárias.
//
// Os .proto são do usuário, então nada aqui é gerado no build: o schema vira
// um DescriptorPool (prost-reflect) em tempo de execução e as mensagens são
// DynamicMessage, convertidas de/para JSON no formato canônico do protobuf
// (o mesmo do grpcurl).
//
// O schema chega de dois jeitos:
//   • arquivos .proto escolhidos pelo usuário, compilados com protox (um
//     protoc em Rust puro — não exige nada instalado na máquina);
//   • server reflection (grpc.reflection.v1, com fallback pra v1alpha).
//
// Nos dois casos o resultado volta pro frontend como um FileDescriptorSet em
// base64, que fica salvo na própria request. Assim ela funciona em outra
// máquina (via GitHub Sync) sem os .proto e sem o servidor ter reflection.
// ─────────────────────────────────────────────────────────────────────────────

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::path::Path;
use std::str::FromStr;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose, Engine as _};
use prost::Message as _;
use prost_reflect::{
    DescriptorPool, DynamicMessage, FieldDescriptor, Kind, MessageDescriptor, MethodDescriptor,
    SerializeOptions,
};
use prost_types::FileDescriptorProto;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use tonic::codec::{Codec, DecodeBuf, Decoder, EncodeBuf, Encoder};
use tonic::metadata::{AsciiMetadataKey, AsciiMetadataValue, BinaryMetadataKey, BinaryMetadataValue, MetadataMap};
use tonic::transport::{Channel, ClientTlsConfig, Endpoint};
use tonic::{Code, Status};
use tauri::Emitter;
use tokio::sync::{mpsc, Mutex};

const DEFAULT_TIMEOUT_MS: u64 = 30_000;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);
// Profundidade máxima do modelo de mensagem gerado (mensagens recursivas,
// tipo uma árvore, iriam ao infinito).
const TEMPLATE_MAX_DEPTH: usize = 4;

// ── Tipos trocados com o frontend ───────────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrpcMetadataEntry {
    pub key: String,
    #[serde(default)]
    pub value: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcMethodInfo {
    pub name: String,
    /// "pacote.Servico/Metodo" — o que vai no path HTTP/2 e na request salva.
    pub full_name: String,
    pub input_type: String,
    pub output_type: String,
    pub client_streaming: bool,
    pub server_streaming: bool,
    /// Mensagem de entrada com todos os campos preenchidos com o valor padrão.
    pub input_template: Value,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcServiceInfo {
    pub name: String,
    pub methods: Vec<GrpcMethodInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcSchema {
    /// FileDescriptorSet em base64 — salvo na request.
    pub descriptor_set: String,
    pub services: Vec<GrpcServiceInfo>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrpcCallResult {
    /// Código numérico do gRPC (0 = OK).
    pub status_code: i32,
    /// Nome do código ("OK", "UNAVAILABLE", ...).
    pub status_name: String,
    pub status_message: String,
    /// Resposta em JSON (texto formatado) — vazia quando a chamada falhou.
    pub response: Option<String>,
    /// Headers + trailers da resposta (o tonic junta os dois numa chamada unária).
    pub metadata: Vec<(String, String)>,
    pub time_ms: u64,
}

// ── Descriptor pool ─────────────────────────────────────────────────────────

fn decode_pool(descriptor_set: &str) -> Result<DescriptorPool, String> {
    let bytes = general_purpose::STANDARD
        .decode(descriptor_set.trim())
        .map_err(|e| format!("Invalid schema data: {e}"))?;
    DescriptorPool::decode(bytes.as_slice()).map_err(|e| format!("Invalid schema data: {e}"))
}

fn encode_pool(pool: &DescriptorPool) -> String {
    general_purpose::STANDARD.encode(pool.encode_to_vec())
}

fn schema_from_pool(pool: &DescriptorPool) -> GrpcSchema {
    let mut services: Vec<GrpcServiceInfo> = pool
        .services()
        // A própria reflection não interessa pra quem está testando a API.
        .filter(|s| !s.full_name().starts_with("grpc.reflection."))
        .map(|service| GrpcServiceInfo {
            name: service.full_name().to_string(),
            methods: service.methods().map(|m| method_info(&m)).collect(),
        })
        .collect();
    services.sort_by(|a, b| a.name.cmp(&b.name));

    GrpcSchema { descriptor_set: encode_pool(pool), services }
}

fn method_info(method: &MethodDescriptor) -> GrpcMethodInfo {
    GrpcMethodInfo {
        name: method.name().to_string(),
        full_name: format!("{}/{}", method.parent_service().full_name(), method.name()),
        input_type: method.input().full_name().to_string(),
        output_type: method.output().full_name().to_string(),
        client_streaming: method.is_client_streaming(),
        server_streaming: method.is_server_streaming(),
        input_template: message_template(&method.input(), 0, &mut HashSet::new()),
    }
}

// Modelo JSON de uma mensagem: cada campo com um valor de exemplo do tipo
// certo, pra o usuário só trocar os valores em vez de montar a estrutura.
fn message_template(desc: &MessageDescriptor, depth: usize, visiting: &mut HashSet<String>) -> Value {
    // Well-known types têm representação JSON própria.
    match desc.full_name() {
        "google.protobuf.Timestamp" => return json!("1970-01-01T00:00:00Z"),
        "google.protobuf.Duration" => return json!("0s"),
        "google.protobuf.Struct" | "google.protobuf.Any" => return json!({}),
        "google.protobuf.Value" => return Value::Null,
        "google.protobuf.ListValue" => return json!([]),
        "google.protobuf.FieldMask" => return json!(""),
        "google.protobuf.StringValue" | "google.protobuf.BytesValue" => return json!(""),
        "google.protobuf.BoolValue" => return json!(false),
        "google.protobuf.Int64Value" | "google.protobuf.UInt64Value" => return json!("0"),
        "google.protobuf.Int32Value" | "google.protobuf.UInt32Value" | "google.protobuf.FloatValue"
        | "google.protobuf.DoubleValue" => return json!(0),
        _ => {}
    }

    if depth >= TEMPLATE_MAX_DEPTH || !visiting.insert(desc.full_name().to_string()) {
        return json!({});
    }

    let mut out = Map::new();
    for field in desc.fields() {
        out.insert(field.json_name().to_string(), field_template(&field, depth, visiting));
    }
    visiting.remove(desc.full_name());
    Value::Object(out)
}

fn field_template(field: &FieldDescriptor, depth: usize, visiting: &mut HashSet<String>) -> Value {
    if field.is_map() {
        return json!({});
    }
    let single = match field.kind() {
        Kind::Double | Kind::Float | Kind::Int32 | Kind::Sint32 | Kind::Sfixed32 | Kind::Uint32
        | Kind::Fixed32 => json!(0),
        // 64 bits vão como string no JSON do protobuf (não cabem num double).
        Kind::Int64 | Kind::Sint64 | Kind::Sfixed64 | Kind::Uint64 | Kind::Fixed64 => json!("0"),
        Kind::Bool => json!(false),
        Kind::String | Kind::Bytes => json!(""),
        Kind::Enum(e) => e
            .values()
            .next()
            .map(|v| json!(v.name()))
            .unwrap_or(Value::Null),
        Kind::Message(m) => message_template(&m, depth + 1, visiting),
    };
    if field.is_list() {
        json!([single])
    } else {
        single
    }
}

// ── Compilar .proto ─────────────────────────────────────────────────────────

#[tauri::command]
pub async fn grpc_compile_protos(files: Vec<String>, include_dirs: Vec<String>) -> Result<GrpcSchema, String> {
    if files.is_empty() {
        return Err("Select at least one .proto file.".into());
    }

    tauri::async_runtime::spawn_blocking(move || {
        // Cada arquivo é aberto pelo nome relativo à própria pasta, que entra
        // como include — assim "import \"outro.proto\";" ao lado funciona sem
        // configurar nada. Pastas extras cobrem imports de outros diretórios.
        let mut includes: Vec<String> = Vec::new();
        let mut names: Vec<String> = Vec::new();
        for file in &files {
            let path = Path::new(file);
            let parent = path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| ".".into());
            if !includes.contains(&parent) {
                includes.push(parent);
            }
            names.push(
                path.file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .ok_or_else(|| format!("Invalid file path: {file}"))?,
            );
        }
        for dir in include_dirs {
            if !dir.trim().is_empty() && !includes.contains(&dir) {
                includes.push(dir);
            }
        }

        let mut compiler = protox::Compiler::new(includes).map_err(|e| format!("{e}"))?;
        compiler.include_imports(true);
        compiler.open_files(names).map_err(|e| format!("{e}"))?;
        let pool = compiler.descriptor_pool();

        let schema = schema_from_pool(&pool);
        if schema.services.is_empty() {
            return Err("No service found in the selected files. Pick the .proto that declares the service.".into());
        }
        Ok(schema)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lista serviços/métodos de um schema já salvo na request.
#[tauri::command]
pub fn grpc_describe(descriptor_set: String) -> Result<GrpcSchema, String> {
    Ok(schema_from_pool(&decode_pool(&descriptor_set)?))
}

// ── Conexão ─────────────────────────────────────────────────────────────────

async fn connect(
    target: &str,
    use_tls: bool,
    // Aceita certificado inválido (autoassinado, expirado, nome errado).
    insecure_tls: bool,
    timeout: Option<Duration>,
) -> Result<Channel, String> {
    let target = target.trim().trim_end_matches('/');
    if target.is_empty() {
        return Err("Enter the server address (host:port).".into());
    }
    // Aceita "host:port" ou URL completa; o esquema decide o TLS quando vem
    // explícito, senão vale o toggle da request.
    let (uri, tls) = if let Some(rest) = target.strip_prefix("https://") {
        (format!("https://{rest}"), true)
    } else if let Some(rest) = target.strip_prefix("http://") {
        (format!("http://{rest}"), false)
    } else if use_tls {
        (format!("https://{target}"), true)
    } else {
        (format!("http://{target}"), false)
    };

    if tls && insecure_tls {
        return connect_insecure_tls(target, &uri, timeout).await;
    }

    let mut endpoint = Endpoint::from_shared(uri.clone())
        .map_err(|e| format!("Invalid server address \"{target}\": {e}"))?
        .connect_timeout(CONNECT_TIMEOUT);
    // Sem timeout = sem limite: streams ficam abertos o quanto precisarem.
    if let Some(timeout) = timeout {
        endpoint = endpoint.timeout(timeout);
    }

    if tls {
        endpoint = endpoint
            // Certificados do sistema — inclui CAs corporativas instaladas no
            // Windows, que é o caso comum de servidor interno.
            .tls_config(ClientTlsConfig::new().with_native_roots())
            .map_err(|e| format!("TLS setup failed: {e}"))?;
    }

    endpoint.connect().await.map_err(|e| {
        let detail = std::error::Error::source(&e)
            .map(|s| s.to_string())
            .unwrap_or_else(|| e.to_string());
        format!("Could not connect to {uri}: {detail}")
    })
}

// ── TLS sem verificar o certificado ─────────────────────────────────────────
// O tonic não tem "aceitar certificado inválido". Aqui o TLS é feito à mão
// (rustls) num conector próprio e o tonic recebe a conexão já cifrada,
// falando HTTP/2 por cima. Só a CADEIA do certificado deixa de ser checada
// (quem emitiu, validade, nome do host) — a assinatura do handshake continua
// sendo verificada, então a conexão segue cifrada de verdade.

#[derive(Debug)]
struct AcceptAnyServerCert(Arc<rustls::crypto::CryptoProvider>);

impl rustls::client::danger::ServerCertVerifier for AcceptAnyServerCert {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn insecure_tls_config() -> Result<rustls::ClientConfig, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS setup failed: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAnyServerCert(provider)))
        .with_no_client_auth();
    // gRPC é HTTP/2: o servidor só aceita se o ALPN pedir "h2".
    config.alpn_protocols = vec![b"h2".to_vec()];
    Ok(config)
}

async fn connect_insecure_tls(target: &str, uri: &str, timeout: Option<Duration>) -> Result<Channel, String> {
    let parsed: tonic::codegen::http::Uri = uri
        .parse()
        .map_err(|e| format!("Invalid server address \"{target}\": {e}"))?;
    let host_for_uri = parsed
        .host()
        .ok_or_else(|| format!("Invalid server address \"{target}\": missing host"))?
        .to_string();
    let port = parsed.port_u16().unwrap_or(443);
    // IPv6 vem entre colchetes na URI; pra conexão TCP e SNI vai sem.
    let host = host_for_uri.trim_start_matches('[').trim_end_matches(']').to_string();

    // O tonic vê um endpoint "http://": o TLS já vem pronto do conector.
    let mut endpoint = Endpoint::from_shared(format!("http://{host_for_uri}:{port}"))
        .map_err(|e| format!("Invalid server address \"{target}\": {e}"))?
        .connect_timeout(CONNECT_TIMEOUT);
    if let Some(timeout) = timeout {
        endpoint = endpoint.timeout(timeout);
    }

    let config = Arc::new(insecure_tls_config()?);
    let connector = tower::service_fn(move |_: tonic::codegen::http::Uri| {
        let host = host.clone();
        let config = config.clone();
        async move {
            let tcp = tokio::time::timeout(CONNECT_TIMEOUT, tokio::net::TcpStream::connect((host.as_str(), port)))
                .await
                .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connection timed out"))??;
            let server_name = rustls::pki_types::ServerName::try_from(host)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
            let tls = tokio_rustls::TlsConnector::from(config).connect(server_name, tcp).await?;
            Ok::<_, std::io::Error>(hyper_util::rt::TokioIo::new(tls))
        }
    });

    endpoint.connect_with_connector(connector).await.map_err(|e| {
        let detail = std::error::Error::source(&e)
            .map(|s| s.to_string())
            .unwrap_or_else(|| e.to_string());
        format!("Could not connect to {uri}: {detail}")
    })
}

fn build_metadata(entries: &[GrpcMetadataEntry]) -> Result<MetadataMap, String> {
    let mut map = MetadataMap::new();
    for entry in entries {
        let key = entry.key.trim().to_ascii_lowercase();
        if key.is_empty() {
            continue;
        }
        if key.ends_with("-bin") {
            // Metadata binária: o valor vem em base64.
            let bytes = general_purpose::STANDARD
                .decode(entry.value.trim())
                .map_err(|_| format!("Metadata \"{key}\" ends with -bin, so its value must be base64."))?;
            let k = BinaryMetadataKey::from_str(&key).map_err(|_| format!("Invalid metadata key \"{key}\"."))?;
            map.append_bin(k, BinaryMetadataValue::from_bytes(&bytes));
        } else {
            let k = AsciiMetadataKey::from_str(&key).map_err(|_| format!("Invalid metadata key \"{key}\"."))?;
            let v = AsciiMetadataValue::try_from(entry.value.as_str())
                .map_err(|_| format!("Metadata \"{key}\" has characters not allowed in a header value."))?;
            map.append(k, v);
        }
    }
    Ok(map)
}

fn metadata_to_vec(map: &MetadataMap) -> Vec<(String, String)> {
    map.iter()
        .map(|entry| match entry {
            tonic::metadata::KeyAndValueRef::Ascii(k, v) => {
                (k.to_string(), v.to_str().unwrap_or("<invalid>").to_string())
            }
            tonic::metadata::KeyAndValueRef::Binary(k, v) => (
                k.to_string(),
                v.to_bytes()
                    .map(|b| general_purpose::STANDARD.encode(b))
                    .unwrap_or_else(|_| "<invalid>".into()),
            ),
        })
        .collect()
}

fn code_name(code: Code) -> &'static str {
    match code {
        Code::Ok => "OK",
        Code::Cancelled => "CANCELLED",
        Code::Unknown => "UNKNOWN",
        Code::InvalidArgument => "INVALID_ARGUMENT",
        Code::DeadlineExceeded => "DEADLINE_EXCEEDED",
        Code::NotFound => "NOT_FOUND",
        Code::AlreadyExists => "ALREADY_EXISTS",
        Code::PermissionDenied => "PERMISSION_DENIED",
        Code::ResourceExhausted => "RESOURCE_EXHAUSTED",
        Code::FailedPrecondition => "FAILED_PRECONDITION",
        Code::Aborted => "ABORTED",
        Code::OutOfRange => "OUT_OF_RANGE",
        Code::Unimplemented => "UNIMPLEMENTED",
        Code::Internal => "INTERNAL",
        Code::Unavailable => "UNAVAILABLE",
        Code::DataLoss => "DATA_LOSS",
        Code::Unauthenticated => "UNAUTHENTICATED",
    }
}

// ── Codec de mensagens dinâmicas ────────────────────────────────────────────
// O tonic só sabe (de)serializar tipos gerados; este codec faz o mesmo com
// DynamicMessage, usando o descriptor da resposta pra decodificar.

#[derive(Clone)]
struct DynamicCodec {
    response: MessageDescriptor,
}

impl Codec for DynamicCodec {
    type Encode = DynamicMessage;
    type Decode = DynamicMessage;
    type Encoder = DynamicEncoder;
    type Decoder = DynamicDecoder;

    fn encoder(&mut self) -> Self::Encoder {
        DynamicEncoder
    }

    fn decoder(&mut self) -> Self::Decoder {
        DynamicDecoder { desc: self.response.clone() }
    }
}

struct DynamicEncoder;

impl Encoder for DynamicEncoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn encode(&mut self, item: Self::Item, dst: &mut EncodeBuf<'_>) -> Result<(), Self::Error> {
        item.encode(dst)
            .map_err(|e| Status::internal(format!("Could not encode the request: {e}")))
    }
}

struct DynamicDecoder {
    desc: MessageDescriptor,
}

impl Decoder for DynamicDecoder {
    type Item = DynamicMessage;
    type Error = Status;

    fn decode(&mut self, src: &mut DecodeBuf<'_>) -> Result<Option<Self::Item>, Self::Error> {
        DynamicMessage::decode(self.desc.clone(), src)
            .map(Some)
            .map_err(|e| Status::internal(format!("Could not decode the response: {e}")))
    }
}

// ── Helpers de método/mensagem ──────────────────────────────────────────────

// "pacote.Servico/Metodo" → descriptor do método + path HTTP/2.
fn resolve_method(
    pool: &DescriptorPool,
    method: &str,
) -> Result<(MethodDescriptor, tonic::codegen::http::uri::PathAndQuery), String> {
    let (service_name, method_name) = method
        .split_once('/')
        .ok_or_else(|| format!("Invalid method \"{method}\". Pick one from the list."))?;
    let service = pool
        .get_service_by_name(service_name)
        .ok_or_else(|| format!("Service \"{service_name}\" is not in the saved schema. Reload the schema."))?;
    let method_desc = service
        .methods()
        .find(|m| m.name() == method_name)
        .ok_or_else(|| format!("Method \"{method_name}\" is not in \"{service_name}\". Reload the schema."))?;
    let path = tonic::codegen::http::uri::PathAndQuery::from_str(&format!("/{service_name}/{method_name}"))
        .map_err(|e| format!("Invalid method path: {e}"))?;
    Ok((method_desc, path))
}

// JSON → mensagem. Campos desconhecidos são erro (nome errado não pode sumir
// em silêncio e mandar a mensagem incompleta).
fn parse_message(desc: &MessageDescriptor, message: &str) -> Result<DynamicMessage, String> {
    let text = if message.trim().is_empty() { "{}" } else { message };
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let parsed = DynamicMessage::deserialize(desc.clone(), &mut deserializer)
        .map_err(|e| format!("The message does not match {}: {e}", desc.full_name()))?;
    deserializer
        .end()
        .map_err(|e| format!("Invalid JSON in the message: {e}"))?;
    Ok(parsed)
}

// Mensagem → JSON formatado, mostrando também os campos com valor padrão
// (0, "", false) — sem isso um campo zerado some e parece que não veio.
fn message_to_json(message: &DynamicMessage) -> Result<String, String> {
    let options = SerializeOptions::new().skip_default_fields(false);
    let mut serializer = serde_json::Serializer::pretty(Vec::new());
    message
        .serialize_with_options(&mut serializer, &options)
        .map_err(|e| format!("Could not convert the response to JSON: {e}"))?;
    Ok(String::from_utf8_lossy(&serializer.into_inner()).to_string())
}

// ── Chamada unária ──────────────────────────────────────────────────────────

#[tauri::command]
pub async fn grpc_invoke(
    target: String,
    use_tls: bool,
    insecure_tls: Option<bool>,
    descriptor_set: String,
    method: String,
    message: String,
    metadata: Vec<GrpcMetadataEntry>,
    timeout_ms: Option<u64>,
) -> Result<GrpcCallResult, String> {
    let pool = decode_pool(&descriptor_set)?;
    let (method_desc, path) = resolve_method(&pool, &method)?;

    if method_desc.is_client_streaming() || method_desc.is_server_streaming() {
        return Err("This is a streaming method — start it as a stream.".into());
    }

    let request_message = parse_message(&method_desc.input(), &message)?;

    let timeout = Duration::from_millis(timeout_ms.filter(|t| *t > 0).unwrap_or(DEFAULT_TIMEOUT_MS));
    let started = Instant::now();
    let channel = connect(&target, use_tls, insecure_tls.unwrap_or(false), Some(timeout)).await?;

    let mut request = tonic::Request::new(request_message);
    *request.metadata_mut() = build_metadata(&metadata)?;
    request.set_timeout(timeout);

    let mut grpc = tonic::client::Grpc::new(channel);
    grpc.ready()
        .await
        .map_err(|e| format!("The server is not ready: {e}"))?;

    let codec = DynamicCodec { response: method_desc.output() };
    let outcome = grpc.unary(request, path, codec).await;
    let time_ms = started.elapsed().as_millis() as u64;

    Ok(match outcome {
        Ok(response) => {
            let metadata = metadata_to_vec(response.metadata());
            let body = response.into_inner();
            GrpcCallResult {
                status_code: 0,
                status_name: "OK".into(),
                status_message: String::new(),
                response: Some(message_to_json(&body)?),
                metadata,
                time_ms,
            }
        }
        Err(status) => GrpcCallResult {
            status_code: status.code() as i32,
            status_name: code_name(status.code()).into(),
            status_message: status.message().to_string(),
            response: None,
            metadata: metadata_to_vec(status.metadata()),
            time_ms,
        },
    })
}

// ── Streaming (server, client e bidirecional) ───────────────────────────────
// No fio os três tipos são iguais: uma sequência de mensagens em cada
// direção. Por isso todos usam Grpc::streaming — server streaming manda uma
// mensagem só e fecha o envio; client streaming recebe uma só resposta.
//
// A chamada roda numa tarefa em segundo plano e conversa com a tela por
// eventos ("grpc-stream-event"): o que chega (headers, mensagens, status
// final) vira um evento por vez, na hora. O envio de mensagens novas e o
// encerramento são comandos separados, achados pelo streamId.

const STREAM_EVENT: &str = "grpc-stream-event";
// Fila de mensagens a enviar ainda não consumidas pelo transporte.
const STREAM_SEND_BUFFER: usize = 64;

struct StreamEntry {
    // None depois de "End stream" (half-close): o servidor sabe que o
    // cliente não manda mais nada, mas a resposta continua chegando.
    sender: Option<mpsc::Sender<DynamicMessage>>,
    input: MessageDescriptor,
    started: Instant,
    task: tauri::async_runtime::JoinHandle<()>,
}

#[derive(Default, Clone)]
pub struct GrpcStreams(Arc<Mutex<HashMap<String, StreamEntry>>>);

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GrpcStreamEvent {
    pub stream_id: String,
    /// "sent" | "headers" | "message" | "end" | "error"
    pub kind: &'static str,
    /// JSON da mensagem (sent/message).
    pub message: Option<String>,
    pub status_code: Option<i32>,
    pub status_name: Option<String>,
    pub status_message: Option<String>,
    pub metadata: Vec<(String, String)>,
    /// Desde o início do stream.
    pub elapsed_ms: u64,
}

impl GrpcStreamEvent {
    fn new(stream_id: &str, kind: &'static str, started: Instant) -> Self {
        Self {
            stream_id: stream_id.to_string(),
            kind,
            message: None,
            status_code: None,
            status_name: None,
            status_message: None,
            metadata: Vec::new(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        }
    }
}

fn emit_event(app: &tauri::AppHandle, event: GrpcStreamEvent) {
    let _ = app.emit(STREAM_EVENT, event);
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn grpc_stream_start(
    app: tauri::AppHandle,
    streams: tauri::State<'_, GrpcStreams>,
    stream_id: String,
    target: String,
    use_tls: bool,
    insecure_tls: Option<bool>,
    descriptor_set: String,
    method: String,
    metadata: Vec<GrpcMetadataEntry>,
    // Mensagem enviada logo no início (obrigatória em server streaming).
    initial_message: Option<String>,
    // Fecha o envio logo depois da mensagem inicial (server streaming).
    close_after_initial: bool,
    // Sem valor = stream sem limite de tempo.
    timeout_ms: Option<u64>,
) -> Result<(), String> {
    let pool = decode_pool(&descriptor_set)?;
    let (method_desc, path) = resolve_method(&pool, &method)?;
    if !method_desc.is_client_streaming() && !method_desc.is_server_streaming() {
        return Err("This is a unary method — use Invoke.".into());
    }

    let first = match &initial_message {
        Some(text) => Some(parse_message(&method_desc.input(), text)?),
        None => None,
    };

    let timeout = timeout_ms.filter(|t| *t > 0).map(Duration::from_millis);
    let channel = connect(&target, use_tls, insecure_tls.unwrap_or(false), timeout).await?;
    let request_metadata = build_metadata(&metadata)?;

    let (sender, receiver) = mpsc::channel::<DynamicMessage>(STREAM_SEND_BUFFER);
    let started = Instant::now();

    if let Some(message) = first {
        let json = message_to_json(&message).ok();
        sender
            .send(message)
            .await
            .map_err(|_| "Could not queue the first message.".to_string())?;
        let mut event = GrpcStreamEvent::new(&stream_id, "sent", started);
        event.message = json;
        emit_event(&app, event);
    }
    let sender = if close_after_initial { None } else { Some(sender) };

    let task = {
        let app = app.clone();
        let registry = streams.inner().clone();
        let stream_id = stream_id.clone();
        let output = method_desc.output();
        tauri::async_runtime::spawn(async move {
            let mut request = tonic::Request::new(tokio_stream::wrappers::ReceiverStream::new(receiver));
            *request.metadata_mut() = request_metadata;
            if let Some(timeout) = timeout {
                request.set_timeout(timeout);
            }

            let mut grpc = tonic::client::Grpc::new(channel);
            let outcome = match grpc.ready().await {
                Ok(()) => grpc.streaming(request, path, DynamicCodec { response: output }).await,
                Err(e) => Err(Status::unavailable(format!("The server is not ready: {e}"))),
            };

            match outcome {
                Ok(response) => {
                    let mut headers = GrpcStreamEvent::new(&stream_id, "headers", started);
                    headers.metadata = metadata_to_vec(response.metadata());
                    emit_event(&app, headers);

                    let mut incoming = response.into_inner();
                    loop {
                        match incoming.message().await {
                            Ok(Some(message)) => {
                                let mut event = GrpcStreamEvent::new(&stream_id, "message", started);
                                event.message = Some(
                                    message_to_json(&message).unwrap_or_else(|e| format!("\"{e}\"")),
                                );
                                emit_event(&app, event);
                            }
                            Ok(None) => {
                                let mut end = GrpcStreamEvent::new(&stream_id, "end", started);
                                end.status_code = Some(0);
                                end.status_name = Some("OK".into());
                                if let Ok(Some(trailers)) = incoming.trailers().await {
                                    end.metadata = metadata_to_vec(&trailers);
                                }
                                emit_event(&app, end);
                                break;
                            }
                            Err(status) => {
                                emit_event(&app, status_event(&stream_id, &status, started));
                                break;
                            }
                        }
                    }
                }
                Err(status) => emit_event(&app, status_event(&stream_id, &status, started)),
            }

            registry.0.lock().await.remove(&stream_id);
        })
    };

    streams.0.lock().await.insert(
        stream_id,
        StreamEntry { sender, input: method_desc.input(), started, task },
    );
    Ok(())
}

fn status_event(stream_id: &str, status: &Status, started: Instant) -> GrpcStreamEvent {
    let mut event = GrpcStreamEvent::new(stream_id, "error", started);
    event.status_code = Some(status.code() as i32);
    event.status_name = Some(code_name(status.code()).into());
    event.status_message = Some(status.message().to_string());
    event.metadata = metadata_to_vec(status.metadata());
    event
}

/// Envia mais uma mensagem num stream de cliente/bidirecional aberto.
#[tauri::command]
pub async fn grpc_stream_send(
    app: tauri::AppHandle,
    streams: tauri::State<'_, GrpcStreams>,
    stream_id: String,
    message: String,
) -> Result<(), String> {
    let (sender, input, started) = {
        let registry = streams.0.lock().await;
        let entry = registry
            .get(&stream_id)
            .ok_or_else(|| "This stream has already finished.".to_string())?;
        let sender = entry
            .sender
            .clone()
            .ok_or_else(|| "Sending is closed for this stream (End stream was used).".to_string())?;
        (sender, entry.input.clone(), entry.started)
    };

    let parsed = parse_message(&input, &message)?;
    let json = message_to_json(&parsed).ok();
    sender
        .send(parsed)
        .await
        .map_err(|_| "This stream has already finished.".to_string())?;

    let mut event = GrpcStreamEvent::new(&stream_id, "sent", started);
    event.message = json;
    emit_event(&app, event);
    Ok(())
}

/// "End stream": avisa o servidor que o cliente terminou de enviar
/// (half-close). As respostas que faltam continuam chegando.
#[tauri::command]
pub async fn grpc_stream_end(streams: tauri::State<'_, GrpcStreams>, stream_id: String) -> Result<(), String> {
    if let Some(entry) = streams.0.lock().await.get_mut(&stream_id) {
        entry.sender = None;
    }
    Ok(())
}

/// Cancela o stream na hora (aba fechada, botão Cancel).
#[tauri::command]
pub async fn grpc_stream_cancel(streams: tauri::State<'_, GrpcStreams>, stream_id: String) -> Result<(), String> {
    if let Some(entry) = streams.0.lock().await.remove(&stream_id) {
        entry.task.abort();
    }
    Ok(())
}

// ── Server reflection ───────────────────────────────────────────────────────

#[tauri::command]
pub async fn grpc_reflect(
    target: String,
    use_tls: bool,
    insecure_tls: Option<bool>,
    metadata: Vec<GrpcMetadataEntry>,
) -> Result<GrpcSchema, String> {
    let timeout = Duration::from_millis(DEFAULT_TIMEOUT_MS);
    let channel = connect(&target, use_tls, insecure_tls.unwrap_or(false), Some(timeout)).await?;
    let metadata = build_metadata(&metadata)?;

    // v1 é o padrão atual; servidores mais antigos só têm v1alpha.
    let files = match reflect_v1(channel.clone(), metadata.clone()).await {
        Ok(files) => files,
        Err(status) if status.code() == Code::Unimplemented => reflect_v1alpha(channel, metadata)
            .await
            .map_err(|s| reflection_error(&s))?,
        Err(status) => return Err(reflection_error(&status)),
    };

    let pool = pool_from_files(files)?;
    let schema = schema_from_pool(&pool);
    if schema.services.is_empty() {
        return Err("The server answered the reflection request but listed no services.".into());
    }
    Ok(schema)
}

fn reflection_error(status: &Status) -> String {
    if status.code() == Code::Unimplemented {
        "This server does not have gRPC reflection enabled. Import the .proto files instead.".into()
    } else {
        format!("Reflection failed ({}): {}", code_name(status.code()), status.message())
    }
}

// Monta o pool com os arquivos recebidos, em ordem de dependência. O que o
// servidor não mandou e é well-known type do Google vem do pool embutido.
fn pool_from_files(files: HashMap<String, FileDescriptorProto>) -> Result<DescriptorPool, String> {
    let mut pool = DescriptorPool::new();
    let mut added: HashSet<String> = HashSet::new();

    fn add(
        name: &str,
        files: &HashMap<String, FileDescriptorProto>,
        pool: &mut DescriptorPool,
        added: &mut HashSet<String>,
        stack: &mut Vec<String>,
    ) -> Result<(), String> {
        if added.contains(name) || stack.iter().any(|s| s == name) {
            return Ok(());
        }
        let file = match files.get(name) {
            Some(f) => f.clone(),
            None => match DescriptorPool::global().get_file_by_name(name) {
                Some(f) => f.file_descriptor_proto().clone(),
                None => return Err(format!("The server did not send \"{name}\" and it is not a well-known type.")),
            },
        };
        stack.push(name.to_string());
        for dep in &file.dependency {
            add(dep, files, pool, added, stack)?;
        }
        stack.pop();
        pool.add_file_descriptor_proto(file)
            .map_err(|e| format!("Invalid schema from the server ({name}): {e}"))?;
        added.insert(name.to_string());
        Ok(())
    }

    let mut names: Vec<&String> = files.keys().collect();
    names.sort();
    for name in names {
        add(name, &files, &mut pool, &mut added, &mut Vec::new())?;
    }
    Ok(pool)
}

// As duas versões do protocolo têm mensagens idênticas em pacotes diferentes;
// a macro evita duplicar a conversa à mão.
macro_rules! reflect_impl {
    ($fn_name:ident, $pb:path) => {
        async fn $fn_name(channel: Channel, metadata: MetadataMap) -> Result<HashMap<String, FileDescriptorProto>, Status> {
            use $pb as pb;
            use pb::server_reflection_client::ServerReflectionClient;
            use pb::server_reflection_request::MessageRequest;
            use pb::server_reflection_response::MessageResponse;

            let mut client = ServerReflectionClient::new(channel);

            // Uma pergunta por chamada: simples, e o volume é pequeno.
            async fn ask(
                client: &mut ServerReflectionClient<Channel>,
                metadata: &MetadataMap,
                message: MessageRequest,
            ) -> Result<MessageResponse, Status> {
                let request = pb::ServerReflectionRequest { host: String::new(), message_request: Some(message) };
                let mut req = tonic::Request::new(tokio_stream::iter(vec![request]));
                *req.metadata_mut() = metadata.clone();
                let mut stream = client.server_reflection_info(req).await?.into_inner();
                let response = stream
                    .message()
                    .await?
                    .ok_or_else(|| Status::internal("Empty reflection response"))?;
                match response.message_response {
                    Some(MessageResponse::ErrorResponse(err)) => Err(Status::new(Code::from_i32(err.error_code), err.error_message)),
                    Some(other) => Ok(other),
                    None => Err(Status::internal("Empty reflection response")),
                }
            }

            let services = match ask(&mut client, &metadata, MessageRequest::ListServices(String::new())).await? {
                MessageResponse::ListServicesResponse(list) => list.service,
                _ => return Err(Status::internal("Unexpected reflection response")),
            };

            let mut files: HashMap<String, FileDescriptorProto> = HashMap::new();
            let mut pending: Vec<MessageRequest> = services
                .iter()
                .filter(|s| !s.name.starts_with("grpc.reflection."))
                .map(|s| MessageRequest::FileContainingSymbol(s.name.clone()))
                .collect();

            while let Some(question) = pending.pop() {
                let answer = ask(&mut client, &metadata, question).await?;
                if let MessageResponse::FileDescriptorResponse(found) = answer {
                    for raw in found.file_descriptor_proto {
                        let file = FileDescriptorProto::decode(raw.as_slice())
                            .map_err(|e| Status::internal(format!("Invalid descriptor from the server: {e}")))?;
                        let name = file.name().to_string();
                        if files.contains_key(&name) {
                            continue;
                        }
                        for dep in &file.dependency {
                            let is_wkt = DescriptorPool::global().get_file_by_name(dep).is_some();
                            if !files.contains_key(dep) && !is_wkt {
                                pending.push(MessageRequest::FileByFilename(dep.clone()));
                            }
                        }
                        files.insert(name, file);
                    }
                }
            }
            Ok(files)
        }
    };
}

reflect_impl!(reflect_v1, tonic_reflection::pb::v1);
reflect_impl!(reflect_v1alpha, tonic_reflection::pb::v1alpha);

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn compiles_proto_with_well_known_import() {
        let dir = std::env::temp_dir().join(format!("devflow-grpc-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("booking.proto");
        std::fs::write(
            &file,
            r#"syntax = "proto3";
package booking.v1;
import "google/protobuf/timestamp.proto";
enum Status { STATUS_UNSPECIFIED = 0; CONFIRMED = 1; }
message Journey { string origin = 1; string destination = 2; google.protobuf.Timestamp departure = 3; }
message CreateRequest { repeated Journey journeys = 1; int64 amount_cents = 2; Status status = 3; map<string, string> tags = 4; }
message CreateReply { string record_locator = 1; }
service Bookings {
  rpc Create(CreateRequest) returns (CreateReply);
  rpc Watch(CreateRequest) returns (stream CreateReply);
}"#,
        )
        .unwrap();

        let schema = grpc_compile_protos(vec![file.to_string_lossy().to_string()], vec![]).await.unwrap();
        assert_eq!(schema.services.len(), 1);
        let service = &schema.services[0];
        assert_eq!(service.name, "booking.v1.Bookings");
        let create = service.methods.iter().find(|m| m.name == "Create").unwrap();
        assert_eq!(create.full_name, "booking.v1.Bookings/Create");
        assert!(!create.server_streaming);
        let watch = service.methods.iter().find(|m| m.name == "Watch").unwrap();
        assert!(watch.server_streaming);
        println!("template: {}", serde_json::to_string(&create.input_template).unwrap());
        assert_eq!(create.input_template["journeys"][0]["departure"], json!("1970-01-01T00:00:00Z"));
        assert_eq!(create.input_template["amountCents"], json!("0"));
        assert_eq!(create.input_template["status"], json!("STATUS_UNSPECIFIED"));

        // O schema salvo volta a ser lido igual.
        let again = grpc_describe(schema.descriptor_set.clone()).unwrap();
        assert_eq!(again.services[0].methods.len(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    #[ignore = "needs network: calls the public test server grpcb.in"]
    async fn reflection_and_unary_call_against_public_server() {
        let target = "grpcb.in:9000".to_string();
        let schema = match grpc_reflect(target.clone(), false, None, vec![]).await {
            Ok(s) => s,
            Err(e) => {
                println!("SKIP (no network to grpcb.in): {e}");
                return;
            }
        };
        let names: Vec<_> = schema.services.iter().map(|s| s.name.clone()).collect();
        println!("services: {names:?}");
        let addsvc = schema.services.iter().find(|s| s.name == "addsvc.Add").expect("addsvc.Add service");
        let sum = addsvc.methods.iter().find(|m| m.name == "Sum").expect("Sum method");

        let result = grpc_invoke(
            target.clone(),
            false,
            None,
            schema.descriptor_set.clone(),
            sum.full_name.clone(),
            r#"{"a": "2", "b": "40"}"#.into(),
            vec![GrpcMetadataEntry { key: "x-devflow-test".into(), value: "1".into() }],
            None,
        )
        .await
        .unwrap();
        println!("status {} {} response {:?} in {}ms", result.status_code, result.status_name, result.response, result.time_ms);
        assert_eq!(result.status_code, 0);
        assert!(result.response.unwrap().contains("42"));

        // Campo que não existe na mensagem → erro claro antes de enviar.
        let err = grpc_invoke(target, false, None, schema.descriptor_set, sum.full_name.clone(), r#"{"nope": 1}"#.into(), vec![], None)
            .await
            .unwrap_err();
        println!("expected error: {err}");
        assert!(err.contains("does not match"));
    }
}

#[cfg(test)]
mod tls_tests {
    use super::*;

    #[tokio::test]
    #[ignore = "needs network: calls the public test server grpcb.in"]
    async fn reflection_over_tls() {
        match grpc_reflect("grpcb.in:9001".into(), true, None, vec![]).await {
            Ok(schema) => {
                println!("TLS services: {}", schema.services.len());
                assert!(!schema.services.is_empty());
            }
            Err(e) => println!("TLS result: {e}"),
        }
    }
}

#[cfg(test)]
mod stream_tests {
    use super::*;

    // Mesmo caminho do grpc_stream_start, sem o Tauri (eventos/estado).
    async fn run_stream(method: &str, messages: Vec<&str>) -> (Vec<String>, Option<Status>) {
        let schema = grpc_reflect("grpcb.in:9000".into(), false, None, vec![]).await.unwrap();
        let pool = decode_pool(&schema.descriptor_set).unwrap();
        let (desc, path) = resolve_method(&pool, method).unwrap();
        let channel = connect("grpcb.in:9000", false, false, None).await.unwrap();

        let (sender, receiver) = mpsc::channel::<DynamicMessage>(STREAM_SEND_BUFFER);
        let mut grpc = tonic::client::Grpc::new(channel);
        grpc.ready().await.unwrap();
        let call = grpc.streaming(
            tonic::Request::new(tokio_stream::wrappers::ReceiverStream::new(receiver)),
            path,
            DynamicCodec { response: desc.output() },
        );
        // Envia e fecha o envio (half-close) enquanto a chamada anda.
        let input = desc.input();
        let owned: Vec<String> = messages.iter().map(|m| m.to_string()).collect();
        tokio::spawn(async move {
            for m in owned {
                sender.send(parse_message(&input, &m).unwrap()).await.unwrap();
            }
        });

        let mut received = Vec::new();
        match call.await {
            Ok(response) => {
                let mut stream = response.into_inner();
                loop {
                    match stream.message().await {
                        Ok(Some(m)) => received.push(message_to_json(&m).unwrap()),
                        Ok(None) => return (received, None),
                        Err(status) => return (received, Some(status)),
                    }
                }
            }
            Err(status) => (received, Some(status)),
        }
    }

    #[tokio::test]
    #[ignore = "needs network: calls the public test server grpcb.in"]
    async fn server_client_and_bidi_streams() {
        let (server, err) = run_stream("grpcbin.GRPCBin/DummyServerStream", vec![r#"{"fString": "x"}"#]).await;
        println!("server stream: {} message(s), error {:?}", server.len(), err.map(|s| s.code()));
        assert!(server.len() > 1);

        let (client, err) = run_stream(
            "grpcbin.GRPCBin/DummyClientStream",
            (0..10).map(|_| r#"{"fString": "y"}"#).collect(),
        )
        .await;
        println!("client stream: {} message(s), error {:?}", client.len(), err.map(|s| s.code()));
        assert_eq!(client.len(), 1);

        let (bidi, err) = run_stream(
            "grpcbin.GRPCBin/DummyBidirectionalStreamStream",
            vec![r#"{"fString": "a"}"#, r#"{"fString": "b"}"#, r#"{"fString": "c"}"#],
        )
        .await;
        println!("bidi stream: {} message(s), error {:?}", bidi.len(), err.map(|s| s.code()));
        assert_eq!(bidi.len(), 3);
        assert!(bidi[1].contains("\"b\""));
    }
}

#[cfg(test)]
mod insecure_tls_tests {
    use super::*;
    use tonic::transport::{Identity, Server, ServerTlsConfig};

    // Servidor gRPC local com TLS e certificado autoassinado — o caso típico
    // de servidor de desenvolvimento/homologação sem certificado válido. Só
    // serve a própria reflection, o suficiente pra fechar o TLS e responder.
    async fn start_self_signed_server() -> u16 {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()]).unwrap();
        let identity = Identity::from_pem(cert.cert.pem(), cert.signing_key.serialize_pem());
        let reflection = tonic_reflection::server::Builder::configure()
            .register_encoded_file_descriptor_set(tonic_reflection::pb::v1::FILE_DESCRIPTOR_SET)
            .build_v1()
            .unwrap();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            Server::builder()
                .tls_config(ServerTlsConfig::new().identity(identity))
                .unwrap()
                .add_service(reflection)
                .serve_with_incoming(tokio_stream::wrappers::TcpListenerStream::new(listener))
                .await
                .unwrap();
        });
        port
    }

    #[tokio::test]
    async fn self_signed_certificate_needs_the_insecure_option() {
        let port = start_self_signed_server().await;
        let target = format!("127.0.0.1:{port}");

        // Padrão: certificado autoassinado é recusado.
        let strict = grpc_reflect(target.clone(), true, Some(false), vec![]).await.unwrap_err();
        println!("strict TLS: {strict}");
        assert!(strict.contains("Could not connect"), "{strict}");

        // Com a opção, o TLS fecha e a reflection responde. O servidor do
        // teste só tem o próprio serviço de reflection, que o DevFlow esconde
        // da lista — por isso o "listed no services": prova que a conversa
        // gRPC aconteceu por cima do TLS aceito.
        let insecure = grpc_reflect(target, true, Some(true), vec![]).await.unwrap_err();
        println!("insecure TLS: {insecure}");
        assert!(insecure.contains("listed no services"), "{insecure}");
    }
}
