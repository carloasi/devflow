# Plano de melhoria — skill `criar-fluxo-devflow` × MCP do DevFlow

> **Andamento (13/11/2026):** fase 1 ✔ (skill alinhada ao MCP atual, M1–M6) · fase 3 ✔
> (skill reestruturada: `SKILL.md` roteador, `CHECKLIST.md`, `recipes/` com 5 receitas,
> `scripts/`, `examples/reserva-24h.md`, `modes/`, `references/`) · **fase 2 pendente**:
> `references/b2b/catalog.md` e os passos B2B das receitas estão marcados "A LEVANTAR" e
> precisam do app com o MCP ligado. Fase 4 ✔ (`create_flow` e `validate_flow` no MCP —
> `src/mcp/mcpTools.ts`, `src/mcp/flowValidation.ts` — e a skill já os usa nos passos 6 e 7).
> Fase 5 ✔ (`list_flow_recipes`/`get_flow_recipe` com as receitas em `src/mcp/flowRecipes/`;
> `update_request`, `move_item`, `delete_item` em `src/mcp/treeEdit.ts`; exemplos de chamada e
> anotações MCP em todas as ferramentas). Fase 6 ✔ na rodada simulada (Haiku, 5 pedidos:
> 8, 9, 8, 9, 9 de 9; C4, C7 e C9 em todos; falhas corrigidas na skill e no app). Falta a
> rodada real com o app (`docs/AVALIACAO_SKILL_FLUXOS.md` §4), junto com a fase 2.

**Objetivo:** uma IA com menos capacidade (Haiku, Sonnet pequeno, um modelo local) recebe
"crie no DevFlow um flow para gerar uma reserva com menos de 24 horas da partida do voo" e
monta o flow certo, na ordem certa (token → autenticar → buscar voo → criar a order →
checkout), sem improvisar.

Hoje isso depende de a IA ler 210 linhas de SKILL.md + 3 referências, juntar regras
espalhadas e deduzir sozinha os detalhes de cada passo. Um modelo grande dá conta; um
pequeno erra a ordem, esquece um header ou inventa um caminho de JSON.

---

## 1. Diagnóstico

### 1.1 O que dificulta para uma IA menor

| # | Problema | Onde |
|---|---|---|
| D1 | **Tudo num arquivo só.** Guardrails, regras do runtime, limites do MCP, 3 modos (fluxo, suíte, execução), 2 domínios e erros comuns no mesmo SKILL.md. A IA precisa decidir sozinha o que vale para o pedido. | `SKILL.md` inteiro |
| D2 | **B2B não tem catálogo.** Grupos tem `catalog.md` com verbo, URL, body e o que cada passo produz; o Barramento B2B tem só uma tabela de 3 linhas com nomes de passo ("04 AirSearch V3"). A IA não sabe de qual pasta copiar, que header vai, nem que variável sai de cada resposta. | `SKILL.md:160-175` |
| D3 | **Nenhuma receita executável.** Os modelos ("Reserva em hold", "Reserva paga") são frases. Não há um arquivo com os passos prontos no formato do `create_request` — só existe isso para a autenticação de Grupos (`auth-msal.json`, `auth-b2b.json`). | `references/grupos/` |
| D4 | **Decisões implícitas.** "Reserva" pode ser em hold ou paga; "checkout conforme a order" depende disso (Order v2 + Checkout v1, ou Order v1 + Payments + Checkout v1). A skill diz "em dúvida, pergunte", mas não lista **quais** perguntas cada tipo de flow exige. | `SKILL.md:51`, `:166-172` |
| D5 | **Regras de tempo não existem.** "Menos de 24h da partida" exige buscar voo hoje/amanhã e escolher pela hora de partida — não há padrão de script para isso (só `moment().add(n, "days")` para datas futuras). | `patterns.md:24-29` |
| D6 | **Sem verificação objetiva no fim.** "Confira por amostragem 2–3 passos" é subjetivo. Uma IA menor não percebe que o passo 05 consome `{{journeyKey}}` que ninguém produziu. | `SKILL.md:108-109` |
| D7 | **Exemplos parciais.** Os exemplos mostram um script isolado, nunca o caminho inteiro "pedido → perguntas → chamadas MCP em ordem → entrega". | `SKILL.md:177-199` |

### 1.2 Skill desatualizada em relação ao MCP de hoje

A skill é de 09/10; o MCP mudou desde então (várias mudanças desta semana). Uma IA que
segue a skill ao pé da letra hoje faz coisas desnecessárias ou erradas:

| # | A skill diz | O MCP hoje | Efeito |
|---|---|---|---|
| M1 | "`run_collection` não grava no environment as variáveis" (`SKILL.md:68`, `:204`) | `run_request` e `run_collection` **gravam** o que os scripts setam, como o Send e o Runner, e devolvem `savedToEnvironment` | IA evita `run_request` avulso sem motivo; o erro comum da linha 204 não acontece mais |
| M2 | "OAuth 2.0 não se cria por aqui"; o passo 01 MSAL é um **placeholder** que dá 404 e deve ser ignorado (`SKILL.md:65`, `:155`, `auth-msal.json`) | `duplicate_request` copia a request "Gerar token MSAL" **com** a configuração OAuth2 e os segredos; uma request OAuth2 sem URL é um **passo de token** que o `run_collection`, o `run_request` e o `run_load_test` resolvem sozinhos (reaproveitam o token válido ou fazem o login) | O placeholder 404, o "ignore o passo 01" e o "não use stopOnFailure a partir dele" deixam de ser necessários |
| M3 | Guardrail 1: "o `run_collection` devolve tokens em `variablesSet` e no body: não use, não repita" (`SKILL.md:46`, `patterns.md:80`) | O MCP já **mascara** segredos nos resultados (token vira `{{variavel}}`; variável secreta setada volta como oculta) | A regra continua boa, mas a IA não precisa mais "se segurar": o valor nem chega |
| M4 | "Pasta com até ~30 passos (uma de 94 deu timeout)" (`SKILL.md:69`) | O transporte agora tem prazo de **inatividade** com heartbeat: ferramenta longa não estoura mais em 120 s | O limite de 30 vira recomendação de organização, não de timeout |
| M5 | Lista de ferramentas não cita `duplicate_request`, `get_last_run`, `get_oauth2_token` como passo do fluxo, `get_console_logs` | Existem | IA pequena não usa o que não vê listado |
| M6 | "`create_request` exige `url` e auth ∈ none/bearer/basic/apikey" (`SKILL.md:65`) | Aceita `oauth2` também; `url` continua obrigatória (por isso o passo de token vem do `duplicate_request`) | Texto incompleto |

---

## 2. Proposta — skill em camadas, com receitas

A ideia central: **a IA não monta o fluxo a partir de regras; ela escolhe uma receita e
preenche os parâmetros.** Regra só para o que não tem receita.

### 2.1 Nova estrutura de arquivos

```
criar-fluxo-devflow/
  SKILL.md                     ← curto (≤ 80 linhas): roteador + checklist universal
  CHECKLIST.md                 ← os 9 passos numerados (seção 3), com "PARE/PERGUNTE"
  recipes/
    INDEX.md                   ← tabela: pedido do usuário → receita
    b2b-reserva-hold.json
    b2b-reserva-paga.json
    b2b-reserva-partida-24h.json   ← o exemplo deste plano (seção 4)
    b2b-pos-venda.json
    grupos-cotacao-pedido.json
  references/
    b2b/catalog.md             ← NOVO: igual ao de Grupos (pasta de origem, verbo, URL,
                                  headers, body, o que produz e de qual caminho do JSON)
    grupos/…                   ← como hoje
  scripts/                     ← trechos prontos, um por arquivo, com comentário de uso
    select-flight-within-hours.js
    set-dynamic-date.js
    produce-from-response.js
  examples/
    reserva-24h.md             ← diálogo completo: pedido → perguntas → chamadas → entrega
```

### 2.2 SKILL.md curto (roteador)

Só três coisas, nesta ordem:

1. **Classifique o pedido** com uma tabela fechada:

   | Se o pedido fala de… | Use |
   |---|---|
   | reserva, booking, emissão, pagar reserva, checkout de reserva | `recipes/INDEX.md` → família B2B |
   | cotação de grupo, quote, pedido de grupo | família Grupos |
   | lista de casos, matriz de testes, critérios de aceite | Modo B (suíte) |
   | rodar/executar um flow que já existe | Modo C |
   | nada disso | mecânica geral (`CHECKLIST.md`) |

2. **Guardrails** — os 7 atuais, cada um numa linha (detalhes vão para `CHECKLIST.md`).
3. **"Siga `CHECKLIST.md` passo a passo. Não pule passo. Não reordene."**

Por que ajuda: um modelo pequeno segue tabela e lista numerada muito melhor do que
prosa com exceções.

### 2.3 Formato de receita (o coração do plano)

Uma receita é o flow inteiro já no formato do `create_request`, mais o que a IA precisa
decidir ou perguntar. Exemplo do esqueleto:

```json
{
  "id": "b2b-reserva-partida-24h",
  "title": "Reserva com partida em menos de 24 horas",
  "workspace": "Barramento B2B - Dev",
  "environment": "5by5",
  "parentFolder": "Method Flows Barramento B2B - Claude",
  "folderName": "Flow NN - Reserva partida < 24h",
  "ask": [
    { "id": "payment", "question": "A reserva fica em hold ou é paga?", "options": ["hold (Recomendado)", "paga"] },
    { "id": "route", "question": "Qual rota?", "options": ["VCP-SDU (Recomendado)", "outra"] },
    { "id": "pax", "question": "Quantos passageiros adultos?", "options": ["1 (Recomendado)", "2", "outro"] }
  ],
  "params": { "minHours": 2, "maxHours": 24 },
  "steps": [
    {
      "name": "01 - Token v1",
      "copyFrom": "Barramento B2B - Dev / Authentication / v1 / Token v1",
      "produces": ["bearerToken"],
      "consumes": ["urlAuthorization", "apiKey", "tokenB2b"],
      "postResponseScript": "var d = pm.response.json().data;\npm.environment.set(\"bearerToken\", d.token);"
    }
  ],
  "verify": ["todo {{var}} consumido é produzido antes ou existe no environment", "…"]
}
```

Campos que tornam a receita "à prova de IA pequena":

- **`copyFrom`**: o caminho exato da request de origem. A IA chama `get_request` nela e
  copia método, URL, headers, auth e body — nada é inventado.
- **`produces` / `consumes`**: o encadeamento explícito. Serve também para a verificação
  final (seção 3, passo 8).
- **`ask`**: as perguntas obrigatórias **daquele** flow, já com as opções e a recomendada
  primeiro — a IA só repassa ao `AskUserQuestion`.
- **`when`** (opcional, por passo): passo condicional a uma resposta, ex.
  `"when": "payment == paga"` no passo de Payments. Resolve o D4 sem a IA deduzir.
- **`postResponseScript` / `preRequestScript`**: o script pronto, ou o nome de um arquivo
  de `scripts/`.

### 2.4 `references/b2b/catalog.md` (resolve o D2)

Levantar pelo próprio MCP (uma vez, por quem tiver acesso ao app), no mesmo formato do
catálogo de Grupos. Para cada passo dos modelos B2B:

| Campo | Como obter |
|---|---|
| Pasta de origem exata | `list_folders` com `search` |
| Verbo, URL, headers, auth, body ativo | `get_request` |
| O que a resposta traz e o caminho do JSON | `list_examples` / `get_example` (sem executar) ou `get_last_run` de um flow que já rodou |
| Variáveis que produz/consome | scripts do flow de referência (`Flow 01 - Fluxo Cancelamento com Reembolso`) |

Itens mínimos: Token v1, Authenticate v1, 2FA, AirSearch v3, Order v1, Order v2,
Payments v1, Checkout v1, Order/{recordLocator} v3, Order Calculate v2, Checkout v2.

---

## 3. CHECKLIST universal (o que vai em `CHECKLIST.md`)

Cada passo diz **o que fazer**, **com qual ferramenta** e **quando parar**.

| # | Passo | Ferramenta | PARE / PERGUNTE se… |
|---|---|---|---|
| 1 | Conferir o MCP do DevFlow | `ToolSearch` `+devflow` | as ferramentas não aparecem (siga o roteiro de conexão; não contorne) |
| 2 | Escolher a receita pela tabela do `INDEX.md` | — | nenhuma receita bate → use a mecânica geral e avise |
| 3 | Fazer **todas** as perguntas do `ask` da receita numa rodada | `AskUserQuestion` | — (não pergunte o que o usuário já respondeu) |
| 4 | Ver o environment (só nomes) | `list_environments` | falta variável que nenhum passo produz → anote para a entrega, não pare |
| 5 | Achar a pasta-raiz e o próximo número livre | `list_folders` `search` | a raiz não existe → crie na raiz e avise |
| 6 | Criar a pasta do flow | `create_folder` | — |
| 7 | Para cada passo da receita, **na ordem**: `get_request` no `copyFrom` → `create_request` com o que veio + scripts da receita. Passo de token OAuth2: `duplicate_request` em vez de `create_request` | `get_request`, `create_request`, `duplicate_request` | a request de origem não existe ou mudou de formato → pare e pergunte |
| 8 | **Verificar** (objetivo, não amostragem): para cada passo, todo `{{x}}` usado está em `produces` de um passo anterior **ou** no environment; scripts não vazios (`get_request`); `Content-Type` em todo body JSON; acentos intactos | `get_request` | algo falha → corrija com `set_request_script`/`rename_item`, ou recrie o passo |
| 9 | Entregar no formato fixo (pasta, "criado, não executado", tabela Passo/Origem/Consome/Produz, variáveis a criar, premissas, push manual) | — | — |

Regra de ouro para IA pequena, repetida no topo do checklist: **nunca escreva URL, body ou
caminho de JSON de cabeça — copie da request de origem ou da receita.**

---

## 4. Exemplo trabalhado — "reserva com menos de 24 horas da partida"

Pedido: *"crie no DevFlow um flow para gerar uma reserva com menos de 24 horas da partida
do voo"*. Sequência pedida: gerar o token → autenticar → buscar o voo → criar a order →
checkout conforme a order.

### 4.1 Classificação e perguntas (passos 2–3)

`INDEX.md` → "reserva" → família B2B → receita `b2b-reserva-partida-24h`. Perguntas, numa
rodada só:

1. **Hold ou paga?** — decide a order e o checkout (D4):
   - hold → `05 Order v2` · `06 Checkout v1`
   - paga → `05 Order v1` · `06 Payments v1` · `07 Checkout v1` (a skill já registra: com
     pagamento, sempre Order v1; Order v2 + Payments não fecha o Checkout)
2. **Rota** (origem/destino) — precisa ter voo nas próximas 24h no ambiente de dev.
3. **Passageiros** (adultos).
4. **Janela mínima** antes da partida (padrão 2h) — voo saindo em 20 minutos costuma ser
   recusado pelo próprio sistema (prazo de emissão); vale perguntar a regra real.

### 4.2 Os passos (receita, versão hold)

| Passo | Origem (copiar com `get_request`) | Consome | Produz |
|---|---|---|---|
| 01 - Token v1 | `Barramento B2B - Dev / Authentication / v1 / Token v1` | `urlAuthorization`, `apiKey`, `tokenB2b` | `bearerToken` |
| 02 - Authenticate v1 | `Barramento B2B - Dev / User / v1 / Authenticate v1` | `urlUser`, `b2bUsername`, `b2bPassword`, `bearerToken` | sessão (e o que o 2FA pedir — **confirmar no catálogo**) |
| 03 - 2FA | *(a levantar: pasta/URL — seção 2.4)* | idem | *(a levantar)* |
| 04a - AirSearch v3 (hoje) | `… / AirSearch v3` *(caminho a levantar)* | `flowSearchDate` (pre-request), rota, pax | `journeyKey`, `fareKey`, `flowDepartureAt` — **só se** houver voo na janela |
| 04b - AirSearch v3 (amanhã) | mesma origem | `flowSearchDate` = amanhã | idem — **só se** o 04a não achou |
| 05 - Order v2 | `… / Order / v2` | `journeyKey`, `fareKey`, passageiros sintéticos | `recordLocator` (ou o token que o checkout pede — **confirmar**) |
| 06 - Checkout v1 | `… / Checkout / v1` | o que o 05 produziu | `recordLocator` final |

Por que **dois** AirSearch: "menos de 24h" atravessa a meia-noite (às 18h, o voo das 10h
de amanhã está dentro da janela). O runtime não tem `pm.setNextRequest`, então o segundo
passo sempre roda — mas o script dele só grava se o primeiro não achou nada.

### 4.3 Scripts prontos (`scripts/select-flight-within-hours.js`)

Pre-request do **04a** (data de busca = hoje) — o 04b usa `add(1, "days")`:

```js
// Busca os voos de HOJE; o 04b busca os de amanhã.
var moment = require("moment");
pm.environment.set("flowSearchDate", moment().format("YYYY-MM-DD"));
// Começa vazio: nunca reaproveite o voo de outra execução.
pm.environment.set("journeyKey", "");
pm.environment.set("fareKey", "");
```

Post-response do **04a e 04b** (o mesmo código nos dois):

```js
// Escolhe o 1º voo com partida entre agora+minHours e agora+maxHours que tenha tarifa.
// O 04b só grava se o 04a não achou (journeyKey ainda vazio).
// Dentro de uma função: "return" solto no topo do script não é garantido no QuickJS.
(function () {
  var moment = require("moment");
  if (pm.environment.get("journeyKey")) return;

  var minHours = 2, maxHours = 24;           // da receita (params)
  var now = moment();
  var data = pm.response.json().data;
  // CAMINHOS A CONFIRMAR no catálogo B2B (get_example do AirSearch v3):
  var journeys = (data && data.journeys) || [];

  for (var i = 0; i < journeys.length; i++) {
    var j = journeys[i];
    var departure = moment(j.departureDateTime);  // campo a confirmar
    var hours = departure.diff(now, "hours", true);
    var fare = (j.fares || [])[0];
    if (hours >= minHours && hours < maxHours && fare) {
      pm.environment.set("journeyKey", j.journeyKey);
      pm.environment.set("fareKey", fare.fareKey);
      pm.environment.set("flowDepartureAt", departure.format());   // a skill grava, a skill pode ler
      return;
    }
  }
  console.log("Nenhum voo com partida em menos de " + maxHours + "h nesta busca.");
})();
```

Pontos marcados "a confirmar" são exatamente o que o catálogo B2B (seção 2.4) precisa
fixar. Na receita final eles já vêm resolvidos — a IA pequena não deve adivinhar caminho
de JSON.

### 4.4 Chamadas MCP, em ordem (o que a IA executa)

1. `list_environments` → conferir por nome: `urlAuthorization`, `urlUser`, `apiKey`,
   `tokenB2b`, `b2bUsername`, `b2bPassword`, e a URL base de shopping/order/checkout.
2. `list_folders` `{ "search": "Method Flows Barramento B2B - Claude" }` → id da raiz e
   próximo `NN`.
3. `create_folder` `{ "name": "Flow NN - Reserva partida < 24h (hold)", "parentFolderId": "<id da raiz>" }`.
4. Para cada linha da tabela 4.2, em ordem:
   `get_request` no `copyFrom` → `create_request` com `folderId`, `name`, `method`, `url`,
   `pathParams`, `headers`, `body`, `bodyType`, `auth` copiados, + scripts da receita.
5. Verificação (passo 8 do checklist) com `get_request` em **todos** os passos.
6. Entrega: "criado, **não executado**"; tabela da 4.2; variáveis a criar; premissas
   (janela mínima adotada, hold × paga); lembrete de push manual. Oferecer rodar
   (`run_collection`) — cria **reserva real** no dev.

### 4.5 O que pode dar errado e a receita já prevê

| Situação | Comportamento esperado |
|---|---|
| Nenhum voo nas próximas 24h | 04a e 04b deixam `journeyKey` vazio; o 05 falha. A entrega avisa que a rota precisa ter voo hoje/amanhã no dev. |
| Voo muito em cima da hora | `minHours` evita; perguntar a regra real de prazo de emissão. |
| Usuário quer "paga" | receita troca 05 por Order v1 e insere 06 Payments v1 (`when: payment == paga`). |
| Reexecução no mesmo dia | o pre-request do 04a zera `journeyKey`/`fareKey`; sem isso, a order usaria o voo de ontem. |

---

## 5. Melhorias no MCP (para menos passos e menos erro)

Ordenadas por quanto reduzem o trabalho da IA pequena:

| # | Melhoria | Por que ajuda |
|---|---|---|
| P1 | **`create_flow`**: cria a pasta e todos os passos numa chamada, a partir de uma receita (JSON da seção 2.3) | troca ~15 chamadas por 1; elimina erro de ordem |
| P2 | **`validate_flow(folderId)`**: devolve, por passo, variáveis consumidas sem produtor nem environment, scripts vazios, body JSON sem `Content-Type`, URL com `{{}}` desconhecido | torna o passo 8 do checklist objetivo, sem a IA raciocinar |
| P3 | **`get_flow_recipe(id)` / `list_flow_recipes`**: as receitas vivem no app, servidas pelo MCP | qualquer IA (não só o Claude Code com a skill instalada) recebe a mesma receita, sempre atualizada |
| P4 | **`update_request`** (URL, headers, body) e **`delete_item`** | hoje um erro vira "crie outra e peça para o usuário apagar a antiga"; IA pequena se perde nisso |
| P5 | **`move_item`** (posição na pasta) | inserir passo no meio de um flow sem pedir para arrastar |
| P6 | Descrições das ferramentas com **um exemplo de chamada** cada | modelos pequenos acertam parâmetros muito mais com exemplo |
| P7 | Anotações `readOnlyHint` / `destructiveHint` nas ferramentas | o cliente pode liberar só leitura para IA menos confiável |

P1 e P2 sozinhas já resolvem a maior parte: com elas, o fluxo de uma IA pequena vira
"escolha a receita → pergunte o `ask` → `create_flow` → `validate_flow` → entregue".

---

## 6. Roteiro

| Fase | Entrega | Esforço |
|---|---|---|
| 1 | Atualizar a skill com M1–M6 (sem mudar a estrutura) | pequeno |
| 2 | Levantar `references/b2b/catalog.md` pelo MCP (seção 2.4) | médio — precisa do app com o MCP ligado |
| 3 | Reestruturar a skill: SKILL.md roteador, `CHECKLIST.md`, `recipes/` (hold, paga, < 24h, pós-venda, Grupos), `scripts/`, `examples/` | médio |
| 4 | MCP: `validate_flow` (P2) e `create_flow` (P1) | médio |
| 5 | MCP: receitas servidas pelo app (P3), `update_request`/`delete_item`/`move_item` (P4–P5), exemplos e anotações (P6–P7) | maior |
| 6 | **Teste com IA menor:** rodar 5 pedidos padrão com Haiku (reserva hold, paga, < 24h, cotação de grupo, suíte a partir de arquivo) e medir: passos na ordem, nenhuma URL inventada, `validate_flow` limpo, perguntas certas feitas | pequeno, repetível |

Critério de pronto: os 5 pedidos padrão saem com `validate_flow` limpo e sem nenhuma
pergunta a mais ou a menos que o `ask` da receita, num modelo pequeno.
