// "Save as example" no painel de resposta: além de guardar a resposta, o
// example ganha no Post-response testes que dizem que AQUELE é o
// comportamento esperado — o status que veio e, se o body é JSON, o formato
// dele (os campos do topo, ou que é uma lista). Assim o "Try" do example
// já valida se a API continua respondendo do mesmo jeito.
//
// Só a estrutura, nunca os valores: ids, datas e tokens mudam a cada chamada,
// e um teste que compara o body inteiro falharia sempre.

/** Quantos campos do topo viram assert, no máximo. */
const MAX_FIELDS = 30

const MARKER = '// Expected behavior'

function jsonOf(body: unknown): unknown {
  if (typeof body !== 'string') return body
  const text = body.trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** Os pm.test(...) do comportamento esperado para uma resposta. */
export function expectedBehaviorTests(
  status: number,
  body: unknown,
  isBinary = false
): string {
  const tests = [
    `pm.test(${JSON.stringify(`Status code is ${status}`)}, function () {\n    pm.response.to.have.status(${status});\n});`,
  ]

  const json = isBinary ? undefined : jsonOf(body)
  if (Array.isArray(json)) {
    tests.push(
      'pm.test("Response is a list", function () {\n    pm.expect(pm.response.json()).to.be.an("array");\n});'
    )
  } else if (json && typeof json === 'object') {
    const keys = Object.keys(json).slice(0, MAX_FIELDS)
    if (keys.length > 0) {
      const lines = keys.map(k => `    pm.expect(jsonData).to.have.property(${JSON.stringify(k)});`)
      tests.push(
        `pm.test("Response has the expected fields", function () {\n    const jsonData = pm.response.json();\n${lines.join('\n')}\n});`
      )
    }
  }

  return `${MARKER} (saved with this example)\n${tests.join('\n\n')}`
}

/**
 * Junta os testes ao Post-response que a request já tinha. Um script que já
 * traz o bloco (o example foi salvo de uma request que já tinha um) não
 * ganha outro.
 */
export function withExpectedBehavior(script: string | undefined, tests: string): string {
  const current = (script ?? '').trimEnd()
  if (current.includes(MARKER)) return current
  return current ? `${current}\n\n${tests}` : tests
}
