// ─────────────────────────────────────────────────────────────────────────
// Realce de {{variavel}} dentro de um editor Monaco.
//
// Nasceu dentro do HttpBodyEditor e saiu pra cá quando os blocos de Payload
// e Response do Collection Runner passaram a usar o mesmo editor: o realce
// tem que ser o MESMO nos dois lugares, senão a mesma variável aparece de um
// jeito na request e de outro no resultado do run.
// ─────────────────────────────────────────────────────────────────────────

export const VAR_REGEX = /\{\{[^{}]+\}\}/g;

// Uma cópia nova a cada chamada. Um /g compartilhado carrega `lastIndex`
// entre quem o usa, então duas varreduras intercaladas pulariam ocorrências
// uma da outra — e zerar o `lastIndex` do módulo durante um render é
// justamente o que a regra de imutabilidade do React Compiler proíbe.
export function scanVars(text: string): { key: string; start: number; end: number }[] {
  const re = new RegExp(VAR_REGEX.source, 'g');
  const out: { key: string; start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    out.push({
      key: match[0].replace(/[{}]/g, '').trim(),
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  return out;
}

const VAR_STYLE_ID = 'http-body-var-highlight-style';

export interface TrackedVarRange {
  key: string;
  start: number; // offset no texto do model
  end: number;
}

// Injeta o CSS das decorações uma única vez por documento. É <style> no head
// em vez de classe do Tailwind porque o Monaco monta esses spans fora da
// árvore do React, e o scanner do Tailwind não veria a classe em lugar
// nenhum do código.
export function ensureVarHighlightStyle() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(VAR_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = VAR_STYLE_ID;
  style.textContent = `
    /* O Monaco quebra "{{minhaVar}}" em vários tokens ({, {, nome, }, }) e
       desenha um <span> por token, aplicando a classe da decoração em TODOS.
       Por isso nada aqui pode fechar uma borda: um contorno completo
       (box-shadow 0 0 0 1px) vira um anel em volta de cada pedaço, e o
       border-radius arredonda cada fatia — o realce aparecia repartido.
       Só fundo e linhas horizontais, que emendam entre spans vizinhos e
       leem como um destaque contínuo. */
    .body-var-found {
      background-color: rgba(60,137,224,0.24);
      color: #74b3ff !important;
      font-weight: 700;
      cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(60,137,224,0.5),
        inset 0 -1px 0 rgba(60,137,224,0.5);
    }
    .body-var-missing {
      background-color: rgba(224,108,117,0.22);
      color: #f28b8b !important;
      font-weight: 700;
      cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(224,108,117,0.5),
        inset 0 -1px 0 rgba(224,108,117,0.5);
    }
    /* Pisca depois de gravar, no mesmo verde do resto do app. */
    .body-var-saved {
      background-color: rgba(79,240,157,0.22);
      color: #4ff09d !important;
      font-weight: 700;
      cursor: pointer;
      box-shadow:
        inset 0 1px 0 rgba(79,240,157,0.5),
        inset 0 -1px 0 rgba(79,240,157,0.5);
    }
  `;
  document.head.appendChild(style);
}

// Clique "dentro" de uma {{variavel}}: o cursor tem que cair entre o "{{" e
// o "}}" (contando as bordas internas). Clicar no "{" ou "}" de fora — ou
// logo depois do token — só posiciona o cursor, pra dar pra editar ali sem
// o popover abrir na frente.
export function findVarAtOffset(
  ranges: TrackedVarRange[],
  offset: number
): TrackedVarRange | undefined {
  return ranges.find(r => offset >= r.start + 2 && offset <= r.end - 2);
}
