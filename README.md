# DevFlow

Um cliente de API de desktop, local-first, construído com Tauri e Next.js.

Faz o que se espera de um cliente de API — collections, environments, scripts
de pré e pós-requisição, runner — e três coisas que os outros não fazem:

- **Um agente de IA embutido.** O painel do Claude Code roda dentro do app e
  enxerga as suas collections através de um servidor MCP local: dá pra pedir
  "roda essa request e me diz por que deu 401" sem copiar nada pra lugar
  nenhum.
- **Teste de carga nativo.** O motor é em Rust, não um script; roda VUs,
  duração ou iterações, e guarda o histórico.
- **Sync por GitHub.** As collections vivem num repositório seu, criptografadas
  com uma senha que só você tem. Sem conta, sem nuvem de terceiro.

> **Status:** em desenvolvimento ativo. Hoje só há build empacotado para
> Windows; macOS e Linux compilam, mas ainda não foram validados em uso real.

## Capturas de tela

<!-- TODO: adicionar prints. Sugestão de três, nessa ordem:
     1. A janela principal com uma collection aberta e uma resposta
     2. O painel do Claude ao lado de uma request
     3. O painel de teste de carga com o gráfico -->

## Instalação

Baixe o instalador mais recente em [Releases](../../releases).

Como o executável ainda não é assinado, o Windows mostra um aviso do
SmartScreen e o macOS pede confirmação no Gatekeeper na primeira abertura.

## Rodando a partir do código

Pré-requisitos: [Node 20+](https://nodejs.org) e o
[toolchain do Rust](https://www.rust-lang.org/tools/install), mais as
[dependências de sistema do Tauri](https://tauri.app/start/prerequisites/)
(no Linux: `libwebkit2gtk-4.1-dev`, `libgtk-3-dev` e companhia).

```bash
npm ci
npx tauri dev
```

Para gerar o instalador da sua plataforma:

```bash
npx tauri build
```

## Como funciona

O frontend é Next.js em modo de exportação estática, servido dentro da webview
do Tauri. O Rust cuida do que o navegador não pode fazer: requisições HTTP sem
CORS, o motor de teste de carga, o sandbox de scripts (QuickJS), o
armazenamento seguro de credenciais e o servidor MCP local.

A execução de uma request passa por um caminho só — resolução de variáveis,
path params, auth, sanitização do body e scripts — usado igualmente pelo botão
Send, pelo runner, pelo teste de carga e pelas ferramentas do MCP. É o que
mantém os quatro coerentes entre si.

## Documentação

- [Usando o Claude com o DevFlow](docs/CLAUDE_AGENT.md) — o painel dentro do app
  e o Claude Code no terminal, via servidor MCP.
- [Teste de carga](docs/LOAD_TESTING.md) — modos de execução, correlação entre
  requests e thresholds.

## Contribuindo

Veja [CONTRIBUTING.md](CONTRIBUTING.md).

## Licença

Veja [LICENSE](LICENSE).
