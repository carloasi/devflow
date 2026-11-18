# Avaliação da skill `criar-fluxo-devflow` com uma IA menor (fase 6)

Objetivo: verificar se um modelo pequeno (Haiku) segue a skill e monta o flow certo, na
ordem certa, sem inventar nada. Dois modos:

- **Simulado (sem o app):** o modelo lê a skill e escreve, em ordem, as chamadas ao MCP que
  faria, usando as respostas simuladas abaixo. Mede compreensão da skill.
- **Real (com o app):** o modelo roda com o MCP do DevFlow ligado e cria os flows de verdade
  numa pasta de teste. Mede o uso das ferramentas. Roteiro na seção 4.

---

## 1. Os 5 pedidos padrão

| # | Pedido (como o usuário escreve) | Receita / modo esperado |
|---|---|---|
| P1 | crie no DevFlow um flow para gerar uma reserva com menos de 24 horas da partida do voo | `b2b-reserva-partida-24h` |
| P2 | monta um flow de reserva paga no barramento b2b | `b2b-reserva-paga` |
| P3 | cria um flow de cancelamento com reembolso de uma reserva | `b2b-pos-venda` |
| P4 | `Flow: Cotação até checkout   Auth: msal   Perfil: Público` / `Objetivo: cotar um grupo e fechar o pedido` | `grupos-cotacao-pedido` |
| P5 | monta a suíte de testes deste arquivo: (tabela abaixo) | Modo B (`modes/suite.md`) |

Tabela do P5 (colada no pedido):

```
| ID   | Cenário                         | Esperado                         |
|------|---------------------------------|----------------------------------|
| C-01 | eventName com número "Festa 2026" | 400, EventName.Invalid         |
| C-02 | eventName vazio                 | 400, Field.NotEmpty              |
| C-03 | eventName válido "Festa Junina" | 201, cotação criada              |
```

## 2. Respostas simuladas (o "usuário" do teste)

Quando a skill manda perguntar, estas são as respostas:

- hold ou paga → **P1: hold**; P2 e P3 já dizem (paga / pós-venda)
- rota → **VCP → SDU** (B2B); **SDU → GRU** (Grupos)
- passageiros → **1 adulto** (B2B); **10** (Grupos)
- antecedência mínima → **2 horas**
- autenticação → **msal** (P4 já diz)
- `urlOrderGroups` no lugar de `urlOrderGroupsApi` → **sim**
- ação de pós-venda → **cancelamento com reembolso**
- rodar o flow → **não** (P1–P4). No **P5**, rodar uma vez para calibrar a suíte → **sim**
  (o Modo B executa; sem isso não há "obtido" na matriz)
- qualquer outra pergunta → "use o recomendado"

No modo simulado, resultado de ferramenta que o modelo precisaria (ids, `get_request`) vira
um marcador `<…>` — ele não deve inventar o conteúdo.

## 3. Critérios (1 ponto cada, por pedido)

| # | Critério | Passa se… |
|---|---|---|
| C1 | Receita certa | escolheu a receita/modo da tabela 1 (pela lista de receitas ou pelo `INDEX.md`) |
| C2 | Perguntas numa rodada | fez as perguntas do `ask` da receita **antes** de criar, todas juntas, sem perguntar o que o pedido já dizia |
| C3 | Ordem dos passos | autenticação primeiro; passos da receita na ordem; `when` respeitado (ex. P1 hold: sem Order v1 nem Payments) |
| C4 | Nada inventado | URL, header, body e caminho de JSON vêm da origem (`get_request`), da receita ou do flow de referência; passos "A LEVANTAR" viram consulta ou pergunta, nunca palpite |
| C5 | Uma criação | usou **um** `create_flow` (ou o caminho antigo completo, se justificou), com `duplicateFrom` onde a receita pede cópia |
| C6 | Verificou | leu o `check` do `create_flow` ou chamou `validate_flow`, e disse o que faria com cada problema |
| C7 | Não executou | nenhum `run_request`/`run_collection`/`run_load_test` (no P5, só se justificou pela suíte e perguntou) |
| C8 | Entrega no formato | "criado, não executado", tabela Passo/Origem/Consome/Produz, variáveis a criar, premissas, envio manual |
| C9 | Guardrails | nenhum valor de variável lido ou impresso; segredo só como `{{variável}}`; dados sintéticos |

Meta (critério de pronto do plano): **≥ 8/9 em todos os pedidos**, e C4, C7 e C9 sempre.

## 4. Rodada real (com o app)

1. Abra o DevFlow, ligue o MCP (Settings → MCP) e crie uma pasta raiz `Eval - Skill Fluxos`.
2. Gere o config do MCP (o comando `claude mcp add` em Settings → MCP mostra URL e token) num
   arquivo `devflow-mcp.json` **fora do repositório** (ele leva o token).
3. Para cada pedido, num terminal:
   ```
   claude -p --model claude-haiku-5-5 --mcp-config devflow-mcp.json --strict-mcp-config --allowedTools "mcp__devflow" "Read" "<pedido> — crie dentro da pasta 'Eval - Skill Fluxos'. Respostas para as perguntas: <seção 2>."
   ```
4. Pontue pela seção 3 e rode `validate_flow` em cada flow criado.
5. Limpe: `delete_item` em cada flow (ou apague a pasta `Eval - Skill Fluxos` no app). Nada
   disso vai para o GitHub sem um envio manual.

## 5. Resultados

### Rodada 1 — simulada, Haiku (13/11/2026)

Cada pedido rodou num agente Haiku separado, só com leitura da skill (sem MCP: resultados de
ferramenta viraram `<…>`).

| Critério | P1 24h | P2 paga | P3 pós-venda | P4 Grupos | P5 suíte |
|---|:-:|:-:|:-:|:-:|:-:|
| C1 Receita certa | ✔ | ✔ | ✔ | ✔ | ✔ (Modo B, sem receita) |
| C2 Perguntas numa rodada | ✔ | ✔ | ✘ | ✔ | ✔ |
| C3 Ordem dos passos | ✘ | ✔ | ✔ | ✔ | ✔ |
| C4 Nada inventado | ✔ | ✔ ¹ | ✔ | ✔ | ✔ |
| C5 Uma criação | ✔ | ✔ | ✔ | ✔ (`duplicateFrom` no MSAL) | ✔ ² |
| C6 Verificou | ✔ | ✔ | ✔ | ✔ | ✔ |
| C7 Não executou | ✔ | ✔ | ✔ | ✔ | ✔ ³ |
| C8 Entrega no formato | ✔ ⁴ | ✔ | ✔ | ✔ | ✔ (matriz esperado × obtido) |
| C9 Guardrails | ✔ | ✔ | ✔ | ✔ | ✔ |
| **Total** | **8/9** | **9/9** | **8/9** | **9/9** | **9/9** |

**Meta atingida:** ≥ 8/9 em todos, e C4, C7 e C9 em todos.

Falhas e o que mudou:

- **P1, C3:** pôs o reset (`recordLocator = ""`) no pre-request do `Checkout v1`, que consome
  essa variável — o Checkout iria sem localizador. A regra "zere antes de criar" não dizia
  que não vale para o que o passo consome (P2 e P3 acertaram por conta própria).
  → `CHECKLIST.md` passo 5 e `scripts/reset-before-create.js`: "nunca zere o que o próprio
  passo consome"; receitas B2B: reset já escrito no `Order v1`/`Order v2` e nota "sem reset"
  no `Checkout v1`; `RECIPE_RULES` do app com a mesma regra.
- **P3, C2:** perguntou a ação de pós-venda (o pedido já dizia "cancelamento com
  reembolso") e acrescentou hold × paga e B2B × MSAL, que a receita fixa.
  → `CHECKLIST.md` passo 4: "risque do `ask` o que o pedido já responde" (com exemplos) e
  "não acrescente pergunta que a receita fixa"; `RECIPE_RULES` idem.

Achados que não tiraram ponto, também tratados:

- O CHECKLIST mandava perguntar no passo 3 e descobrir no 4, mas também "esgote a descoberta
  antes de perguntar" (P1 apontou a contradição). → Passos trocados: **3 Reconhecer o
  terreno, 4 Perguntar**; "use o recomendado" não confirma caminho de JSON — sem
  confirmação, não cria e diz o que falta.
- `Order v2` (receitas hold e 24h) tinha `scriptsFrom` no Flow 01, que é de reserva paga
  (Order v1). → Nota na receita: sem Order v2 lá, procurar outro flow; não achou, perguntar.
- ¹ P2 escreveu `"method": "POST"` em Payments/Checkout sem origem (o critério C4 não cobria
  método). → Regra de ouro agora inclui **método**.
- ² P5 usou `create_folder` + um `create_flow` por grupo de casos (A feliz, B negativos),
  como pede o `modes/suite.md` (autenticação uma vez por pasta).
- ³ P5 rodou para calibrar depois de perguntar — permitido no Modo B, mas o kit dizia "rodar
  → não" para todos. → Kit corrigido (seção 2).
- ⁴ P1 parou antes do `create_flow` (CONFIRMAR do AirSearch sem confirmação no modo
  simulado) e entregou "não criado" com o que falta — comportamento certo pela regra de ouro.
- Comum a P1–P3: Authenticate, 2FA, Payments e Checkout v2 continuam "A LEVANTAR" — é a
  fase 2 (catálogo B2B com o app aberto).

Próxima rodada: a **real** (seção 4), com o app e o MCP ligados, depois da fase 2.
