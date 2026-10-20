import type { NextConfig } from 'next'

// canvg (dependência opcional do jspdf, só usada pra SVG-em-PDF, recurso que
// não usamos) puxa "core-js", que nesse ambiente tem vindo corrompido do
// registry/cache do npm de forma consistente. Aliasa pra um stub local sem
// dependências pra tirar o core-js do grafo de módulos por completo — ver
// src/stubs/canvg-stub.ts.
const nextConfig: NextConfig = {
  // Sem isso, "next build" gera só o build de servidor (.next/) e NÃO
  // regenera a pasta "out/" que o tauri.conf.json espera (frontendDist).
  // Resultado: o "tauri build" ficava sempre empacotando uma "out/" antiga
  // (de qualquer build anterior), então o .exe rodava um snapshot congelado
  // do app, diferente do que aparece no "tauri dev" (que serve direto do
  // servidor Next em modo dev, sempre atual).
  output: 'export',
  turbopack: {
    // Raiz fixa no projeto: há um package.json/package-lock.json solto na
    // pasta do usuário (C:\Users\...), e sem isso o Turbopack "adivinhava"
    // aquela pasta como raiz do workspace (aviso de multiple lockfiles).
    root: __dirname,
    resolveAlias: {
      canvg: './src/stubs/canvg-stub.ts',
    },
  },
}

export default nextConfig
