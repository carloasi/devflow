import { describe, expect, it } from 'vitest'
import { toPostmanScript } from './postmanScriptCompat'

describe('toPostmanScript', () => {
  it('adds require for a global moment', () => {
    const { code, changes } = toPostmanScript("var d = moment().format('YYYY');")
    expect(code).toBe("const moment = require('moment');\nvar d = moment().format('YYYY');")
    expect(changes).toHaveLength(1)
  })

  it('leaves moment alone when already required or declared', () => {
    for (const src of [
      "const moment = require('moment');\nmoment();",
      'var m = require("moment"); m();',
      'function moment() {}\nmoment();',
    ]) {
      expect(toPostmanScript(src).code).toBe(src)
    }
  })

  it('ignores moment as a property or plain word', () => {
    const src = 'obj.moment(); // wait a moment'
    expect(toPostmanScript(src).changes).toEqual([])
  })

  it('rewrites a whole-body assignment to update()', () => {
    const { code } = toPostmanScript('if (x) {\n    pm.request.body = JSON.stringify(body, null, 2);\n}')
    expect(code).toBe('if (x) {\n    pm.request.body.update(JSON.stringify(body, null, 2));\n}')
  })

  it('keeps raw assignment, comparisons, object literals and multi-line expressions', () => {
    for (const src of [
      'pm.request.body.raw = novoRaw;',
      "pm.request.body == 'x';",
      'pm.request.body = { raw: novoRaw };',
      'pm.request.body = a +\n  b;',
      'pm.request.body = JSON.stringify(\n  body);',
    ]) {
      expect(toPostmanScript(src).code).toBe(src)
    }
  })

  it('preserves CRLF line endings', () => {
    const { code } = toPostmanScript('moment();\r\npm.request.body = s;')
    expect(code).toBe("const moment = require('moment');\r\nmoment();\r\npm.request.body.update(s);")
  })

  it('fixes the AirSearch pre-request script', () => {
    const src = [
      "var departureIda = moment().add(1, 'days').format('YYYY-MM-DD') + 'T00:00:00';",
      "var raw = typeof pm.request.body === 'string' ? pm.request.body : pm.request.body.raw;",
      "if (typeof pm.request.body === 'string') {",
      '    pm.request.body = novoRaw;',
      '} else {',
      '    pm.request.body.raw = novoRaw;',
      '}',
    ].join('\n')
    const lines = toPostmanScript(src).code.split('\n')
    expect(lines[0]).toBe("const moment = require('moment');")
    expect(lines[2]).toBe(src.split('\n')[1])
    expect(lines[4]).toBe('    pm.request.body.update(novoRaw);')
    expect(lines[6]).toBe('    pm.request.body.raw = novoRaw;')
  })
})
