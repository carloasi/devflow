import { describe, it, expect } from 'vitest';
import { cloneRequestNode, copyName } from './duplicateRequest';
import type { CollectionItem } from '@/app/types/CollectionItem';

function request(overrides: Partial<CollectionItem> = {}): CollectionItem {
  return {
    id: 'req-1',
    name: 'Gerar token MSAL',
    type: 'request',
    method: 'POST',
    request: {
      url: '{{baseUrl}}/token/:tenant',
      urlexport: {
        host: [],
        path: [],
        raw: '{{baseUrl}}/token/:tenant',
        variable: [{ id: 'var-1', key: 'tenant', value: 'azul', enabled: true }],
      },
      headers: [{ key: 'Content-Type', value: 'application/json', enabled: true }],
      body: '',
      auth: {
        type: 'oauth2',
        oauth2: [
          { key: 'clientSecret', value: 'segredo-de-verdade', enabled: true },
          { key: 'tokenUrl', value: 'https://login.microsoftonline.com/x/token', enabled: true },
          { key: 'grantType', value: 'client_credentials', enabled: true },
        ],
      },
      scripts: { preRequest: '', postResponse: 'pm.environment.set("msal", x)' },
    },
    ...overrides,
  } as CollectionItem;
}

function ids(node: CollectionItem): string[] {
  return [node.id, ...(node.item ?? []).flatMap(ids)];
}

describe('cloneRequestNode', () => {
  // A razão de a ferramenta existir: a leitura via MCP é redigida, então o
  // agente não conseguiria recriar isto sozinho.
  it('copia o segredo do OAuth2, que a leitura mascara', () => {
    const copy = cloneRequestNode(request(), 'Gerar token MSAL copy');
    const secret = copy.request?.auth?.oauth2?.find(e => e.key === 'clientSecret');
    expect(secret?.value).toBe('segredo-de-verdade');
  });

  it('usa o nome passado', () => {
    expect(cloneRequestNode(request(), 'Outro nome').name).toBe('Outro nome');
  });

  it('preserva scripts, headers e método', () => {
    const copy = cloneRequestNode(request(), 'x');
    expect(copy.method).toBe('POST');
    expect(copy.request?.headers[0].value).toBe('application/json');
    expect(copy.request?.scripts?.postResponse).toContain('pm.environment.set');
  });

  describe('ids', () => {
    it('troca o id da request', () => {
      expect(cloneRequestNode(request(), 'x').id).not.toBe('req-1');
    });

    it('troca o id das variáveis de path', () => {
      const copy = cloneRequestNode(request(), 'x');
      expect(copy.request?.urlexport.variable?.[0].id).not.toBe('var-1');
      expect(copy.request?.urlexport.variable?.[0].key).toBe('tenant');
    });

    // Um id repetido não falha na hora: findNodeById devolve o primeiro, e
    // editar a cópia passaria a editar o original.
    it('troca o id dos examples filhos', () => {
      const withExample = request({
        item: [{ id: 'ex-1', name: '200 OK', type: 'example' } as CollectionItem],
      });
      const copy = cloneRequestNode(withExample, 'x');
      expect(ids(copy)).not.toContain('ex-1');
      expect(copy.item?.[0].name).toBe('200 OK');
    });

    it('não repete id dentro da própria cópia', () => {
      const withExamples = request({
        item: [
          { id: 'ex-1', name: 'a', type: 'example' } as CollectionItem,
          { id: 'ex-2', name: 'b', type: 'example' } as CollectionItem,
        ],
      });
      const all = ids(cloneRequestNode(withExamples, 'x'));
      expect(new Set(all).size).toBe(all.length);
    });
  });

  // A cópia entra no fim da pasta; a estrela significa "está no topo".
  it('não herda a marca de favorito', () => {
    const copy = cloneRequestNode(request({ starred: true, starredAfterId: 'outro' }), 'x');
    expect(copy.starred).toBeUndefined();
    expect(copy.starredAfterId).toBeUndefined();
  });

  it('não altera o original', () => {
    const original = request();
    cloneRequestNode(original, 'x');
    expect(original.id).toBe('req-1');
    expect(original.name).toBe('Gerar token MSAL');
    expect(original.request?.urlexport.variable?.[0].id).toBe('var-1');
  });
});

describe('copyName', () => {
  it('acrescenta "copy"', () => {
    expect(copyName('Gerar token', [])).toBe('Gerar token copy');
  });

  // Nome repetido não quebra a árvore (o id identifica), mas quebra o agente:
  // ele localiza request por nome em list_requests/search_requests.
  it('numera quando o nome já existe', () => {
    expect(copyName('Gerar token', ['Gerar token copy'])).toBe('Gerar token copy 2');
    expect(copyName('Gerar token', ['Gerar token copy', 'Gerar token copy 2'])).toBe('Gerar token copy 3');
  });

  it('ignora buracos na sequência', () => {
    expect(copyName('A', ['A copy', 'A copy 3'])).toBe('A copy 2');
  });
});
