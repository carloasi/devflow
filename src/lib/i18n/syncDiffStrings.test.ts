import { describe, expect, it } from 'vitest'
import { syncDiffStrings } from './syncDiffStrings'

describe('syncDiffStrings', () => {
  it('has a Portuguese text for every English key', () => {
    const en = syncDiffStrings('en')
    const pt = syncDiffStrings('pt-BR')
    expect(Object.keys(pt).sort()).toEqual(Object.keys(en).sort())
    expect(Object.keys(pt.status).sort()).toEqual(Object.keys(en.status).sort())
  })

  it('translates the review screen', () => {
    const pt = syncDiffStrings('pt-BR')
    expect(pt.titlePush).toBe('Antes do push: revise as mudanças no GitHub')
    expect(pt.mergePush(42)).toBe('Mesclar e enviar (42)')
    expect(pt.status.changedBoth.label).toBe('Alterado dos dois lados')
  })

  it('keeps the English labels the status classifier uses', () => {
    expect(syncDiffStrings('en').status.changedHere.label).toBe('Changed here')
  })
})
