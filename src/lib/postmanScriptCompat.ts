// Ajusta scripts escritos no DevFlow pra rodarem no Postman, na hora do
// export. Só mexe no que tem uma tradução segura e que funciona nos DOIS
// apps (o export pode voltar a ser importado aqui):
//
// 1. `moment` sem require: no DevFlow ele é global, no Postman não existe
//    sem `require('moment')` — o script quebra com "moment is not defined".
// 2. `pm.request.body = x;`: o DevFlow aceita atribuir o body inteiro; no
//    Postman isso troca o objeto RequestBody por uma string e a request sai
//    errada. Vira `pm.request.body.update(x);`, que os dois entendem.
//
// O que não tem tradução segura fica como está (ex. pm.variables/globals,
// que aqui são o mesmo mapa do environment e lá são escopos separados).

export interface ScriptCompatResult {
  code: string
  /** O que foi alterado, em linguagem de gente — vazio se nada mudou. */
  changes: string[]
}

const MOMENT_USE = /(^|[^.\w$])moment\s*[(.]/m
const MOMENT_REQUIRED = /require\s*\(\s*['"]moment['"]\s*\)/
const MOMENT_DECLARED = /\b(?:var|let|const|function)\s+moment\b/
const BODY_ASSIGN = /^(\s*)pm\.request\.body\s*=(?!=)\s*(.+?)\s*;?\s*$/

/** true se parênteses/colchetes/chaves da expressão fecham na mesma linha. */
function isBalanced(expr: string): boolean {
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch
    else if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch) && --depth < 0) return false
  }
  return depth === 0 && quote === null
}

export function toPostmanScript(code: string): ScriptCompatResult {
  const changes: string[] = []
  const eol = code.includes('\r\n') ? '\r\n' : '\n'
  let lines = code.split(/\r?\n/)

  let bodyRewrites = 0
  lines = lines.map((line) => {
    const m = BODY_ASSIGN.exec(line)
    if (!m) return line
    const expr = m[2]
    // Objeto literal ({ raw: ... }) e expressão que continua na linha de
    // baixo ficam de fora: a tradução deixaria de ser óbvia.
    if (expr.startsWith('{') || /[+\-*/,?:&|=]$/.test(expr) || !isBalanced(expr)) return line
    bodyRewrites++
    return `${m[1]}pm.request.body.update(${expr});`
  })
  if (bodyRewrites > 0) {
    changes.push(`"pm.request.body = …" → "pm.request.body.update(…)" (${bodyRewrites}x)`)
  }

  let result = lines.join(eol)
  if (MOMENT_USE.test(result) && !MOMENT_REQUIRED.test(result) && !MOMENT_DECLARED.test(result)) {
    result = `const moment = require('moment');${eol}${result}`
    changes.push(`added "const moment = require('moment');"`)
  }

  return { code: result, changes }
}
