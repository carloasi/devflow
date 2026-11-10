import { describe, expect, it } from 'vitest'
import {
  OPTIONAL_SNOOZE_MS,
  decideUpdate,
  normalizeVersion,
  parseMandatory,
  parseReleases,
  releasesWithLegacyFallback,
  shouldShowOptionalNotice,
  type ReleaseEntry,
} from './updateDecision'

const rel = (version: string, mandatory = false, extra: Partial<ReleaseEntry> = {}): ReleaseEntry => ({
  version,
  mandatory,
  ...extra,
})

describe('decideUpdate', () => {
  it('não faz nada quando não há versão acima da instalada', () => {
    expect(decideUpdate('1.4.4', [rel('1.4.3', true), rel('1.4.4', true)])).toEqual({ kind: 'none' })
    expect(decideUpdate('1.4.4', [])).toEqual({ kind: 'none' })
  })

  it('opcional quando nenhuma versão pendente é obrigatória', () => {
    const d = decideUpdate('1.4.4', [rel('1.4.5'), rel('1.5.0')])
    expect(d.kind).toBe('optional')
    if (d.kind === 'none') throw new Error()
    expect(d.latest.version).toBe('1.5.0')
    expect(d.pending.map(r => r.version)).toEqual(['1.5.0', '1.4.5'])
    expect(d.mandatoryVersions).toEqual([])
  })

  it('obrigatória quando a mais nova é obrigatória', () => {
    const d = decideUpdate('1.4.4', [rel('1.4.5'), rel('1.5.0', true)])
    expect(d.kind).toBe('mandatory')
  })

  it('obrigatória quando uma versão intermediária é obrigatória, mesmo a mais nova sendo opcional', () => {
    const d = decideUpdate('1.4.4', [rel('1.6.0'), rel('1.5.0', true), rel('1.4.5')])
    expect(d.kind).toBe('mandatory')
    if (d.kind === 'none') throw new Error()
    expect(d.latest.version).toBe('1.6.0')
    expect(d.mandatoryVersions).toEqual(['1.5.0'])
  })

  it('ignora obrigatórias que a pessoa já tem (versão igual ou abaixo da instalada)', () => {
    const d = decideUpdate('1.5.0', [rel('1.4.0', true), rel('1.5.0', true), rel('1.5.1')])
    expect(d.kind).toBe('optional')
  })

  it('compara numericamente, não como texto (1.10.0 > 1.9.0)', () => {
    const d = decideUpdate('1.9.0', [rel('1.10.0', true)])
    expect(d.kind).toBe('mandatory')
    expect(decideUpdate('1.10.0', [rel('1.9.0', true)])).toEqual({ kind: 'none' })
  })

  it('trata 1.5 e 1.5.0 como a mesma versão e junta as linhas duplicadas', () => {
    const d = decideUpdate('1.4.4', [rel('1.5', false, { notes: 'a' }), rel('1.5.0', true, { url: 'u' })])
    if (d.kind === 'none') throw new Error()
    expect(d.kind).toBe('mandatory')
    expect(d.pending).toHaveLength(1)
    expect(d.latest).toMatchObject({ notes: 'a', url: 'u', mandatory: true })
  })

  it('usa o link da versão mais nova e cai no updateUrl global sem ele', () => {
    const withUrl = decideUpdate('1.0.0', [rel('1.1.0', false, { url: 'https://a' })], 'https://global')
    const noUrl = decideUpdate('1.0.0', [rel('1.1.0')], 'https://global')
    const none = decideUpdate('1.0.0', [rel('1.1.0')])
    expect(withUrl.kind !== 'none' && withUrl.url).toBe('https://a')
    expect(noUrl.kind !== 'none' && noUrl.url).toBe('https://global')
    expect(none.kind !== 'none' && none.url).toBeUndefined()
  })

  it('versão instalada inválida não decide nada (fail-open)', () => {
    expect(decideUpdate('', [rel('9.9.9', true)])).toEqual({ kind: 'none' })
    expect(decideUpdate('dev', [rel('9.9.9', true)])).toEqual({ kind: 'none' })
  })
})

describe('parseReleases', () => {
  it('normaliza as linhas do JSON e descarta as inválidas', () => {
    const parsed = parseReleases([
      { version: 'v1.5.0', mandatory: 'Sim', notes: ' Correção ', date: '2026-11-10', url: '' },
      { version: '1.4.5', mandatory: false },
      { version: '', mandatory: true },
      { version: 'a definir', mandatory: true },
      { version: 'Tue Jan 01 2008', mandatory: true },
      null,
      'lixo',
      { mandatory: true },
    ])
    expect(parsed).toEqual([
      { version: '1.5.0', mandatory: true, notes: 'Correção', date: '2026-11-10', url: undefined },
      { version: '1.4.5', mandatory: false, notes: undefined, date: undefined, url: undefined },
    ])
  })

  it('devolve lista vazia para qualquer coisa que não seja array', () => {
    expect(parseReleases(undefined)).toEqual([])
    expect(parseReleases('1.5.0')).toEqual([])
    expect(parseReleases({ version: '1.5.0' })).toEqual([])
  })
})

describe('parseMandatory', () => {
  it.each([true, 1, 'TRUE', 'true', 'Sim', 'sim', 'S', 'yes', 'x', 'X', '1', 'Obrigatória'])('%s → obrigatória', v => {
    expect(parseMandatory(v)).toBe(true)
  })
  it.each([false, 0, 'FALSE', 'Não', 'nao', 'n', '', '  ', null, undefined, 'talvez'])('%s → opcional', v => {
    expect(parseMandatory(v)).toBe(false)
  })
})

describe('normalizeVersion', () => {
  it('aceita número puro vindo da planilha', () => {
    expect(normalizeVersion(2)).toBe('2')
    expect(normalizeVersion(' V1.2.3 ')).toBe('1.2.3')
    expect(normalizeVersion('1.2.3-beta')).toBeNull()
  })
})

describe('releasesWithLegacyFallback', () => {
  it('sem aba Releases, usa latestVersion como versão opcional', () => {
    expect(releasesWithLegacyFallback([], '1.5.0', 'novidades')).toEqual([
      { version: '1.5.0', mandatory: false, notes: 'novidades' },
    ])
    expect(releasesWithLegacyFallback([], undefined)).toEqual([])
  })

  it('com aba Releases preenchida, ignora latestVersion', () => {
    const releases = [rel('1.6.0', true)]
    expect(releasesWithLegacyFallback(releases, '9.9.9')).toBe(releases)
  })
})

describe('shouldShowOptionalNotice', () => {
  const now = 1_000_000_000_000

  it('mostra quando nada foi dispensado nem adiado', () => {
    expect(shouldShowOptionalNotice('1.5.0', {}, now)).toBe(true)
  })

  it('não mostra de novo a versão dispensada, mas volta para uma mais nova', () => {
    expect(shouldShowOptionalNotice('1.5.0', { dismissedVersion: '1.5.0' }, now)).toBe(false)
    expect(shouldShowOptionalNotice('1.5.1', { dismissedVersion: '1.5.0' }, now)).toBe(true)
  })

  it('"lembrar depois" esconde até o prazo vencer', () => {
    const snoozedUntil = now + OPTIONAL_SNOOZE_MS
    expect(shouldShowOptionalNotice('1.5.0', { snoozedUntil }, now)).toBe(false)
    expect(shouldShowOptionalNotice('1.5.0', { snoozedUntil }, snoozedUntil)).toBe(true)
  })

  it('valor lixo no armazenamento não esconde o aviso', () => {
    expect(shouldShowOptionalNotice('1.5.0', { dismissedVersion: 'undefined', snoozedUntil: NaN }, now)).toBe(true)
  })
})
