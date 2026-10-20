import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Biblioteca de terceiro copiada pro repositório: não é código nosso e
    // não deve pautar o CI.
    "src/utils/moment.min.js",
  ]),

  {
    // ── Severidades ────────────────────────────────────────────────────────
    // O CI falha com erro e tolera aviso. Para isso valer alguma coisa, erro
    // precisa significar "isto está quebrado", não "isto poderia ser melhor".
    //
    // Estas regras foram rebaixadas depois de medir: elas respondiam por 217
    // dos 234 erros do projeto. Mantê-las como erro não protegia nada —
    // tornava o sinal todo inútil, porque ninguém consegue abrir um PR com a
    // build vermelha por 166 `any` herdados. Continuam visíveis como aviso, e
    // a ideia é ir baixando o número com o tempo.
    rules: {
      // Dívida de tipagem herdada, espalhada por arquivos grandes. Não é
      // defeito de runtime.
      "@typescript-eslint/no-explicit-any": "warn",

      // Regras do React Compiler. Valem como recomendação, mas o projeto não
      // usa o compilador, e a maioria dos casos aqui é o padrão legítimo de
      // "ler storage/SO na montagem e refletir no estado" — que não tem outra
      // forma num app Tauri sem SSR.
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/purity": "warn",
      "react-hooks/preserve-manual-memoization": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/use-memo": "warn",

      // Estas continuam ERRO de propósito: pegam defeito de verdade.
      //   react-hooks/rules-of-hooks  -> hook condicional quebra em runtime
      //   react/no-unescaped-entities -> aspas cruas quebram a renderização
      //   @typescript-eslint/no-this-alias
      //   @typescript-eslint/ban-ts-comment
      //   @typescript-eslint/no-unsafe-function-type
    },
  },
]);

export default eslintConfig;
