// ─────────────────────────────────────────────────────────────────────────────
// Decisão de atualização (opcional x obrigatória) a partir da aba "Releases"
// da planilha do Apps Script (ver google-apps-script/Code.gs).
//
// Cada linha da aba é uma versão publicada:
//
//   version | mandatory | notes                      | date       | url
//   1.4.5   | FALSE     | Correções no runner        | 2026-11-01 |
//   1.5.0   | TRUE      | Corrige falha de segurança | 2026-11-10 | https://...
//
// Regra: olha todas as versões ACIMA da instalada. A mais nova é o alvo. Se
// QUALQUER uma delas (entre a instalada, exclusive, e a mais nova, inclusive)
// for obrigatória, a atualização é obrigatória — pular de 1.4.4 para 1.6.0
// passando por cima de uma 1.5.0 obrigatória continua obrigatório, porque
// a 1.6.0 contém a correção da 1.5.0 que a pessoa ainda não tem.
//
// Tudo aqui é puro (sem Tauri, sem DOM, sem localStorage) pra poder ser
// testado no vitest.
// ─────────────────────────────────────────────────────────────────────────────

export interface ReleaseEntry {
  version: string
  mandatory: boolean
  notes?: string
  date?: string
  url?: string
}

export interface PendingUpdate {
  /** Versão mais nova publicada (o alvo da atualização). */
  latest: ReleaseEntry
  /** Todas as versões acima da instalada, da mais nova para a mais antiga. */
  pending: ReleaseEntry[]
  /** As versões de `pending` marcadas como obrigatórias. */
  mandatoryVersions: string[]
  /** Link de download: o da linha mais nova, ou o `updateUrl` global. */
  url?: string
}

export type UpdateDecision =
  | { kind: 'none' }
  | ({ kind: 'optional' } & PendingUpdate)
  | ({ kind: 'mandatory' } & PendingUpdate)

// Compara versões no formato "1.2.10" — puramente numérico por segmento (sem
// suporte a pre-release tags tipo "-beta"; suficiente pro caso de uso aqui).
// Retorna >0 se a > b, <0 se a < b, 0 se iguais/inválidas.
export function compareVersions(a: string, b: string): number {
  const pa = String(a ?? '').trim().split('.').map(n => parseInt(n, 10) || 0)
  const pb = String(b ?? '').trim().split('.').map(n => parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

// "v1.5.0" e " 1.5.0 " viram "1.5.0"; qualquer coisa que não seja só
// números separados por ponto (célula vazia, "a definir", uma data que o
// Sheets converteu sozinho) é descartada em vez de virar "0.0.0".
const VERSION_RE = /^\d+(\.\d+)*$/

export function normalizeVersion(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  // Aspas soltas também saem: o apóstrofo que força texto no Sheets às
  // vezes é digitado no fim ("1.1.7'") em vez do começo e vai junto no valor.
  const v = String(value).trim().replace(/^['"‘’]+|['"‘’]+$/g, '').trim().replace(/^v/i, '')
  return VERSION_RE.test(v) ? v : null
}

// A coluna "obrigatória" pode ser uma caixa de seleção (TRUE/FALSE) ou texto
// digitado à mão ("Sim", "não", "x"...). Tudo que não for claramente "sim"
// conta como opcional — na dúvida, não trava ninguém.
const TRUTHY = new Set(['true', 'sim', 's', 'yes', 'y', '1', 'x', 'obrigatoria', 'obrigatória'])

export function parseMandatory(value: unknown): boolean {
  if (value === true || value === 1) return true
  if (typeof value !== 'string') return false
  return TRUTHY.has(value.trim().toLowerCase())
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const s = String(value).trim()
  return s ? s : undefined
}

// Normaliza o array `releases` vindo do JSON do Apps Script. Linhas
// inválidas são ignoradas uma a uma (uma linha ruim não derruba as outras).
export function parseReleases(value: unknown): ReleaseEntry[] {
  if (!Array.isArray(value)) return []
  const out: ReleaseEntry[] = []
  for (const row of value) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const version = normalizeVersion(r.version)
    if (!version) continue
    out.push({
      version,
      mandatory: parseMandatory(r.mandatory),
      notes: optionalString(r.notes),
      date: optionalString(r.date),
      url: optionalString(r.url),
    })
  }
  return out
}

export function decideUpdate(
  currentVersion: string,
  releases: ReleaseEntry[],
  fallbackUrl?: string,
): UpdateDecision {
  const current = normalizeVersion(currentVersion)
  if (!current) return { kind: 'none' }

  // Mesma versão em duas linhas: junta, e basta uma delas ser obrigatória.
  const byVersion = new Map<string, ReleaseEntry>()
  for (const r of releases) {
    const version = normalizeVersion(r.version)
    if (!version || compareVersions(version, current) <= 0) continue
    const key = [...byVersion.keys()].find(k => compareVersions(k, version) === 0)
    if (key) {
      const prev = byVersion.get(key)!
      byVersion.set(key, {
        ...prev,
        mandatory: prev.mandatory || r.mandatory,
        notes: prev.notes ?? r.notes,
        date: prev.date ?? r.date,
        url: prev.url ?? r.url,
      })
    } else {
      byVersion.set(version, { ...r, version })
    }
  }

  const pending = [...byVersion.values()].sort((a, b) => compareVersions(b.version, a.version))
  if (pending.length === 0) return { kind: 'none' }

  const latest = pending[0]
  const mandatoryVersions = pending.filter(r => r.mandatory).map(r => r.version)
  const update: PendingUpdate = {
    latest,
    pending,
    mandatoryVersions,
    url: latest.url ?? optionalString(fallbackUrl),
  }
  return mandatoryVersions.length > 0
    ? { kind: 'mandatory', ...update }
    : { kind: 'optional', ...update }
}

// Planilha antiga, sem a aba "Releases": o `latestVersion` de sempre vira uma
// única versão opcional — o aviso continua igual ao de antes.
export function releasesWithLegacyFallback(
  releases: ReleaseEntry[],
  latestVersion?: string,
  updateMessage?: string,
): ReleaseEntry[] {
  if (releases.length > 0) return releases
  const version = normalizeVersion(latestVersion)
  return version ? [{ version, mandatory: false, notes: optionalString(updateMessage) }] : []
}

// ── Aviso opcional: dispensar / lembrar depois ──────────────────────────────

/** "Lembrar depois" adia o aviso por este tempo. */
export const OPTIONAL_SNOOZE_MS = 24 * 60 * 60 * 1000

export interface OptionalNoticeState {
  /** Versão que a pessoa dispensou ("não avisar desta versão de novo"). */
  dismissedVersion?: string | null
  /** Timestamp (ms) até quando o aviso está adiado. */
  snoozedUntil?: number | null
}

// Mostra o aviso opcional? Dispensar vale só para aquela versão: quando sai
// uma mais nova, o aviso volta. Adiar vale por um tempo, qualquer versão.
export function shouldShowOptionalNotice(
  latestVersion: string,
  state: OptionalNoticeState,
  now: number,
): boolean {
  if (state.snoozedUntil && Number.isFinite(state.snoozedUntil) && now < state.snoozedUntil) return false
  const dismissed = normalizeVersion(state.dismissedVersion ?? '')
  if (dismissed && compareVersions(latestVersion, dismissed) <= 0) return false
  return true
}
