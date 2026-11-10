interface TabRequestState {
  isRequesting: boolean;
  startTime: number | null;
  error: string | null;
  isDebugging: boolean;
  debugResult: string | null;
  // Resultado do script desta fase no ÚLTIMO send — null quando não rodou
  // ainda ou rodou sem erro. Por fase, e não um campo só: pre-request e
  // post-response podem falhar em sends diferentes, e a bolinha vermelha da
  // aba Scripts (RequestEditor) precisa indicar QUAL.
  //
  // Fica aqui — estado de EXECUÇÃO — e não dentro de Tab.scripts, que já
  // tinha campos pra isso (preRequestError/postResponseError/*Log) e nunca
  // foram escritos por ninguém: Tab.scripts é o CONTEÚDO salvo do script, e
  // gravar ali passaria por updateTabById, que marca a aba como "não salva"
  // e empilha undo — um script que falha ao enviar não é uma edição do
  // usuário.
  preRequestScriptError: ScriptFailure | null;
  postResponseScriptError: ScriptFailure | null;
}

interface ScriptFailure {
  /** Uma linha, pronta pra tela — ex: "ReferenceError: order is not defined". */
  summary: string;
  /** Texto completo (stack trace, quando houver) pro painel expandido. */
  detail: string;
}
