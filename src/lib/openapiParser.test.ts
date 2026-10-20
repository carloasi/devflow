import { describe, it, expect } from 'vitest';
import { parseOpenApi, detectOpenApiVersion } from './openapiParser';
import type { CollectionItem } from '@/app/types/CollectionItem';

const find = (items: CollectionItem[] | undefined, name: string): CollectionItem | undefined => {
  for (const i of items ?? []) {
    if (i.name === name) return i;
    const deep = find(i.item, name);
    if (deep) return deep;
  }
};

const allRequests = (items: CollectionItem[] | undefined, out: CollectionItem[] = []): CollectionItem[] => {
  for (const i of items ?? []) {
    if (i.type === 'request') out.push(i);
    allRequests(i.item, out);
  }
  return out;
};

const v3 = {
  openapi: '3.0.3',
  info: { title: 'Pedidos API' },
  servers: [{ url: 'https://{env}.exemplo.com/v1', variables: { env: { default: 'api' } } }],
  paths: {
    '/pedidos/{pedidoId}': {
      parameters: [{ name: 'pedidoId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      get: {
        tags: ['Pedidos'],
        summary: 'Busca pedido',
        parameters: [
          { name: 'incluirItens', in: 'query', required: true, schema: { type: 'boolean' } },
          { name: 'X-Correlation-Id', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'opcional', in: 'query', required: false, schema: { type: 'string' } },
        ],
      },
      delete: { tags: ['Pedidos'], operationId: 'removePedido' },
    },
    '/pedidos': {
      post: {
        tags: ['Pedidos'],
        summary: 'Cria pedido',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pedido' } } } },
      },
    },
    '/saude': { get: { tags: ['Infra'], summary: 'Health' } },
  },
  components: {
    schemas: {
      Pedido: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          status: { type: 'string', enum: ['NOVO', 'PAGO'] },
          itens: { type: 'array', items: { $ref: '#/components/schemas/Item' } },
          // Schema que referencia a si mesmo: sem corte, estoura a pilha.
          pai: { $ref: '#/components/schemas/Pedido' },
        },
      },
      Item: {
        allOf: [
          { type: 'object', properties: { sku: { type: 'string' } } },
          { type: 'object', properties: { qtd: { type: 'integer' } } },
        ],
      },
    },
  },
};

describe('detectOpenApiVersion', () => {
  it('reconhece 3.x', () => expect(detectOpenApiVersion(v3)).toBe(3));
  it('reconhece 2.0', () => expect(detectOpenApiVersion({ swagger: '2.0' })).toBe(2));

  // O import usa o conteúdo pra escolher o parser; confundir os dois mandaria
  // uma collection do Postman pro caminho errado.
  it('não confunde com collection do Postman', () => {
    expect(detectOpenApiVersion({ info: { schema: 'postman' }, item: [] })).toBeNull();
  });
});

describe('parseOpenApi — OpenAPI 3', () => {
  const result = parseOpenApi(v3);
  const root = result.collection!;

  it('usa o title como nome da collection', () => expect(root.name).toBe('Pedidos API'));
  it('agrupa por tag', () => {
    expect(root.item!.length).toBe(2);
    expect(root.item!.every(i => i.type === 'folder')).toBe(true);
  });
  it('importa todas as operações', () => expect(allRequests(root.item).length).toBe(4));
  it('resolve variável de servidor pelo default', () => {
    expect(result.variables[0]?.value).toBe('https://api.exemplo.com/v1');
  });

  describe('parâmetros', () => {
    const get = find(root.item, 'Busca pedido')!;

    it('converte {id} para a notação :id do app', () => expect(get.request!.url).toContain('/pedidos/:pedidoId'));
    it('inclui query obrigatória na URL', () => expect(get.request!.url).toContain('incluirItens='));
    it('deixa query opcional de fora', () => expect(get.request!.url).not.toContain('opcional='));
    it('cria o header declarado', () => {
      expect(get.request!.headers.some(h => h.key === 'X-Correlation-Id')).toBe(true);
    });
    it('não inventa corpo em GET', () => expect(get.request!.bodyType).toBe('none'));

    it('herda parâmetro declarado no path-item', () => {
      expect(find(root.item, 'removePedido')!.request!.url).toContain(':pedidoId');
    });
  });

  describe('corpo gerado do schema', () => {
    const body = JSON.parse(find(root.item, 'Cria pedido')!.request!.body!);

    it('segue o $ref', () => expect(body).toHaveProperty('id'));
    it('usa o primeiro valor do enum', () => expect(body.status).toBe('NOVO'));
    it('respeita o format uuid', () => expect(body.id).toBe('00000000-0000-0000-0000-000000000000'));
    it('combina allOf em vez de pegar só o primeiro ramo', () => {
      expect(body.itens[0]).toHaveProperty('sku');
      expect(body.itens[0]).toHaveProperty('qtd');
    });
    it('corta schema recursivo sem estourar a pilha', () => expect(body.pai).toBeDefined());
  });
});

describe('parseOpenApi — Swagger 2.0', () => {
  const v2 = {
    swagger: '2.0',
    info: { title: 'Legado' },
    schemes: ['https'],
    host: 'legado.exemplo.com',
    basePath: '/api',
    paths: {
      '/clientes': {
        post: {
          tags: ['Clientes'],
          summary: 'Cria cliente',
          parameters: [{ name: 'corpo', in: 'body', schema: { $ref: '#/definitions/Cliente' } }],
        },
      },
    },
    definitions: { Cliente: { type: 'object', properties: { nome: { type: 'string' } } } },
  };
  const result = parseOpenApi(v2);

  it('monta a base com schemes + host + basePath', () => {
    expect(result.variables[0]?.value).toBe('https://legado.exemplo.com/api');
  });
  it('lê corpo de in:body com $ref de definitions', () => {
    expect(JSON.parse(find(result.collection!.item, 'Cria cliente')!.request!.body!)).toHaveProperty('nome');
  });

  // Uma pasta com um filho só é ruído na árvore.
  it('não cria pasta quando há uma tag só', () => {
    expect(result.collection!.item![0].type).toBe('request');
  });
});

describe('parseOpenApi — entradas inválidas', () => {
  it('rejeita documento que não é OpenAPI', () => expect(parseOpenApi({ foo: 1 }).collection).toBeNull());
  it('rejeita documento sem paths', () => {
    expect(parseOpenApi({ openapi: '3.0.0', paths: {} }).collection).toBeNull();
  });
  it('rejeita path sem operação', () => {
    expect(parseOpenApi({ openapi: '3.0.0', paths: { '/x': {} } }).collection).toBeNull();
  });

  it('importa mesmo sem servidor, avisando', () => {
    const r = parseOpenApi({ openapi: '3.0.0', info: { title: 'X' }, paths: { '/a': { get: {} } } });
    expect(r.collection).not.toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});
