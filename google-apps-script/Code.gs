/**
 * Web App que expõe o conteúdo de uma aba da planilha como JSON — usado pelo
 * DevFlow pra checar se há atualização disponível ou se o app
 * deve ficar bloqueado, sem precisar rebuildar/republicar o app: é só editar
 * as células da planilha. Também recebe um "check-in" do app a cada
 * abertura (ver recordUserCheckin abaixo), registrando numa segunda aba
 * ("Users") quem está usando o app e em qual versão.
 *
 * SETUP (uma vez só):
 *   1. Crie uma Google Sheet nova.
 *   2. Na primeira aba, preencha as colunas A (key) e B (value), UMA LINHA
 *      POR CHAVE, sem cabeçalho — comece já na linha 1:
 *
 *        latestVersion    1.1.5
 *        minVersion       (deixe vazio se não quiser exigir versão mínima)
 *        blocked          FALSE
 *        blockMessage     (mensagem mostrada quando blocked = TRUE)
 *        updateUrl        https://github.com/seu-usuario/devflow/releases/latest
 *        updateMessage    Nova versão disponível com melhorias de load test!
 *        blockedUsers     (opcional — nomes de usuário do Windows separados por
 *                          vírgula, ex: "CarlosSilva, joao.pereira")
 *        blockedVersions  (opcional — versões exatas separadas por vírgula,
 *                          ex: "1.1.4, 1.1.7-beta")
 *
 *   3. Extensões > Apps Script, apague o conteúdo de Code.gs e cole este
 *      arquivo inteiro.
 *   4. Deploy > New deployment > tipo "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *      Copie a URL gerada (termina em /exec).
 *   5. Cole essa URL em src/lib/appStatus.ts (constante APP_STATUS_URL) e
 *      publique uma nova build do app.
 *
 * PRA USAR DEPOIS:
 *   - Bloquear todo mundo AGORA: mude a célula da linha "blocked" pra TRUE
 *     (e opcionalmente preencha blockMessage). Some minutos depois (o app
 *     checa a cada ~20min, ou na volta de foco da janela) todo mundo vê a
 *     tela de bloqueio.
 *   - Desbloquear: volte "blocked" pra FALSE.
 *   - Avisar de uma versão nova: preencha latestVersion com a versão nova
 *     (ex: "1.2.0") e opcionalmente updateUrl/updateMessage — quem estiver
 *     numa versão mais antiga vê um toast não-bloqueante com um botão de
 *     download.
 *   - Exigir atualização obrigatória (sem travar tudo com "blocked"):
 *     preencha minVersion — quem estiver abaixo dessa versão vê a MESMA tela
 *     de bloqueio até atualizar.
 *   - Bloquear UMA PESSOA específica (sem afetar mais ninguém): preencha
 *     blockedUsers com o nome de usuário do Windows dela (é só o que aparece
 *     em "whoami" / propriedades da conta — não é login do app). Aceita
 *     vários nomes separados por vírgula.
 *   - Bloquear UMA VERSÃO específica (ex: um release com bug, sem mexer no
 *     mínimo exigido pra todo mundo): preencha blockedVersions com a versão
 *     exata (ex: "1.1.7"). Aceita várias separadas por vírgula.
 *   - Ver quem está usando o app: abra a aba "Users" (criada automaticamente
 *     no primeiro check-in) — uma linha por pessoa, com a versão e o horário
 *     do último acesso.
 *
 * Não precisa reimplantar o deployment depois de editar só a planilha — o
 * Web App lê a planilha em tempo real a cada chamada. MAS depois de colar
 * este arquivo (que agora inclui o check-in de usuários), é preciso
 * reimplantar uma vez: Deploy > Manage deployments > ícone de lápis no
 * deployment ativo > Version: "New version" > Deploy.
 */
/**
 * Registro de "quem está usando o app" — grava/atualiza uma linha por
 * usuário numa aba separada chamada "Users" (cria automático na primeira
 * vez, com cabeçalho). Não é log de todo acesso — é só "último visto", uma
 * linha por pessoa, sobrescrita a cada abertura do app dela.
 *
 * A aba "Users" fica assim:
 *   username      | version | lastSeen
 *   CarlosSilva   | 1.1.5   | 2025-06-01T12:34:56.000Z
 *
 * Chamado via GET com ?checkin=1&username=...&version=... (não via POST) —
 * de propósito: Web Apps do Apps Script respondem com um redirect (302) pra
 * executar de fato, e alguns clientes HTTP (inclusive o Rust/reqwest usado
 * no app) descartam o body de um POST ao seguir esse redirect, perdendo o
 * username/version silenciosamente. Query string sobrevive a qualquer
 * redirect, então GET é o jeito confiável de mandar esses dois campos aqui.
 */
function recordUserCheckin(username, version) {
  username = String(username || '').trim();
  version = String(version || '').trim();
  if (!username) return { ok: false, error: 'missing username' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Users');
  if (!sheet) {
    sheet = ss.insertSheet('Users');
    sheet.appendRow(['username', 'version', 'lastSeen']);
  }

  // Coluna B (version) sempre como Texto simples ANTES de escrever — sem
  // isso o Sheets pode converter algo tipo "1.1.2008" pra Data sozinho
  // (mesmo problema documentado no README pra célula de latestVersion, só
  // que aqui é escrito pelo código a cada check-in, não digitado à mão).
  sheet.getRange('B:B').setNumberFormat('@');

  var data = sheet.getDataRange().getValues();
  var rowIndex = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][0]).trim().toLowerCase() === username.toLowerCase()) {
      rowIndex = i + 1; // linha 1-indexed da planilha (data[i] = linha i+1)
      break;
    }
  }

  var now = new Date().toISOString();
  if (rowIndex === -1) {
    rowIndex = sheet.getLastRow() + 1;
    sheet.getRange(rowIndex, 1).setValue(username);
    sheet.getRange(rowIndex, 2).setValue(version);
    sheet.getRange(rowIndex, 3).setValue(now);
  } else {
    sheet.getRange(rowIndex, 2).setValue(version);
    sheet.getRange(rowIndex, 3).setValue(now);
  }

  return { ok: true };
}

/**
 * Log de erros enviado pelo app (src/lib/errorLog.ts) — uma linha por erro
 * numa aba "Errors" (criada automaticamente com cabeçalho na primeira vez).
 * Diferente da aba "Users", aqui é log mesmo: cada erro vira uma linha nova.
 *
 *   kind = "auto"   -> erro não tratado / crash, enviado sozinho pelo app
 *   kind = "manual" -> usuário clicou em "Report a problem"; todas as linhas
 *                      do mesmo report têm o mesmo reportId e a mesma
 *                      description (o usuário te passa o reportId como
 *                      referência)
 *
 * Mesmo motivo do check-in pra ser GET com query string (ver comentário do
 * recordUserCheckin acima).
 */
var ERROR_HEADERS = [
  'receivedAt', 'reportId', 'kind', 'username', 'version',
  'description', 'occurredAt', 'source', 'message', 'stack',
];

function recordError(params) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('Errors');
  if (!sheet) {
    sheet = ss.insertSheet('Errors');
    sheet.appendRow(ERROR_HEADERS);
    sheet.setFrozenRows(1);
  }

  // Coluna E (version) como Texto simples — mesmo problema de "virar Data"
  // do check-in.
  sheet.getRange('E:E').setNumberFormat('@');

  // Limite de tamanho por célula (evita alguém/algum bug mandar um texto
  // gigante; o Sheets aceita até 50k caracteres por célula).
  function cell(value) {
    return String(value || '').slice(0, 5000);
  }

  sheet.appendRow([
    new Date().toISOString(),
    cell(params.reportId),
    cell(params.kind),
    cell(params.username),
    cell(params.version),
    cell(params.description),
    cell(params.occurredAt),
    cell(params.source),
    cell(params.message),
    cell(params.stack),
  ]);

  return { ok: true };
}

function doGet(e) {
  var params = (e && e.parameter) || {};

  // Log de erro (?errorlog=1&...) — ver recordError acima.
  if (params.errorlog) {
    var errorResult = recordError(params);
    return ContentService
      .createTextOutput(JSON.stringify(errorResult))
      .setMimeType(ContentService.MimeType.JSON);
  }

  // Check-in de uso (?checkin=1&username=...&version=...) — não devolve o
  // status do app, só confirma se gravou.
  if (params.checkin) {
    var result = recordUserCheckin(params.username, params.version);
    return ContentService
      .createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  var rows = sheet.getDataRange().getValues();

  var status = {};
  for (var i = 0; i < rows.length; i++) {
    var key = String(rows[i][0] || '').trim();
    var value = rows[i][1];
    if (!key) continue;

    if (key === 'blocked') {
      var normalized = String(value).trim().toUpperCase();
      status[key] = normalized === 'TRUE';
    } else if (value !== '' && value !== null && value !== undefined) {
      // Rede de segurança: se a célula foi auto-convertida pro tipo Data
      // pelo Sheets (comum com versões tipo "1.1.2008", ver README), String(value)
      // viraria algo tipo "Tue Jan 01 2008 00:00:00 GMT..." e quebraria a
      // comparação de versão. Reconstrói como M.D.YYYY nesse caso — não é
      // garantia de bater com o que foi digitado, então o certo mesmo é
      // formatar a coluna como Texto simples (ver README), mas isso evita
      // quebrar tudo silenciosamente enquanto isso não é corrigido.
      if (Object.prototype.toString.call(value) === '[object Date]') {
        status[key] = (value.getMonth() + 1) + '.' + value.getDate() + '.' + value.getFullYear();
      } else {
        status[key] = String(value);
      }
    }
  }

  return ContentService
    .createTextOutput(JSON.stringify(status))
    .setMimeType(ContentService.MimeType.JSON);
}
