export function buildFinalUrl(
  rawUrl: string,
  pathParams: any[] = [],
  queryParams: any[] = []
) {
  let url = rawUrl;

  /*
   PATH PARAMS
  */

  pathParams.forEach((param) => {
    if (!param.enabled) return;

    url = url.replace(
      `:${param.key}`,
      param.value
    );
  });

  /*
   QUERY PARAMS
  */

  // A query string que já vier em `url` é só o espelho visual que o
  // ParamsTab mantém sincronizado com `queryParams` pra edição — a fonte de
  // verdade pra montar a URL final é sempre o array `queryParams`. Sem
  // remover a query string antiga aqui, ela ficava duplicada (ex:
  // "?page=1&pageSize=30&page=1&pageSize=30") porque os mesmos params já
  // digitados na URL eram anexados de novo em cima.
  const baseUrl = url.split('?')[0];

  const query = queryParams
    .filter((p) => p.enabled && p.key.trim())
    .map((p) => {
      const safeValue = preserveVariables(
        p.value || ''
      );

      return `${encodeURIComponent(p.key)}=${encodeURIComponent(safeValue)}`;
    })
    .join('&');

  url = query ? `${baseUrl}?${query}` : baseUrl;

  return restoreVariables(url);
}

function preserveVariables(value: string) {
  return value.replace(
    /\{\{(.*?)\}\}/g,
    (_, v) => `__VAR_${v}__`
  );
}

function restoreVariables(value: string) {
  return value.replace(
    /__VAR_(.*?)__/g,
    (_, v) => `{{${v}}}`
  );
}