import { contentPrint } from './githubStorage';

// ─────────────────────────────────────────────────────────────────────────
// "Quem mudou" pelo CONTEÚDO, não pelo último commit do arquivo.
//
// Uma versão do app sem a correção que pula arquivo igual regrava TODOS os
// arquivos do workspace a cada push (a cifra sorteia o IV): o último commit
// de cada collection passava a ser de quem enviou qualquer coisa por último.
// Aqui os commits são percorridos do mais novo pro mais antigo, e vale o
// primeiro cujo conteúdo é diferente do anterior a ele — o que mudou de
// verdade. Sem conseguir ler uma versão, fica o commit em que parou (o
// comportamento de antes).
// ─────────────────────────────────────────────────────────────────────────

/** Quantas versões do arquivo, no máximo, são lidas pra achar a mudança. */
export const WHO_CHANGED_MAX_READS = 6;

export async function firstRealChange<C extends { sha: string }>(
  commits: C[],
  read: (sha: string) => Promise<unknown | null>,
  maxReads = WHO_CHANGED_MAX_READS
): Promise<C | null> {
  if (commits.length === 0) return null;
  let reads = 0;
  const printOf = async (commit: C): Promise<string | null> => {
    reads++;
    const content = await read(commit.sha);
    return content === null || content === undefined ? null : contentPrint(content);
  };

  let newer = await printOf(commits[0]);
  for (let i = 0; i < commits.length - 1; i++) {
    // Sem ler a versão (ou acabou a cota de leituras): fica este commit.
    if (newer === null || reads >= maxReads) return commits[i];
    const older = await printOf(commits[i + 1]);
    if (older === null || older !== newer) return commits[i];
    newer = older;
  }
  // O mais antigo da lista: ou o arquivo nasceu nele, ou a lista acabou.
  return commits[commits.length - 1];
}
