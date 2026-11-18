import { describe, expect, it } from 'vitest'
import { expectedBehaviorTests, withExpectedBehavior } from './exampleExpectations'

describe('expectedBehaviorTests', () => {
  it('asserts the status and the top-level fields of a JSON object', () => {
    const code = expectedBehaviorTests(201, { id: 'x', "na\"me": 1 })
    expect(code).toContain('pm.response.to.have.status(201);')
    expect(code).toContain('pm.test("Status code is 201"')
    expect(code).toContain('pm.expect(jsonData).to.have.property("id");')
    expect(code).toContain('pm.expect(jsonData).to.have.property("na\\"me");')
    // Valores ficam de fora: mudam a cada chamada.
    expect(code).not.toContain("'x'")
  })

  it('parses a JSON string body', () => {
    expect(expectedBehaviorTests(400, '{"errors": []}')).toContain('to.have.property("errors")')
  })

  it('asserts a list for an array body', () => {
    const code = expectedBehaviorTests(200, [{ a: 1 }])
    expect(code).toContain('to.be.an("array")')
    expect(code).not.toContain('have.property')
  })

  it('only checks the status for text, binary, empty or empty-object bodies', () => {
    for (const [body, binary] of [['plain text', false], ['{"a":1}', true], ['', false], [null, false], [{}, false]] as const) {
      const code = expectedBehaviorTests(204, body, binary)
      expect(code).toContain('have.status(204)')
      expect(code.match(/pm\.test\(/g)).toHaveLength(1)
    }
  })

  it('produces a script that runs and passes against the same response', () => {
    const body = { id: 1, items: [] }
    const results: Record<string, boolean> = {}
    const pm = {
      test(name: string, fn: () => void) {
        try { fn(); results[name] = true } catch { results[name] = false }
      },
      response: {
        json: () => body,
        to: { have: { status: (s: number) => { if (s !== 200) throw new Error('status') } } },
      },
      expect: (v: Record<string, unknown>) => ({
        to: { have: { property: (k: string) => { if (!(k in v)) throw new Error(k) } } },
      }),
    }
    new Function('pm', expectedBehaviorTests(200, body))(pm)
    expect(results).toEqual({ 'Status code is 200': true, 'Response has the expected fields': true })
  })
})

describe('withExpectedBehavior', () => {
  const tests = expectedBehaviorTests(200, {})

  it('appends after the existing script', () => {
    expect(withExpectedBehavior('console.log(1);\n\n', tests)).toBe(`console.log(1);\n\n${tests}`)
  })

  it('uses the tests alone when there is no script', () => {
    expect(withExpectedBehavior(undefined, tests)).toBe(tests)
    expect(withExpectedBehavior('  ', tests)).toBe(tests)
  })

  it('does not add a second block', () => {
    expect(withExpectedBehavior(tests, expectedBehaviorTests(404, {}))).toBe(tests)
  })
})
