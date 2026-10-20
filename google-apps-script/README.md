# Bloqueio remoto / aviso de atualização (Google Sheets + Apps Script)

O app (`AppUpdateGate`, em `src/components/AppUpdateGate.tsx`) checa
periodicamente uma URL que devolve um JSON pequeno com o status do app. Essa
URL é um Web App do Google Apps Script publicado a partir de uma Google
Sheet — editar as células da planilha propaga pra todo mundo que está usando
o app, sem precisar rebuildar nada.

## Setup

1. Crie uma Google Sheet nova (planilha em branco).
2. Na primeira aba, preencha as colunas **A** (chave) e **B** (valor), uma
   linha por chave, **sem cabeçalho** (comece já na linha 1):

   | A               | B                                                             |
   |-----------------|----------------------------------------------------------------|
   | `latestVersion` | `1.1.5`                                                         |
   | `minVersion`    | *(vazio = sem versão mínima obrigatória)*                       |
   | `blocked`       | `FALSE`                                                         |
   | `blockMessage`  | *(mensagem mostrada na tela de bloqueio quando `blocked=TRUE`)*|
   | `updateUrl`     | `https://github.com/seu-usuario/devflow/releases/latest`   |
   | `updateMessage` | `Nova versão disponível com melhorias de load test!`            |
   | `blockedUsers`  | *(opcional — usuários do Windows separados por vírgula, ex: `CarlosSilva, joao.pereira`)* |
   | `blockedVersions` | *(opcional — versões exatas separadas por vírgula, ex: `1.1.4, 1.1.7-beta`)* |

   ⚠️ **Cuidado ao digitar versões tipo `1.1.2008`**: o Google Sheets às
   vezes interpreta números separados por ponto como DATA e converte a
   célula sozinho, quebrando a comparação de versão. Se isso acontecer:
   apague a célula, selecione a coluna B → **Formatar → Número → Texto
   simples**, e digite de novo (ou digite direto com apóstrofo na frente,
   ex: `'1.1.2008`, que força texto puro sem precisar mudar o formato da
   coluna).

3. **Extensões → Apps Script**, apague o conteúdo padrão e cole o conteúdo
   de [`Code.gs`](./Code.gs) deste diretório.
4. **Deploy → New deployment → tipo "Web app"**:
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Copie a URL gerada (termina em `/exec`) e cole em
   `src/lib/appStatus.ts`, na constante `APP_STATUS_URL`. Publique uma nova
   build do app com essa URL preenchida.

## Uso no dia a dia

- **Bloquear todo mundo agora**: mude `blocked` pra `TRUE` (preencha
  `blockMessage` se quiser explicar o motivo). O app pega isso em até ~20min
  (ou na hora, se a pessoa focar a janela do app depois da mudança) e mostra
  uma tela cheia bloqueando qualquer interação.
- **Desbloquear**: volte `blocked` pra `FALSE`.
- **Avisar de versão nova (sem bloquear)**: preencha `latestVersion` com a
  versão nova (ex: `1.2.0`). Quem estiver numa versão mais antiga recebe um
  toast (não bloqueia nada) com botão de download, se `updateUrl` estiver
  preenchido.
- **Forçar atualização obrigatória**: preencha `minVersion`. Quem estiver
  abaixo dessa versão vê a mesma tela de bloqueio até atualizar — diferente
  de `blocked`, que bloqueia todo mundo independente da versão instalada.
- **Bloquear uma pessoa específica**: preencha `blockedUsers` com o nome de
  usuário do Windows dela (o mesmo que aparece em "Este PC → Propriedades",
  não é um login do app). Só essa pessoa vê a tela de bloqueio; o resto do
  time continua normal. Aceita vários nomes separados por vírgula.
- **Bloquear uma versão específica**: preencha `blockedVersions` com a
  versão exata que quer derrubar (ex: um release com bug), sem precisar subir
  o `minVersion` geral. Aceita várias separadas por vírgula.

`blockMessage` é compartilhada entre todos os tipos de bloqueio acima — se
preenchida, ela aparece em qualquer um dos casos (global, versão mínima,
usuário específico ou versão específica). Deixe em branco pra cada caso
mostrar sua própria mensagem padrão em inglês.

## Ver quem está usando o app

Toda vez que alguém abre o app, ele registra um "check-in" (usuário do
Windows + versão) direto na planilha, numa aba nova chamada **Users** (criada
sozinha no primeiro check-in). Cada pessoa ocupa **uma linha só**, atualizada
a cada abertura — não é um log que cresce, é sempre "quem já usou e quando
foi a última vez":

| username     | version | lastSeen                  |
|--------------|---------|----------------------------|
| CarlosSilva  | 1.1.8   | 2025-06-01T12:34:56.000Z  |
| joao.pereira | 1.1.7   | 2025-05-30T09:12:03.000Z  |

Isso não exige nenhuma planilha nova nem configuração extra — só colar o
`Code.gs` atualizado (ver abaixo) e reimplantar uma vez.

A coluna `version` dessa aba já é gravada como Texto simples automaticamente
pelo código (evita o mesmo problema de "virar Data sozinha" descrito acima)
— não precisa formatar essa coluna manualmente.

## Log de erros dos usuários

O app captura erros (erros JS não tratados, Promises rejeitadas sem catch,
`console.error` e crashes de render do React) num log local e manda pra aba
**Errors** da planilha (criada sozinha no primeiro envio). Código do lado do
app: `src/lib/errorLog.ts`.

- **Automático**: erros não tratados e crashes são enviados sozinhos, com
  `kind = auto` (mesmo erro repetido só vai 1x por sessão; no máximo 10 por
  sessão).
- **Manual**: em **Settings → Report a problem** o usuário descreve o
  problema e clica em **Send report**. Vão a descrição + os últimos 30 erros
  do log (inclusive `console.error`), todos com `kind = manual` e o mesmo
  `reportId`. O app mostra esse `reportId` pro usuário — peça pra ele te
  passar e filtre a coluna `reportId` na planilha.

| receivedAt | reportId | kind | username | version | description | occurredAt | source | message | stack |
|------------|----------|------|----------|---------|-------------|------------|--------|---------|-------|

Tokens (`Bearer`, JWT, `password=`, `api_key=`, etc) são mascarados no app
antes de enviar. Precisa colar o `Code.gs` atualizado e reimplantar uma vez
(ver abaixo) pra aba Errors começar a receber dados.

## Depois de atualizar o Code.gs (código mudou, não só a planilha)

Diferente de editar células da planilha (que o Web App lê em tempo real sem
precisar reimplantar nada), qualquer mudança no **código** do `Code.gs`
precisa de um novo deployment pra valer:

1. **Extensões → Apps Script**, apague tudo e cole o `Code.gs` atualizado
   deste diretório.
2. **Deploy → Manage deployments**, clique no ícone de lápis do deployment
   ativo (o que gerou a URL usada em `APP_STATUS_URL`).
3. Em **Version**, escolha **New version** e clique em **Deploy**.

A URL (`/exec`) continua a mesma — não precisa mexer em nada no app depois
disso, nem publicar build nova.

Não precisa reimplantar (`Deploy`) de novo depois de editar só a planilha —
o Web App lê a planilha em tempo real a cada chamada.

## Se o botão "Open update page" / "Download" não abrir o link

O app só tem permissão pra abrir URLs de domínios específicos (por
segurança), configurados em `src-tauri/capabilities/default.json` na chave
`opener:allow-open-url`. Por padrão `https://github.com/**` já está liberado
(pra apontar `updateUrl` pra uma release do GitHub). Se `updateUrl` for de
outro domínio, adicione um `{ "url": "https://seu-dominio.com/**" }` nessa
lista e faça uma nova build — sem isso o clique no botão falha silenciosamente.

## Se o app não estiver reagindo às mudanças

- Confirme que a URL colada em `APP_STATUS_URL` termina em `/exec` (não
  `/dev` — essa é só pra teste dentro do editor do Apps Script).
- Abra a URL `/exec` direto no navegador: deve devolver o JSON puro. Se
  pedir login do Google, o deployment não está com "Anyone" em "Who has
  access" — reimplante com essa opção.
- A checagem no app é **fail-open**: se a requisição falhar por qualquer
  motivo (rede, JSON inválido, timeout de 8s), ela é ignorada silenciosamente
  e o app continua funcionando normalmente — só um `blocked: true` lido com
  sucesso bloqueia.
