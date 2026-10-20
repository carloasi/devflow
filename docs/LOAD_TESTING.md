# Teste de Carga (Load Test)

O DevFlow tem um motor de teste de carga embutido, sem depender de ferramentas externas (k6, JMeter, etc). Ele roda direto no backend Rust do app, com múltiplos Virtual Users (VUs) simulados em paralelo, e suporta desde um teste simples numa única request até um fluxo multi-step com correlação de dados entre passos.

## Como abrir

Clique com o botão direito numa **request** ou numa **pasta** na árvore de collections e escolha **Load Test**. Se for uma pasta, o teste roda o **fluxo completo** — todas as requests da pasta, na ordem em que aparecem na árvore (a mesma ordem usada pelo Collection Runner).

## Modos de execução

O painel tem três modos, escolhidos no topo:

- **Duration** — um número fixo de VUs simultâneos, rodando em loop, por um tempo determinado (em segundos).
- **Iterations/VU** — um número fixo de VUs, cada um executando um número fixo de iterações do fluxo, depois parando.
- **Ramp (stages)** — uma sequência de estágios, cada um definindo um número-alvo de VUs e por quantos segundos manter (ou migrar até) esse número. Útil para simular crescimento gradual de carga (ramp-up), um platô, e queda (ramp-down). Estágios são editáveis (adicionar/remover/reordenar não é suportado, mas dá pra ajustar VUs e duração de cada um).

Limites do motor: até **2000 VUs**, duração máxima de **3600s** por execução, até **100.000 iterações por VU**, até **20 estágios** num ramp, até **30 requests** no fluxo, até **10 thresholds**.

## Ambiente (variáveis)

No seletor **Environment** do painel, escolha qual Environment do app serve de base para as variáveis `{{...}}` usadas nas URLs, headers, body e auth das requests do fluxo. Cada VU recebe sua própria cópia desse ambiente (`envMap`) no início do teste — variáveis nunca vazam entre VUs.

## Correlação entre requests (post-response scripts)

Quando o alvo é um fluxo com mais de uma request, cada request pode ter um **post-response script** (definido na aba Scripts da própria request, igual ao fluxo normal do app). Esse script roda depois da resposta chegar, dentro do mesmo VU, e pode ler dados da resposta e gravar no ambiente daquele VU para as próximas requests do fluxo usarem — por exemplo, extrair um token de login e usá-lo como Bearer token na request seguinte.

A API disponível dentro do script (motor QuickJS, isolado por VU) é enxuta, focada só em correlação:

```js
pm.environment.get('chave')
pm.environment.set('chave', valor)
pm.environment.has('chave')
pm.environment.unset('chave')
// pm.variables, pm.globals e pm.collectionVariables funcionam como aliases do mesmo ambiente

pm.response.code        // status HTTP (number)
pm.response.status      // idem
pm.response.responseTime
pm.response.text()      // corpo como string
pm.response.json()      // corpo parseado como JSON
pm.response.headers.get('nome-do-header')
pm.response.headers.has('nome-do-header')
```

Não há `pm.test`/`pm.expect` no teste de carga (isso existe no envio normal de request e no Collection Runner, não aqui) — o load test não faz asserções, só correlação. Um erro de script não aborta o teste: ele é contado em **Script errors** no resumo, sinalizando que a correlação pode ter quebrado sem interromper a carga.

## Autenticação

Cada request do fluxo carrega seu próprio tipo de auth: `none`, `bearer`, `basic` ou `apikey`, resolvido com as variáveis do ambiente daquele VU antes de cada chamada.

## Thresholds (critérios de pass/fail)

Clique em **Thresholds** para configurar condições que definem se o teste "passou" ou "falhou" no geral. Cada threshold é `métrica` + `operador` + `valor`:

- Métricas: `p50`, `p90`, `p95`, `p99`, `avg`, `min`, `max` (todas em ms), `errorRate` (%), `rps` (req/s).
- Operadores: `<`, `<=`, `>`, `>=`.

Exemplo: `p95 < 500` falha o teste se o percentil 95 de latência passar de 500ms. O resultado de cada threshold (passou/falhou + valor real medido) aparece no resumo, no histórico e no relatório PDF.

## Métricas coletadas

Ao vivo (durante a execução) e no resumo final:

- Requests totais, OK e falhas.
- RPS atual (ao vivo) e RPS médio (resumo).
- Latência: min, avg, p50, p90, p95, p99, max (ms).
- Breakdown por status code (incluindo `error` para falhas de rede/timeout).
- Contagem de script errors.
- VUs ativos no momento (ao vivo).

Durante a execução, três gráficos em tempo real mostram RPS, latência (avg/p95/p99) e, no modo Ramp, VUs ativos ao longo do tempo.

## Timeout

Cada request individual tem um timeout de **30 segundos** por padrão (configurável via `timeoutSecs` na config, embora a UI atual não exponha esse campo diretamente).

## Histórico de execuções

Toda execução concluída (ou parada manualmente) fica salva no histórico daquele request/pasta, com data/hora, modo, config usada e o resumo de métricas. Acesse pelo botão **History** no topo do painel.

No histórico dá para:

- **Ver** uma execução antiga — mostra as métricas agregadas, mas não os gráficos ao longo do tempo (só o resumo final é persistido, não a série temporal completa).
- **Exportar** como JSON ou como **relatório em PDF**.
- **Excluir** um registro.

São mantidos até **20 registros** por item — os mais antigos são descartados automaticamente.

## Exportar relatório (JSON / PDF)

Com uma execução ao vivo terminada ou uma execução do histórico aberta, os botões **JSON** e **PDF** no topo do painel exportam o resultado:

- **JSON** — o registro completo (config + resumo), útil para reprocessar ou versionar.
- **PDF** — um relatório formatado com cabeçalho, resumo (requests, RPS, taxa de erro, script errors), tabela de latência, thresholds com pass/fail colorido, breakdown de status codes e a lista de requests do fluxo. Pronto para compartilhar com o time ou anexar numa evidência de teste.

## Parar um teste em andamento

O botão **Stop** interrompe o teste imediatamente — os VUs ainda em execução terminam a iteração atual e param. O resumo parcial (até o momento da parada) é salvo no histórico normalmente.

## Onde fica o código

| Peça | Arquivo |
|---|---|
| Motor de execução (Rust, VUs + QuickJS) | `src-tauri/src/load_test.rs` |
| Tipos compartilhados (TS) | `src/components/LoadTest/types.ts` |
| Painel principal | `src/components/LoadTest/LoadTestPanel.tsx` |
| Conversão collection → fluxo | `src/components/LoadTest/buildFlowSteps.ts` |
| Histórico (persistência) | `src/components/LoadTest/loadTestHistory.ts` |
| Relatório PDF | `src/components/LoadTest/loadTestPdfReport.ts` |
