# Contribuindo com o DevFlow

## Ambiente

```bash
npm ci
npx tauri dev
```

Precisa de Node 20+, do toolchain do Rust e das
[dependências de sistema do Tauri](https://tauri.app/start/prerequisites/).

## O que o CI exige

Um PR precisa passar em três portões, os mesmos que você pode rodar localmente:

```bash
npx tsc --noEmit -p tsconfig.json     # tipos
npx eslint src --ext .ts,.tsx         # lint
npm test                              # testes (vitest)
cd src-tauri && cargo check           # Rust
```

Durante o desenvolvimento, `npm run test:watch` reexecuta só o que você mexeu.

O `cargo check` roda em **Linux e Windows** no CI. Isso não é zelo: há blocos
`#[cfg(windows)]` e `#[cfg(not(windows))]` no código, e o compilador só enxerga
o ramo da plataforma onde está rodando. Se você mexer em algo condicional,
espere o resultado das duas.

### Sobre o lint

O projeto tem hoje ~290 **avisos** herdados (tipagem `any`, regras do React
Compiler). Eles são tolerados de propósito: tratá-los como erro deixaria a
build permanentemente vermelha, e um CI que está sempre vermelho não informa
nada.

O combinado é simples: **não aumente a conta**. Código novo não deveria
introduzir avisos, e reduzir os existentes quando você passar por perto é bem-vindo.

As regras que continuam sendo **erro** estão listadas com a justificativa no
[eslint.config.mjs](eslint.config.mjs) — todas pegam defeito de verdade, não
questão de estilo.

## Estilo de código

**Comentários explicam o porquê, não o quê.** O código já diz o que faz. O que
se perde com o tempo é a razão: a restrição que levou àquela escolha, o bug que
motivou aquela guarda, o caminho que foi tentado e não funcionou. O projeto é
escrito assim, e é o que permite mexer num arquivo seis meses depois.

**Não deixe código comentado.** O histórico do git guarda a versão anterior.
Este repositório já carregou ~4400 linhas de código morto comentado, e elas
foram removidas justamente porque tornavam os arquivos ilegíveis.

**Teste o que é lógica pura.** Módulos sem dependência de UI ou de Tauri são
onde moram as decisões sutis, e são testáveis sem subir o app. Os que já têm
suíte (`*.test.ts` ao lado do módulo):

| Módulo | O que o teste protege |
|---|---|
| `src/lib/syncCrypto.ts` | que conteúdo já sincronizado continua legível após a troca de chave |
| `src/lib/codeSnippets.ts` | o escape de cada linguagem — o cURL é validado desfazendo o quoting do shell |
| `src/lib/openapiParser.ts` | `$ref`, schema recursivo, `allOf`, e as duas versões da especificação |
| `src/components/collection-tree/utils/tree.utils.ts` | mover, recusar ciclo, projetar o nível do drop e o par favoritar/desfavoritar |
| `src/lib/junitReport.ts` | que o XML do relatório é bem formado mesmo com `<`, `&` ou byte de controle vindo da resposta |
| `src/components/CollectionRunner/runHistory.ts` | que um run grande é degradado até caber na cota do localStorage, em vez de estourá-la e derrubar as gravações de outras features |
| `src/mcp/duplicateRequest.ts` | que a cópia leva o segredo que a leitura mascara, e que nenhum id é reaproveitado entre original e cópia |
| `src/lib/envMap.ts` | qual entrada vence quando a mesma key está habilitada duas vezes — leitura e escrita precisam escolher a mesma |
| `src/components/CollectionRunner/runVerdict.ts` | que a asserção decide o veredito — um 400 esperado passa, e um erro de rede não é encoberto por teste que passou |
| `src/storage/pendingPushStore.ts` | que o formato antigo (lista de workspaces) migra sem perder o aviso de pendência |
| `src/lib/collectionFingerprint.ts` | que só a collection realmente tocada é marcada, e que favoritar não marca sozinho |
| `src/lib/remoteComparison.ts` | separar "mudou no GitHub" de "só existe lá" e de "só existe aqui", com a mesma regra de impressão do push |
| `src/lib/collectionDiff.ts` | casar nós por id com nome como alternativa, e manter a alteração no nó que mudou em vez de propagar pros ancestrais |
| `src/lib/canonicalCompare.ts` | o que conta como mesma coisa ao comparar com o GitHub — e, tão importante, o que continua sendo diferença |
| `src/lib/syncBase.ts` | separar quem mexeu numa comparação de três vias, e que a pasta não muda quando um filho muda |
| `src/lib/diffSelection.ts` | quais escolhas descartam trabalho local não enviado, e por que o conflitante começa desmarcado |
| `src/lib/applyDiff.ts` | mesclar só o que foi escolhido: posição de item novo, id e favorito preservados, e recusar a pasta sem descartar o que foi aceito dentro |
| `src/lib/environmentDiff.ts` | casar variável por key (o pull regenera os ids) e preservar a duplicata desabilitada ao aplicar |
| `src/lib/diffFields.ts` | onde cada campo editável mora no nó, e que JSON inválido vira erro em vez de entrar na request |
| `src/lib/variableHistory.ts` | que valor em branco não entra no histórico, e que conteúdo fora de formato no localStorage não derruba a leitura |
| `src/lib/avatarImage.ts` | o recorte quadrado centralizado e a recusa de arquivo que não é imagem, antes de decodificar |
| `src/lib/avatarPresets.ts` | que cada avatar gera SVG bem formado, com contraste suficiente, e que a geração é determinística (a seleção depende disso) |
| `src/lib/tabGroups.ts` | a contiguidade das abas de um grupo — agrupar abas distantes sem engolir o que está no meio, e o que acontece ao arrastar |
| `src/lib/dragWindow.ts` | que arrastar um modal nunca o leva pra fora da tela, de onde não haveria como trazê-lo de volta |

Ao mexer num desses, rode `npm test` antes de abrir o PR — eles são rápidos
(menos de 2s no total).

## Áreas sensíveis

**`src/lib/syncCrypto.ts`** — criptografia do que vai pro GitHub. O formato é
versionado (`DFv2:`), e a chave antiga continua ali **só para leitura**: removê-la
tornaria ilegível tudo que já foi sincronizado por versões anteriores.

**Chaves de armazenamento** (`localStorage`, store do Tauri, keyring) são
contrato com dados já gravados na máquina de quem usa. Renomear uma sem
migração não renomeia o que está no disco — só faz a leitura voltar vazia.

**O caminho de execução de request** é compartilhado entre Send, runner, teste
de carga e ferramentas do MCP. Mudança ali afeta os quatro.
