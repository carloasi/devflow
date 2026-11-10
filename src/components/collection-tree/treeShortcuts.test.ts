import { describe, expect, it } from 'vitest'
import { shortcutFor, shortcutLabel } from './treeShortcuts'

const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => ({
  key: k,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
})

describe('shortcutFor', () => {
  it('maps plain letters, shift and Ctrl/⌘ combos', () => {
    expect(shortcutFor(key('m'))).toBe('markers')
    expect(shortcutFor(key('M', { shiftKey: true }))).toBe('description')
    expect(shortcutFor(key('n'))).toBe('addRequest')
    expect(shortcutFor(key('N', { shiftKey: true }))).toBe('addFolder')
    expect(shortcutFor(key('d', { ctrlKey: true }))).toBe('duplicate')
    expect(shortcutFor(key('d', { metaKey: true }))).toBe('duplicate')
    expect(shortcutFor(key('F2'))).toBe('rename')
    expect(shortcutFor(key('F10', { shiftKey: true }))).toBe('menu')
    expect(shortcutFor(key('ContextMenu'))).toBe('menu')
  })

  it('ignores combos that are not in the table', () => {
    expect(shortcutFor(key('d'))).toBeNull()
    expect(shortcutFor(key('m', { ctrlKey: true }))).toBeNull()
    expect(shortcutFor(key('f', { altKey: true }))).toBeNull()
    expect(shortcutFor(key('x'))).toBeNull()
  })
})

describe('shortcutLabel', () => {
  it('uses the platform notation', () => {
    expect(shortcutLabel('duplicate', false)).toBe('Ctrl+D')
    expect(shortcutLabel('duplicate', true)).toBe('⌘D')
    expect(shortcutLabel('addFolder', false)).toBe('Shift+N')
    expect(shortcutLabel('addFolder', true)).toBe('⇧N')
    expect(shortcutLabel('delete', false)).toBe('Del')
    expect(shortcutLabel('rename', true)).toBe('F2')
  })
})
