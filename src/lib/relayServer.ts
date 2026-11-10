'use client'

import { invoke } from '@tauri-apps/api/core'

// ─────────────────────────────────────────────────────────────────────────
// Relay do "HTML runner" (src-tauri/src/relay_server.rs): o HTML de um flow
// manda as requisições pro DevFlow, que as envia com o próprio cliente HTTP
// — sem bloqueio de certificado interno nem de CORS.
//
// Desligado por padrão. Ligado, sobe junto com o app (ensureRelayStarted no
// AppLayout). A chave é gerada aqui e só existe nesta máquina; o HTML
// recebe o "código de conexão" (porta + chave) colado uma vez.
// ─────────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'devflow_relay'
const DEFAULT_PORT = 47821

export interface RelaySettings {
  enabled: boolean
  port: number
  key: string
}

export interface RelayStatus {
  running: boolean
  /** A porta em uso de verdade (pode ser outra se a pedida estava ocupada). */
  port: number | null
  error: string | null
}

function newKey(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')
}

export function loadRelaySettings(): RelaySettings {
  let parsed: Partial<RelaySettings> = {}
  try {
    parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Partial<RelaySettings>
  } catch {
    parsed = {}
  }
  const settings: RelaySettings = {
    enabled: parsed.enabled === true,
    port: typeof parsed.port === 'number' && parsed.port > 0 ? parsed.port : DEFAULT_PORT,
    key: typeof parsed.key === 'string' && parsed.key.length >= 32 ? parsed.key : newKey(),
  }
  // Chave gerada agora fica gravada já: senão cada leitura inventaria outra,
  // e o código mostrado na tela não bateria com o do relay ligado.
  if (settings.key !== parsed.key) saveRelaySettings(settings)
  return settings
}

function saveRelaySettings(settings: RelaySettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* sem storage: vale até fechar o app */
  }
}

/** O que a pessoa cola no HTML: endereço e chave num texto só. */
export function connectionCode(port: number, key: string): string {
  return `devflow-relay://127.0.0.1:${port}/${key}`
}

let status: RelayStatus = { running: false, port: null, error: null }
const listeners = new Set<(s: RelayStatus) => void>()

function setStatus(next: RelayStatus) {
  status = next
  listeners.forEach(fn => fn(status))
}

export function getRelayStatus(): RelayStatus {
  return status
}

export function subscribeRelayStatus(fn: (s: RelayStatus) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

async function start(settings: RelaySettings): Promise<void> {
  try {
    const port = await invoke<number>('start_relay_server', { port: settings.port, key: settings.key })
    setStatus({ running: true, port, error: null })
  } catch (e) {
    setStatus({ running: false, port: null, error: String(e) })
  }
}

/** Na abertura do app: liga o relay se ele ficou ligado. */
export async function ensureRelayStarted(): Promise<void> {
  const settings = loadRelaySettings()
  if (settings.enabled && !status.running) await start(settings)
}

export async function setRelayEnabled(enabled: boolean): Promise<void> {
  const settings = { ...loadRelaySettings(), enabled }
  saveRelaySettings(settings)
  if (enabled) {
    await start(settings)
  } else {
    await invoke('stop_relay_server').catch(() => undefined)
    setStatus({ running: false, port: null, error: null })
  }
}

/** Chave nova: invalida o código colado em qualquer HTML. */
export async function regenerateRelayKey(): Promise<RelaySettings> {
  const settings = { ...loadRelaySettings(), key: newKey() }
  saveRelaySettings(settings)
  if (settings.enabled) await start(settings)
  return settings
}
