// ─────────────────────────────────────────────────────────────────────────────
// Load Test — Fase 1 (VUs constantes) + Fase 2 (ramp por estágios + thresholds)
// + Fase 3 (fluxo com múltiplas requests e correlação via post-response script)
// ─────────────────────────────────────────────────────────────────────────────
// Motor de teste de carga rodando inteiramente no lado Rust (evita o overhead
// de IPC do Tauri por requisição, que inviabilizaria qualquer throughput real
// se orquestrado do frontend via invoke() repetido).
//
// O alvo do teste é sempre um `flow`: uma lista de 1+ requests. Cada VU roda
// o fluxo inteiro por iteração, na ordem, com seu PRÓPRIO envMap evoluindo —
// variáveis resolvidas ({{var}} e :pathParam) a cada request, não mais uma
// vez só no frontend, porque agora elas podem mudar no meio do fluxo.
//
// Duas engines internas, escolhidas automaticamente por request de config:
//
//   • Engine "simples" (rápida): usada quando o fluxo tem 1 request e nenhum
//     post-response script. Continua 100% async/tokio::spawn, sem nenhum
//     touch em QuickJS — preserva o throughput das Fases 1/2 intacto.
//
//   • Engine "fluxo" (Fase 3): usada quando há mais de uma request no fluxo
//     OU qualquer request tem post-response script. Cada VU roda numa thread
//     dedicada (tokio::task::spawn_blocking) com seu próprio QuickJS Runtime
//     +Context CRIADO UMA VEZ e reaproveitado por toda a vida do VU (não por
//     request) — isso é o "pool de contexto" que evita pagar o custo de
//     inicializar o interpretador a cada iteração. As chamadas HTTP dentro
//     dessa thread usam o mesmo reqwest::Client assíncrono de sempre, só que
//     via tokio::runtime::Handle::block_on (padrão recomendado pra chamar
//     código async de dentro de uma blocking task).
//
// Escopo da Fase 3: só POST-RESPONSE script (extrair dado da resposta pra
// uma variável — o padrão clássico de "login, pega token, usa nas próximas").
// Pre-request script fica pra uma iteração futura se for necessário; a
// grande maioria dos fluxos de correlação não precisa dele.
//
// Modos de carga (Fase 1/2) e thresholds (Fase 2) continuam funcionando
// exatamente igual, agora por cima do conceito de fluxo em vez de uma
// request fixa.

use base64::{engine::general_purpose, Engine as _};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use rquickjs::{prelude::Func, Context, Runtime};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::task::JoinHandle;

use crate::SslVerifyState;

// Guardas de sanidade — evita que a UI derrube o app pedindo algo absurdo.
const MAX_VUS: u32 = 2000;
const MAX_DURATION_SECS: u64 = 3600;
const MAX_ITERATIONS_PER_VU: u32 = 100_000;
const MAX_STAGES: usize = 20;
const MAX_THRESHOLDS: usize = 10;
const MAX_FLOW_STEPS: usize = 30;
const DEFAULT_TIMEOUT_SECS: u64 = 30;
const TICK_INTERVAL: Duration = Duration::from_millis(500);
const RAMP_TICK: Duration = Duration::from_millis(200);
const SLOT_IDLE_POLL: Duration = Duration::from_millis(150);

const VALID_METRICS: [&str; 9] = ["p50", "p90", "p95", "p99", "avg", "min", "max", "errorRate", "rps"];
const VALID_OPERATORS: [&str; 4] = ["<", "<=", ">", ">="];

// Mesma lista e regras de src/lib/defaultHeaders.ts (nome, valor, só com
// body?). Mudou lá, muda aqui.
const DEFAULT_HEADERS: [(&str, &str, bool); 5] = [
    ("User-Agent", "DevFlowRuntime/1.0.0", false),
    ("Accept", "*/*", false),
    ("Connection", "keep-alive", false),
    ("Cache-Control", "no-cache", false),
    ("Content-type", "application/json", true),
];

// Contador global só pra garantir test_id único mesmo em tese de dois starts
// disparados no mesmíssimo nanosegundo.
static LOAD_TEST_COUNTER: AtomicU64 = AtomicU64::new(0);

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestKeyValue {
    pub key: String,
    #[serde(default)]
    pub value: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestAuthConfig {
    #[serde(rename = "type", default)]
    pub auth_type: String, // "none" | "bearer" | "basic" | "apikey"
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default)]
    pub value: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestFlowStep {
    pub method: String,
    pub url: String,
    #[serde(default)]
    pub path_params: Vec<LoadTestKeyValue>,
    #[serde(default)]
    pub headers: Vec<LoadTestKeyValue>,
    // Headers automáticos que a request desligou (lib/defaultHeaders.ts).
    #[serde(default)]
    pub disabled_default_headers: Vec<String>,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub auth: Option<LoadTestAuthConfig>,
    // Fase 3 — só post-response por enquanto (ver comentário no topo do arquivo).
    #[serde(default)]
    pub post_response_script: Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestStage {
    pub target_vus: u32,
    pub duration_secs: u64,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestThreshold {
    // "p50" | "p90" | "p95" | "p99" | "avg" | "min" | "max" | "errorRate" | "rps"
    pub metric: String,
    // "<" | "<=" | ">" | ">="
    pub operator: String,
    pub value: f64,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestThresholdResult {
    pub metric: String,
    pub operator: String,
    pub value: f64,
    pub actual: f64,
    pub passed: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestConfig {
    pub flow: Vec<LoadTestFlowStep>,
    // Ambiente base — semeia o envMap de CADA VU (cada um evolui o seu depois,
    // via post-response script; não é compartilhado entre VUs).
    #[serde(default)]
    pub environment: HashMap<String, String>,
    // ── Modo constante (Fase 1) — usado só quando `stages` está ausente/vazio.
    #[serde(default)]
    pub vus: Option<u32>,
    #[serde(default)]
    pub duration_secs: Option<u64>,
    #[serde(default)]
    pub iterations_per_vu: Option<u32>,
    // ── Modo ramp (Fase 2) — se presente e não-vazio, tem prioridade total
    // sobre vus/duration_secs/iterations_per_vu.
    #[serde(default)]
    pub stages: Option<Vec<LoadTestStage>>,
    // ── Thresholds — funcionam nos dois modos.
    #[serde(default)]
    pub thresholds: Option<Vec<LoadTestThreshold>>,
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoadTestSnapshot {
    pub test_id: String,
    pub elapsed_ms: u64,
    pub vus_active: u32,
    pub requests_total: u64,
    pub requests_ok: u64,
    pub requests_failed: u64,
    pub rps_current: f64,
    pub rps_avg: f64,
    pub latency_min_ms: f64,
    pub latency_avg_ms: f64,
    pub latency_max_ms: f64,
    pub latency_p50_ms: f64,
    pub latency_p90_ms: f64,
    pub latency_p95_ms: f64,
    pub latency_p99_ms: f64,
    // Chave é o status code como string (ex: "200", "404") ou "error" pra
    // falhas de rede/timeout — HashMap<u16,_> em JSON é problemático demais
    // pra confiar de olho, string é sempre seguro.
    pub status_codes: HashMap<String, u64>,
    // Post-response scripts que lançaram exceção — não abortam o teste, só
    // são contados aqui pra o usuário perceber que a correlação pode estar
    // quebrada mesmo com requests "ok".
    pub script_errors: u64,
    pub threshold_results: Vec<LoadTestThresholdResult>,
    pub done: bool,
}

// Estado global gerenciado pelo Tauri: mapeia test_id -> flag de parada.
// stop_load_test só precisa sinalizar essa flag; quem efetivamente para o
// loop são as próprias tasks das VUs, checando a flag a cada iteração.
#[derive(Default)]
pub struct LoadTestRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

struct Aggregator {
    requests_total: AtomicU64,
    requests_ok: AtomicU64,
    requests_failed: AtomicU64,
    script_errors: AtomicU64,
    latencies_us: Mutex<Vec<u64>>,
    status_codes: Mutex<HashMap<String, u64>>,
    vus_active: AtomicU32,
}

impl Aggregator {
    fn new() -> Self {
        Aggregator {
            requests_total: AtomicU64::new(0),
            requests_ok: AtomicU64::new(0),
            requests_failed: AtomicU64::new(0),
            script_errors: AtomicU64::new(0),
            latencies_us: Mutex::new(Vec::new()),
            status_codes: Mutex::new(HashMap::new()),
            vus_active: AtomicU32::new(0),
        }
    }
}

// ── Resolução de {{variáveis}} e :pathParams — feita em Rust, por request,
// porque agora o envMap evolui por VU durante o fluxo (não dá mais pra
// resolver uma vez só no frontend como nas Fases 1/2). Implementação manual
// (sem crate de regex) pra não adicionar dependência nova.
fn resolve_template(text: &str, env: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(text.len());
    let mut rest = text;
    loop {
        match rest.find("{{") {
            Some(start) => {
                result.push_str(&rest[..start]);
                let after_open = &rest[start + 2..];
                match after_open.find("}}") {
                    Some(end) => {
                        let key = after_open[..end].trim();
                        match env.get(key) {
                            Some(v) => result.push_str(v),
                            None => {
                                result.push_str("{{");
                                result.push_str(key);
                                result.push_str("}}");
                            }
                        }
                        rest = &after_open[end + 2..];
                    }
                    None => {
                        result.push_str(&rest[start..]);
                        rest = "";
                        break;
                    }
                }
            }
            None => {
                result.push_str(rest);
                break;
            }
        }
    }
    result
}

fn resolve_path_params(url: &str, params: &[LoadTestKeyValue]) -> String {
    let chars: Vec<char> = url.chars().collect();
    let mut result = String::with_capacity(url.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == ':' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            if j > i + 1 {
                let name: String = chars[i + 1..j].iter().collect();
                if let Some(found) = params.iter().find(|p| p.key == name && p.enabled) {
                    result.push_str(&found.value);
                    i = j;
                    continue;
                }
            }
        }
        result.push(chars[i]);
        i += 1;
    }
    result
}

fn apply_auth(headers: &mut HashMap<String, String>, auth: &Option<LoadTestAuthConfig>, env: &HashMap<String, String>) {
    let Some(auth) = auth else { return };
    match auth.auth_type.as_str() {
        "bearer" => {
            if let Some(token) = &auth.token {
                if !token.trim().is_empty() {
                    headers.insert("Authorization".to_string(), format!("Bearer {}", resolve_template(token, env)));
                }
            }
        }
        "basic" => {
            let user = auth.username.as_deref().map(|u| resolve_template(u, env)).unwrap_or_default();
            let pass = auth.password.as_deref().map(|p| resolve_template(p, env)).unwrap_or_default();
            let encoded = general_purpose::STANDARD.encode(format!("{}:{}", user, pass));
            headers.insert("Authorization".to_string(), format!("Basic {}", encoded));
        }
        "apikey" => {
            if let (Some(key), Some(value)) = (&auth.key, &auth.value) {
                if !key.trim().is_empty() {
                    headers.insert(resolve_template(key, env), resolve_template(value, env));
                }
            }
        }
        _ => {}
    }
}

// Resolve um step do fluxo (método, URL, headers, body) contra o envMap
// ATUAL do VU — chamado a cada request, não uma vez só.
fn resolve_step(step: &LoadTestFlowStep, env: &HashMap<String, String>) -> (reqwest::Method, String, HeaderMap, Option<String>) {
    let path_resolved = resolve_path_params(&step.url, &step.path_params);
    let url = resolve_template(&path_resolved, env);

    let body = step.body.as_ref().map(|b| resolve_template(b, env));
    let has_body = body.as_deref().map_or(false, |b| !b.trim().is_empty());

    // Padrões → headers da request → auth, cada camada substituindo a
    // anterior SEM diferenciar maiúsculas/minúsculas. Antes o HashMap tinha
    // "Content-type" (padrão) e "Content-Type" (usuário) como chaves
    // diferentes e qual dos dois ia pro HeaderMap dependia da ordem de
    // iteração do HashMap — ou seja, aleatório.
    let mut header_strings: HashMap<String, String> = HashMap::new();
    for (k, v, only_with_body) in DEFAULT_HEADERS.iter() {
        let disabled = step.disabled_default_headers.iter().any(|d| d.eq_ignore_ascii_case(k));
        if disabled || (*only_with_body && !has_body) {
            continue;
        }
        header_strings.insert((*k).to_string(), (*v).to_string());
    }
    for h in &step.headers {
        if h.enabled && !h.key.trim().is_empty() {
            header_strings.retain(|existing, _| !existing.eq_ignore_ascii_case(&h.key));
            header_strings.insert(h.key.clone(), resolve_template(&h.value, env));
        }
    }
    let mut auth_headers: HashMap<String, String> = HashMap::new();
    apply_auth(&mut auth_headers, &step.auth, env);
    for (k, v) in auth_headers {
        header_strings.retain(|existing, _| !existing.eq_ignore_ascii_case(&k));
        header_strings.insert(k, v);
    }

    let mut header_map = HeaderMap::new();
    for (k, v) in header_strings {
        if k.eq_ignore_ascii_case("accept-encoding") {
            continue;
        }
        if let (Ok(name), Ok(val)) = (HeaderName::from_bytes(k.as_bytes()), HeaderValue::from_str(&v)) {
            header_map.insert(name, val);
        }
    }

    let method = reqwest::Method::from_bytes(step.method.to_uppercase().as_bytes()).unwrap_or(reqwest::Method::GET);

    (method, url, header_map, body)
}

// Percentil simples por ordenação — para o volume esperado nesta fase (até
// algumas dezenas de milhares de amostras) é rápido o suficiente pra rodar
// a cada tick sem precisar de uma lib de histograma (hdrhistogram etc).
fn percentile_ms(sorted_us: &[u64], p: f64) -> f64 {
    if sorted_us.is_empty() {
        return 0.0;
    }
    let idx = ((p / 100.0) * (sorted_us.len() as f64 - 1.0)).round() as usize;
    sorted_us[idx.min(sorted_us.len() - 1)] as f64 / 1000.0
}

fn evaluate_thresholds(thresholds: &[LoadTestThreshold], snap: &LoadTestSnapshot) -> Vec<LoadTestThresholdResult> {
    thresholds
        .iter()
        .map(|t| {
            let error_rate = if snap.requests_total > 0 {
                (snap.requests_failed as f64 / snap.requests_total as f64) * 100.0
            } else {
                0.0
            };
            let actual = match t.metric.as_str() {
                "p50" => snap.latency_p50_ms,
                "p90" => snap.latency_p90_ms,
                "p95" => snap.latency_p95_ms,
                "p99" => snap.latency_p99_ms,
                "avg" => snap.latency_avg_ms,
                "min" => snap.latency_min_ms,
                "max" => snap.latency_max_ms,
                "rps" => snap.rps_avg,
                "errorRate" => error_rate,
                _ => 0.0,
            };
            let passed = match t.operator.as_str() {
                "<" => actual < t.value,
                "<=" => actual <= t.value,
                ">" => actual > t.value,
                ">=" => actual >= t.value,
                _ => false,
            };
            LoadTestThresholdResult {
                metric: t.metric.clone(),
                operator: t.operator.clone(),
                value: t.value,
                actual,
                passed,
            }
        })
        .collect()
}

fn build_snapshot(
    test_id: &str,
    agg: &Aggregator,
    started_at: Instant,
    done: bool,
    thresholds: &[LoadTestThreshold],
) -> LoadTestSnapshot {
    let total = agg.requests_total.load(Ordering::Relaxed);
    let ok = agg.requests_ok.load(Ordering::Relaxed);
    let failed = agg.requests_failed.load(Ordering::Relaxed);
    let elapsed = started_at.elapsed();
    let elapsed_secs = elapsed.as_secs_f64().max(0.001);

    let mut latencies = agg.latencies_us.lock().unwrap().clone();
    latencies.sort_unstable();

    let (min, avg, max) = if latencies.is_empty() {
        (0.0, 0.0, 0.0)
    } else {
        let sum: u64 = latencies.iter().sum();
        (
            *latencies.first().unwrap() as f64 / 1000.0,
            (sum as f64 / latencies.len() as f64) / 1000.0,
            *latencies.last().unwrap() as f64 / 1000.0,
        )
    };

    let mut snapshot = LoadTestSnapshot {
        test_id: test_id.to_string(),
        elapsed_ms: elapsed.as_millis() as u64,
        vus_active: agg.vus_active.load(Ordering::Relaxed),
        requests_total: total,
        requests_ok: ok,
        requests_failed: failed,
        rps_current: 0.0, // preenchido pelo ticker (delta entre ticks)
        rps_avg: total as f64 / elapsed_secs,
        latency_min_ms: min,
        latency_avg_ms: avg,
        latency_max_ms: max,
        latency_p50_ms: percentile_ms(&latencies, 50.0),
        latency_p90_ms: percentile_ms(&latencies, 90.0),
        latency_p95_ms: percentile_ms(&latencies, 95.0),
        latency_p99_ms: percentile_ms(&latencies, 99.0),
        status_codes: agg.status_codes.lock().unwrap().clone(),
        script_errors: agg.script_errors.load(Ordering::Relaxed),
        threshold_results: Vec::new(),
        done,
    };

    snapshot.threshold_results = evaluate_thresholds(thresholds, &snapshot);
    snapshot
}

fn validate_stages(stages: &[LoadTestStage]) -> Result<(), String> {
    if stages.is_empty() {
        return Err("Add at least one stage.".to_string());
    }
    if stages.len() > MAX_STAGES {
        return Err(format!("Limited to {} stages.", MAX_STAGES));
    }
    let mut total: u64 = 0;
    for stage in stages {
        if stage.target_vus > MAX_VUS {
            return Err(format!("Stage target VUs limited to {}.", MAX_VUS));
        }
        total = total.saturating_add(stage.duration_secs);
    }
    if total == 0 {
        return Err("Stages must add up to more than zero seconds.".to_string());
    }
    if total > MAX_DURATION_SECS {
        return Err(format!("Total stages duration limited to {} seconds.", MAX_DURATION_SECS));
    }
    Ok(())
}

fn validate_thresholds(thresholds: &[LoadTestThreshold]) -> Result<(), String> {
    if thresholds.len() > MAX_THRESHOLDS {
        return Err(format!("Limited to {} thresholds.", MAX_THRESHOLDS));
    }
    for t in thresholds {
        if !VALID_METRICS.contains(&t.metric.as_str()) {
            return Err(format!("Unknown threshold metric '{}'.", t.metric));
        }
        if !VALID_OPERATORS.contains(&t.operator.as_str()) {
            return Err(format!("Unknown threshold operator '{}'.", t.operator));
        }
    }
    Ok(())
}

// Alvo de VUs ativos no instante `elapsed`, interpolando linearmente dentro
// do estágio corrente (rampa suave, igual ao executor "ramping-vus" do k6).
// Estágio de duração zero = salto instantâneo pro alvo dele.
fn compute_ramp_target(stages: &[LoadTestStage], elapsed: Duration) -> u32 {
    let mut stage_start = Duration::ZERO;
    let mut prev_target: u32 = 0;

    for stage in stages {
        let stage_duration = Duration::from_secs(stage.duration_secs);
        let stage_end = stage_start + stage_duration;

        if stage_duration.is_zero() {
            if elapsed < stage_end || elapsed == stage_start {
                return stage.target_vus;
            }
        } else if elapsed < stage_end {
            let progress = ((elapsed.saturating_sub(stage_start)).as_secs_f64() / stage_duration.as_secs_f64())
                .clamp(0.0, 1.0);
            let interpolated = prev_target as f64 + (stage.target_vus as f64 - prev_target as f64) * progress;
            return interpolated.round() as u32;
        }

        stage_start = stage_end;
        prev_target = stage.target_vus;
    }

    stages.last().map(|s| s.target_vus).unwrap_or(0)
}

fn total_stages_duration(stages: &[LoadTestStage]) -> Duration {
    stages.iter().fold(Duration::ZERO, |acc, s| acc + Duration::from_secs(s.duration_secs))
}

fn needs_flow_engine(flow: &[LoadTestFlowStep]) -> bool {
    flow.len() > 1 || flow.iter().any(|s| s.post_response_script.is_some())
}

// ── Ticker + finalização — compartilhados por todos os modos/engines ───────
// A condição de parada da UI (evento "load-test-done") é sempre "todas as
// tasks de VU terminaram", nunca inferida de vus_active — isso evita uma
// classe inteira de bugs de sincronia entre os modos.
fn spawn_monitor(
    app: AppHandle,
    agg: Arc<Aggregator>,
    test_id: String,
    started_at: Instant,
    thresholds: Vec<LoadTestThreshold>,
    vu_handles: Vec<JoinHandle<()>>,
) {
    let test_finished = Arc::new(AtomicBool::new(false));

    {
        let app = app.clone();
        let agg = Arc::clone(&agg);
        let test_id = test_id.clone();
        let thresholds = thresholds.clone();
        let test_finished = Arc::clone(&test_finished);

        tokio::spawn(async move {
            let mut last_total: u64 = 0;
            loop {
                tokio::time::sleep(TICK_INTERVAL).await;

                let mut snapshot = build_snapshot(&test_id, &agg, started_at, false, &thresholds);
                let current_total = snapshot.requests_total;
                snapshot.rps_current =
                    (current_total.saturating_sub(last_total)) as f64 / TICK_INTERVAL.as_secs_f64();
                last_total = current_total;

                let _ = app.emit("load-test-progress", snapshot);

                if test_finished.load(Ordering::Relaxed) {
                    break;
                }
            }
        });
    }

    {
        let app = app.clone();
        let agg = Arc::clone(&agg);
        let test_id = test_id.clone();
        let thresholds = thresholds.clone();
        let test_finished = Arc::clone(&test_finished);

        tokio::spawn(async move {
            for h in vu_handles {
                let _ = h.await;
            }

            agg.vus_active.store(0, Ordering::Relaxed);
            test_finished.store(true, Ordering::Relaxed);

            let mut summary = build_snapshot(&test_id, &agg, started_at, true, &thresholds);
            summary.rps_current = summary.rps_avg;
            let _ = app.emit("load-test-done", summary);

            if let Some(state) = app.try_state::<LoadTestRegistry>() {
                if let Ok(mut reg) = state.0.lock() {
                    reg.remove(&test_id);
                }
            }
        });
    }
}

async fn send_one(client: &reqwest::Client, step: &LoadTestFlowStep, env: &HashMap<String, String>, agg: &Aggregator) {
    let (method, url, headers, body) = resolve_step(step, env);
    let mut builder = client.request(method, &url).headers(headers);
    if let Some(b) = body {
        builder = builder.body(b);
    }

    let t0 = Instant::now();
    let result = builder.send().await;
    let elapsed_us = t0.elapsed().as_micros() as u64;

    agg.requests_total.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut latencies) = agg.latencies_us.lock() {
        latencies.push(elapsed_us);
    }

    match result {
        Ok(resp) => {
            let status = resp.status().as_u16();
            agg.requests_ok.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut codes) = agg.status_codes.lock() {
                *codes.entry(status.to_string()).or_insert(0) += 1;
            }
            // Drena o corpo pra devolver a conexão pro pool do reqwest.
            let _ = resp.bytes().await;
        }
        Err(_e) => {
            agg.requests_failed.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut codes) = agg.status_codes.lock() {
                *codes.entry("error".to_string()).or_insert(0) += 1;
            }
        }
    }
}

fn spawn_constant_vus(
    agg: Arc<Aggregator>,
    stop_flag: Arc<AtomicBool>,
    async_client: reqwest::Client,
    rt_handle: tokio::runtime::Handle,
    flow: Vec<LoadTestFlowStep>,
    base_env: HashMap<String, String>,
    vus: u32,
    deadline: Option<Instant>,
    iterations_per_vu: Option<u32>,
) -> Vec<JoinHandle<()>> {
    agg.vus_active.store(vus, Ordering::Relaxed);
    let use_flow_engine = needs_flow_engine(&flow);

    let mut vu_handles = Vec::with_capacity(vus as usize);
    for _ in 0..vus {
        let agg = Arc::clone(&agg);
        let stop_flag = Arc::clone(&stop_flag);
        let flow = flow.clone();
        let base_env = base_env.clone();

        if use_flow_engine {
            let async_client = async_client.clone();
            let rt_handle = rt_handle.clone();
            let handle = tokio::task::spawn_blocking(move || {
                run_flow_vu_blocking(flow, base_env, async_client, rt_handle, stop_flag, agg, deadline, iterations_per_vu, None);
            });
            vu_handles.push(handle);
        } else {
            let client = async_client.clone();
            let step = flow[0].clone();
            let handle = tokio::spawn(async move {
                let mut local_iter: u32 = 0;
                loop {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    if let Some(dl) = deadline {
                        if Instant::now() >= dl {
                            break;
                        }
                    }
                    if let Some(max_iter) = iterations_per_vu {
                        if local_iter >= max_iter {
                            break;
                        }
                    }

                    send_one(&client, &step, &base_env, &agg).await;
                    local_iter += 1;
                }
                agg.vus_active.fetch_sub(1, Ordering::Relaxed);
            });
            vu_handles.push(handle);
        }
    }

    vu_handles
}

struct RampSlotParams {
    idx: u32,
    desired_active_vus: Arc<AtomicU32>,
    started_at: Instant,
    total_duration: Duration,
}

fn spawn_ramping_vus(
    agg: Arc<Aggregator>,
    stop_flag: Arc<AtomicBool>,
    async_client: reqwest::Client,
    rt_handle: tokio::runtime::Handle,
    flow: Vec<LoadTestFlowStep>,
    base_env: HashMap<String, String>,
    stages: Vec<LoadTestStage>,
    started_at: Instant,
) -> Vec<JoinHandle<()>> {
    let max_vus = stages.iter().map(|s| s.target_vus).max().unwrap_or(0);
    let total_duration = total_stages_duration(&stages);
    let desired_active_vus = Arc::new(AtomicU32::new(0));
    let use_flow_engine = needs_flow_engine(&flow);

    // ── Scheduler: recalcula o alvo de VUs ativos a cada tick ──────────────
    {
        let stop_flag = Arc::clone(&stop_flag);
        let desired_active_vus = Arc::clone(&desired_active_vus);
        let agg = Arc::clone(&agg);
        let stages = stages.clone();

        tokio::spawn(async move {
            loop {
                if stop_flag.load(Ordering::Relaxed) {
                    desired_active_vus.store(0, Ordering::Relaxed);
                    break;
                }
                let elapsed = started_at.elapsed();
                if elapsed >= total_duration {
                    desired_active_vus.store(0, Ordering::Relaxed);
                    break;
                }

                let target = compute_ramp_target(&stages, elapsed);
                desired_active_vus.store(target, Ordering::Relaxed);
                agg.vus_active.store(target, Ordering::Relaxed);

                tokio::time::sleep(RAMP_TICK).await;
            }
        });
    }

    // ── Slots de VU: todos pré-criados (max_vus), cada um só manda request
    // se o próprio índice estiver dentro do alvo corrente ────────────────
    let mut vu_handles = Vec::with_capacity(max_vus as usize);
    for idx in 0..max_vus {
        let agg = Arc::clone(&agg);
        let stop_flag = Arc::clone(&stop_flag);
        let desired_active_vus = Arc::clone(&desired_active_vus);
        let flow = flow.clone();
        let base_env = base_env.clone();

        if use_flow_engine {
            let async_client = async_client.clone();
            let rt_handle = rt_handle.clone();
            let ramp = RampSlotParams {
                idx,
                desired_active_vus,
                started_at,
                total_duration,
            };
            let handle = tokio::task::spawn_blocking(move || {
                run_flow_vu_blocking(flow, base_env, async_client, rt_handle, stop_flag, agg, None, None, Some(ramp));
            });
            vu_handles.push(handle);
        } else {
            let client = async_client.clone();
            let step = flow[0].clone();
            let handle = tokio::spawn(async move {
                loop {
                    if stop_flag.load(Ordering::Relaxed) {
                        break;
                    }
                    if started_at.elapsed() >= total_duration {
                        break;
                    }

                    let desired = desired_active_vus.load(Ordering::Relaxed);
                    if idx >= desired {
                        tokio::time::sleep(SLOT_IDLE_POLL).await;
                        continue;
                    }

                    send_one(&client, &step, &base_env, &agg).await;
                }
            });
            vu_handles.push(handle);
        }
    }

    vu_handles
}

// ── Pool de contexto QuickJS por VU (Fase 3) ────────────────────────────────
// Criado UMA VEZ por VU (não por request) — é isso que faz o post-response
// script não pesar tanto em carga alta. A API exposta aqui é deliberadamente
// enxuta (só o necessário pra correlação): pm.environment.*/variables.* pra
// ler/setar variáveis, e pm.response.* pra ler o resultado da request.
struct ScriptEngine {
    // Precisam ficar vivos juntos pelo tempo de vida do VU — o Context
    // referencia internamente o Runtime.
    _runtime: Runtime,
    context: Context,
    env: Arc<Mutex<HashMap<String, String>>>,
}

impl ScriptEngine {
    fn new(base_env: HashMap<String, String>) -> Option<Self> {
        let runtime = Runtime::new().ok()?;
        runtime.set_memory_limit(32 * 1024 * 1024);
        runtime.set_max_stack_size(512 * 1024);
        let context = Context::full(&runtime).ok()?;
        let env = Arc::new(Mutex::new(base_env));

        let bind_result: Result<(), String> = context.with(|ctx| {
            let globals = ctx.globals();

            let env_get = Arc::clone(&env);
            let get_fn = Func::from(move |key: String| -> Option<String> {
                env_get.lock().ok().and_then(|e| e.get(&key).cloned())
            });
            globals.set("__env_get", get_fn).map_err(|e| e.to_string())?;

            let env_set = Arc::clone(&env);
            let set_fn = Func::from(move |key: String, value: String| {
                if let Ok(mut e) = env_set.lock() {
                    e.insert(key, value);
                }
            });
            globals.set("__env_set", set_fn).map_err(|e| e.to_string())?;

            let env_unset = Arc::clone(&env);
            let unset_fn = Func::from(move |key: String| {
                if let Ok(mut e) = env_unset.lock() {
                    e.remove(&key);
                }
            });
            globals.set("__env_unset", unset_fn).map_err(|e| e.to_string())?;

            // Placeholders — sobrescritos a cada chamada de run_post_response.
            globals.set("__response_body", String::new()).map_err(|e| e.to_string())?;
            globals.set("__response_status_code", 0i64).map_err(|e| e.to_string())?;
            globals.set("__response_time", 0f64).map_err(|e| e.to_string())?;

            let no_headers: Arc<HashMap<String, String>> = Arc::new(HashMap::new());
            let header_get_fn = Func::from(move |key: String| -> Option<String> {
                no_headers.get(&key.to_lowercase()).cloned()
            });
            globals.set("__response_header_get", header_get_fn).map_err(|e| e.to_string())?;

            let bootstrap = r#"
                globalThis.console = { log(){}, info(){}, warn(){}, error(){} };

                function __makeEnvAccessor() {
                    return {
                        get(key) { return __env_get(String(key)); },
                        set(key, value) { __env_set(String(key), String(value)); },
                        has(key) { const v = __env_get(String(key)); return v !== undefined && v !== null; },
                        unset(key) { __env_unset(String(key)); }
                    };
                }

                globalThis.pm = {
                    environment: __makeEnvAccessor(),
                    variables: __makeEnvAccessor(),
                    globals: __makeEnvAccessor(),
                    collectionVariables: __makeEnvAccessor(),
                    response: {
                        get code() { return __response_status_code; },
                        get status() { return __response_status_code; },
                        get responseTime() { return __response_time; },
                        text() { return __response_body; },
                        json() { return JSON.parse(__response_body); },
                        headers: {
                            get(key) { return __response_header_get(String(key)); },
                            has(key) {
                                const v = __response_header_get(String(key));
                                return v !== undefined && v !== null;
                            }
                        }
                    }
                };
            "#;
            ctx.eval::<(), _>(bootstrap).map_err(|e| e.to_string())?;
            Ok(())
        });
        bind_result.ok()?;

        Some(ScriptEngine {
            _runtime: runtime,
            context,
            env,
        })
    }

    fn run_post_response(
        &self,
        script: &str,
        response_body: &str,
        status: i64,
        headers: &HashMap<String, String>,
        response_time_ms: f64,
    ) -> Result<(), String> {
        self.context.with(|ctx| {
            let globals = ctx.globals();
            globals.set("__response_body", response_body.to_string()).map_err(|e| e.to_string())?;
            globals.set("__response_status_code", status).map_err(|e| e.to_string())?;
            globals.set("__response_time", response_time_ms).map_err(|e| e.to_string())?;

            let headers_owned = Arc::new(headers.clone());
            let header_get_fn = Func::from(move |key: String| -> Option<String> {
                headers_owned.get(&key.to_lowercase()).cloned()
            });
            globals.set("__response_header_get", header_get_fn).map_err(|e| e.to_string())?;

            ctx.eval::<(), _>(script).map_err(|e| e.to_string())
        })
    }

    fn snapshot_env(&self) -> HashMap<String, String> {
        self.env.lock().map(|e| e.clone()).unwrap_or_default()
    }
}

// VU rodando o motor de fluxo (Fase 3) — thread dedicada via spawn_blocking.
// `ramp` é `Some` no modo ramp (espera o próprio índice liberar antes de
// mandar request) e `None` no modo constante (usa deadline/iterations_cap).
fn run_flow_vu_blocking(
    flow: Vec<LoadTestFlowStep>,
    base_env: HashMap<String, String>,
    async_client: reqwest::Client,
    rt_handle: tokio::runtime::Handle,
    stop_flag: Arc<AtomicBool>,
    agg: Arc<Aggregator>,
    deadline: Option<Instant>,
    iterations_cap: Option<u32>,
    ramp: Option<RampSlotParams>,
) {
    let engine = ScriptEngine::new(base_env.clone());
    let mut env = base_env;
    let mut local_iter: u32 = 0;

    'iterations: loop {
        if stop_flag.load(Ordering::Relaxed) {
            break;
        }
        if let Some(r) = &ramp {
            if r.started_at.elapsed() >= r.total_duration {
                break;
            }
        } else if let Some(dl) = deadline {
            if Instant::now() >= dl {
                break;
            }
        }
        if let Some(max_iter) = iterations_cap {
            if local_iter >= max_iter {
                break;
            }
        }

        for step in &flow {
            if stop_flag.load(Ordering::Relaxed) {
                break 'iterations;
            }

            if let Some(r) = &ramp {
                loop {
                    if stop_flag.load(Ordering::Relaxed) || r.started_at.elapsed() >= r.total_duration {
                        break 'iterations;
                    }
                    if r.idx < r.desired_active_vus.load(Ordering::Relaxed) {
                        break;
                    }
                    std::thread::sleep(SLOT_IDLE_POLL);
                }
            }

            let (method, url, headers, body) = resolve_step(step, &env);

            let t0 = Instant::now();
            let send_result = rt_handle.block_on(async {
                let mut builder = async_client.request(method, &url).headers(headers);
                if let Some(b) = body {
                    builder = builder.body(b);
                }
                builder.send().await
            });
            let elapsed_us = t0.elapsed().as_micros() as u64;

            agg.requests_total.fetch_add(1, Ordering::Relaxed);
            if let Ok(mut latencies) = agg.latencies_us.lock() {
                latencies.push(elapsed_us);
            }

            match send_result {
                Ok(resp) => {
                    let status = resp.status().as_u16();
                    let mut resp_headers: HashMap<String, String> = HashMap::new();
                    for (name, value) in resp.headers().iter() {
                        resp_headers.insert(name.to_string().to_lowercase(), value.to_str().unwrap_or("").to_string());
                    }

                    agg.requests_ok.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut codes) = agg.status_codes.lock() {
                        *codes.entry(status.to_string()).or_insert(0) += 1;
                    }

                    if let Some(script) = &step.post_response_script {
                        let body_text = rt_handle.block_on(async { resp.text().await }).unwrap_or_default();
                        if let Some(eng) = &engine {
                            let response_time_ms = elapsed_us as f64 / 1000.0;
                            if eng
                                .run_post_response(script, &body_text, status as i64, &resp_headers, response_time_ms)
                                .is_err()
                            {
                                agg.script_errors.fetch_add(1, Ordering::Relaxed);
                            }
                            env = eng.snapshot_env();
                        }
                    } else {
                        // Ainda precisa drenar o corpo pra devolver a conexão ao pool.
                        let _ = rt_handle.block_on(async { resp.bytes().await });
                    }
                }
                Err(_e) => {
                    agg.requests_failed.fetch_add(1, Ordering::Relaxed);
                    if let Ok(mut codes) = agg.status_codes.lock() {
                        *codes.entry("error".to_string()).or_insert(0) += 1;
                    }
                }
            }
        }

        local_iter += 1;
    }

    if ramp.is_none() {
        agg.vus_active.fetch_sub(1, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn start_load_test(
    app: AppHandle,
    ssl_state: State<'_, SslVerifyState>,
    registry: State<'_, LoadTestRegistry>,
    config: LoadTestConfig,
) -> Result<String, String> {
    if config.flow.is_empty() {
        return Err("Add at least one request to the flow.".to_string());
    }
    if config.flow.len() > MAX_FLOW_STEPS {
        return Err(format!("Flow limited to {} requests.", MAX_FLOW_STEPS));
    }
    for step in &config.flow {
        if step.url.trim().is_empty() {
            return Err("Every request in the flow needs a URL.".to_string());
        }
    }

    let stages = config.stages.clone().unwrap_or_default();
    let has_stages = !stages.is_empty();

    if has_stages {
        validate_stages(&stages)?;
    } else {
        let vus = config
            .vus
            .ok_or_else(|| "The number of virtual users (VUs) must be greater than zero.".to_string())?;
        if vus == 0 {
            return Err("The number of virtual users (VUs) must be greater than zero.".to_string());
        }
        if vus > MAX_VUS {
            return Err(format!("VUs limited to {} for this load test engine.", MAX_VUS));
        }
        if config.duration_secs.is_none() && config.iterations_per_vu.is_none() {
            return Err("Set either a duration or an iteration count per VU.".to_string());
        }
        if let Some(d) = config.duration_secs {
            if d > MAX_DURATION_SECS {
                return Err(format!("Duration limited to {} seconds.", MAX_DURATION_SECS));
            }
        }
        if let Some(i) = config.iterations_per_vu {
            if i > MAX_ITERATIONS_PER_VU {
                return Err(format!("Iterations per VU limited to {}.", MAX_ITERATIONS_PER_VU));
            }
        }
    }

    let thresholds = config.thresholds.clone().unwrap_or_default();
    validate_thresholds(&thresholds)?;

    let verify_ssl = ssl_state.0.load(Ordering::Relaxed);
    let timeout_secs = config.timeout_secs.unwrap_or(DEFAULT_TIMEOUT_SECS);
    let client = reqwest::Client::builder()
        .danger_accept_invalid_certs(!verify_ssl)
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;

    let rt_handle = tokio::runtime::Handle::current();

    let test_id = format!(
        "lt_{}_{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos(),
        LOAD_TEST_COUNTER.fetch_add(1, Ordering::Relaxed)
    );

    let stop_flag = Arc::new(AtomicBool::new(false));
    {
        let mut reg = registry
            .0
            .lock()
            .map_err(|_| "Failed to access the load test registry.".to_string())?;
        reg.insert(test_id.clone(), Arc::clone(&stop_flag));
    }

    let agg = Arc::new(Aggregator::new());
    let started_at = Instant::now();
    let base_env = config.environment.clone();

    let vu_handles = if has_stages {
        spawn_ramping_vus(
            Arc::clone(&agg),
            Arc::clone(&stop_flag),
            client,
            rt_handle,
            config.flow.clone(),
            base_env,
            stages,
            started_at,
        )
    } else {
        let deadline = config.duration_secs.map(|s| started_at + Duration::from_secs(s));
        spawn_constant_vus(
            Arc::clone(&agg),
            Arc::clone(&stop_flag),
            client,
            rt_handle,
            config.flow.clone(),
            base_env,
            config.vus.unwrap_or(0),
            deadline,
            config.iterations_per_vu,
        )
    };

    spawn_monitor(app, agg, test_id.clone(), started_at, thresholds, vu_handles);

    Ok(test_id)
}

#[tauri::command]
pub fn stop_load_test(registry: State<'_, LoadTestRegistry>, test_id: String) -> Result<(), String> {
    let reg = registry
        .0
        .lock()
        .map_err(|_| "Failed to access the load test registry.".to_string())?;

    match reg.get(&test_id) {
        Some(flag) => {
            flag.store(true, Ordering::Relaxed);
            Ok(())
        }
        None => Err("Load test not found (already finished?).".to_string()),
    }
}
