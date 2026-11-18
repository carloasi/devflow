import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import type { Environment } from '@/app/types/Environment';
import { discardEnvironmentChange, discardLocalChange, itemText, namePathIn } from './discardChange';
import { buildSyncOverview, withContentPreviews } from './syncOverview';
import { rebaseCollections } from './rebase';
import { nodeHashes } from '@/lib/syncBase';

const req = (id: string, url = '/x', body = ''): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'POST',
  request: { url, urlexport: { host: [], path: [], raw: url }, headers: [{ key: 'X-App', value: 'devflow', enabled: true }], body, bodyType: body ? 'raw' : 'none' },
});
const folder = (id: string, items: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item: items });
const ids = (tree: CollectionItem[]): string[] =>
  tree.flatMap(i => [i.id, ...(i.item ? ids(i.item) : [])]);

describe('discardLocalChange', () => {
  const remote = [folder('Settings', [folder('FiltersIp', [req('ListFilters')]), req('Other', '/other')])];

  it('item novo daqui é apagado', () => {
    const local = [folder('Settings', [folder('FiltersIp', [req('ListFilters'), req('AddFilter')]), req('Other', '/other')])];
    const { tree, action } = discardLocalChange(local, remote, 'AddFilter');
    expect(action).toBe('deleted');
    expect(ids(tree)).toEqual(ids(remote));
  });

  it('item alterado volta ao conteúdo do GitHub', () => {
    const local = [folder('Settings', [folder('FiltersIp', [req('ListFilters', '/mudei')]), req('Other', '/other')])];
    const { tree, action } = discardLocalChange(local, remote, 'ListFilters');
    expect(action).toBe('reverted');
    expect(tree).toEqual(remote);
  });

  it('item apagado aqui volta, no lugar de lá', () => {
    const local = [folder('Settings', [folder('FiltersIp', []), req('Other', '/other')])];
    const { tree, action } = discardLocalChange(local, remote, 'ListFilters');
    expect(action).toBe('restored');
    expect(tree).toEqual(remote);
  });

  it('item movido volta pra pasta de lá', () => {
    const local = [folder('Settings', [folder('FiltersIp', []), req('Other', '/other'), req('ListFilters')])];
    const { tree } = discardLocalChange(local, remote, 'ListFilters');
    expect(tree).toEqual(remote);
  });

  it('pasta volta inteira, sem duplicar o filho que aqui foi movido pra fora', () => {
    const local = [folder('Settings', [folder('FiltersIp', [req('Novo')]), req('Other', '/other'), req('ListFilters')])];
    const { tree } = discardLocalChange(local, remote, 'FiltersIp');
    expect(ids(tree).filter(id => id === 'ListFilters')).toHaveLength(1);
    expect(tree).toEqual(remote);
  });
});

describe('discardEnvironmentChange', () => {
  const env = (vals: Record<string, string>): Environment[] => [
    { id: 'e1', name: '5by5', values: Object.entries(vals).map(([key, value]) => ({ key, value, enabled: true, type: 'default' })) },
  ];
  const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln';

  it('a variável volta ao valor do GitHub e o resto fica', () => {
    const local = env({ url: 'https://novo', other: 'a', bearerToken: JWT });
    const remote = env({ url: 'https://antigo', other: 'b', bearerToken: '' });
    const out = discardEnvironmentChange(local, remote, '5by5 › url')[0].values;
    expect(Object.fromEntries(out.map(v => [v.key, v.value]))).toEqual({ url: 'https://antigo', other: 'a', bearerToken: JWT });
  });
});

describe('prévia de itens novos e movidos', () => {
  it('item novo ganha o conteúdo inteiro; movido ganha os dois caminhos', () => {
    const synced = [folder('S', [folder('A', [req('m')]), folder('B', [])])];
    const local = [folder('S', [folder('A', [req('novo', '/filters', '{"ip":"1.2.3.4"}')]), folder('B', [req('m')])])];
    const result = rebaseCollections(local, synced, nodeHashes(synced), new Set(['S']));
    const overview = withContentPreviews(
      buildSyncOverview(result, { incomingNames: [], outgoingNames: [], keptMineNames: [] }),
      local,
      synced
    );
    const novo = overview.outgoing.find(i => i.id === 'novo')!;
    expect(novo.existsHere).toBe(true);
    expect(novo.kind).toBe('request');
    expect(novo.fields[0].before).toContain('POST /filters');
    expect(novo.fields[0].before).toContain('"ip": "1.2.3.4"');
    expect(novo.fields[0].after).toBe('');
    const moved = overview.outgoing.find(i => i.id === 'm')!;
    expect(moved.change).toBe('moved');
    expect(moved.localPath).toEqual(['S', 'B', 'm']);
    expect(moved.remotePath).toEqual(['S', 'A', 'm']);
    // Agrupado na collection certa, com o caminho inteiro.
    expect(moved.rootId).toBe('S');
    expect(moved.path).toEqual(['S', 'B', 'm']);
  });

  it('pasta nova do GitHub traz o detalhe de cada request de dentro', () => {
    const synced = [folder('S', [])];
    const remote = [folder('S', [folder('v2', [req('r1', '/payment', '{"a":1}'), folder('sub', [req('r2', '/sales')])])])];
    const result = rebaseCollections(synced, remote, nodeHashes(synced), new Set());
    const overview = withContentPreviews(
      buildSyncOverview(result, { incomingNames: [], outgoingNames: [], keptMineNames: [] }),
      synced,
      remote
    );
    const v2 = overview.incoming.find(i => i.id === 'v2')!;
    expect(v2.requests?.map(r => r.path)).toEqual([['r1'], ['sub', 'r2']]);
    expect(v2.requests?.[0].before).toBe('');
    expect(v2.requests?.[0].after).toContain('POST /payment');
    expect(v2.requests?.[0].after).toContain('"a": 1');
  });

  it('request movida pra dentro da pasta nova não aparece como nova', () => {
    const synced = [folder('S', [req('m', '/same'), req('e', '/old')])];
    const remote = [folder('S', [folder('v2', [req('m', '/same'), req('e', '/new'), req('n', '/fresh')])])];
    const result = rebaseCollections(synced, remote, nodeHashes(synced), new Set());
    const overview = withContentPreviews(
      buildSyncOverview(result, { incomingNames: [], outgoingNames: [], keptMineNames: [] }),
      synced,
      remote
    );
    const v2 = overview.incoming.find(i => i.id === 'v2')!;
    // Só mudou de lugar: fora. Mudou de lugar e de URL: o diff contra a daqui. Nova: inteira.
    expect(v2.requests?.map(r => r.id)).toEqual(['e', 'n']);
    expect(v2.requests?.[0].before).toContain('POST /old');
    expect(v2.requests?.[0].after).toContain('POST /new');
    expect(v2.requests?.[1].before).toBe('');
  });

  it('namePathIn e itemText de pasta', () => {
    const tree = [folder('S', [folder('A', [req('r1')])])];
    expect(namePathIn(tree, 'r1')).toEqual(['S', 'A', 'r1']);
    expect(itemText(tree[0])).toBe('📁 A\n  POST r1');
  });
});

describe('payload na prévia', () => {
  it('mostra o body formatado, os path params e avisa quando o tipo é "none"', () => {
    const post: CollectionItem = {
      id: 'p', name: 'AddFilter', type: 'request', method: 'POST',
      request: {
        url: '{{base}}/filters/:id',
        urlexport: { host: [], path: [], raw: '', variable: [{ id: 'v', key: 'id', value: '7', enabled: true }] },
        headers: [], body: '{"ip":"1.2.3.4","enabled":true}', bodyType: 'raw',
      },
    };
    const text = itemText(post);
    expect(text).toContain('Path params:\n  id = 7');
    expect(text).toContain('Body (raw):\n{\n  "ip": "1.2.3.4",\n  "enabled": true\n}');
    expect(itemText({ ...post, request: { ...post.request!, bodyType: 'none' } })).toContain('Body (type "none" — kept, not sent):');
  });

  it('request alterada ganha a request completa dos dois lados, com o payload', () => {
    const synced = [folder('S', [req('r', '/x', '{"a":1}')])];
    const local = [folder('S', [req('r', '/y', '{"a":1}')])];
    const result = rebaseCollections(local, synced, nodeHashes(synced), new Set(['S']));
    const overview = withContentPreviews(
      buildSyncOverview(result, { incomingNames: [], outgoingNames: [], keptMineNames: [] }),
      local,
      synced
    );
    const item = overview.outgoing.find(i => i.id === 'r')!;
    const content = item.fields.find(f => f.field === 'content')!;
    expect(content.before).toContain('POST /y');
    expect(content.before).toContain('"a": 1');
    expect(content.after).toContain('POST /x');
  });
});

describe('descartar dentro de pasta apagada aqui', () => {
  it('a pasta volta vazia e só o item entra nela', () => {
    const remote = [folder('S', [folder('F', [req('child'), req('other')]), req('keep')])];
    const local = [folder('S', [req('keep')])];
    const { tree, action } = discardLocalChange(local, remote, 'child');
    expect(action).toBe('restored');
    expect(ids(tree)).toEqual(['S', 'F', 'child', 'keep']);
  });

  it('a prévia diz quantas requests voltam com a pasta apagada', () => {
    const synced = [folder('S', [folder('F', [req('a'), req('b')])])];
    const local = [folder('S', [])];
    const result = rebaseCollections(local, synced, nodeHashes(synced), new Set(['S']));
    const overview = withContentPreviews(
      buildSyncOverview(result, { incomingNames: [], outgoingNames: [], keptMineNames: [] }),
      local,
      synced
    );
    // Pasta apagada aparece sozinha (os filhos vão junto com ela).
    const deletedFolder = overview.outgoing.find(i => i.id === 'F')!;
    expect(deletedFolder.change).toBe('deleted');
    expect(deletedFolder.insideRequests).toBe(2);
    // A collection onde ela fica existe aqui: não há pasta a recriar.
    expect(deletedFolder.missingParent).toBeUndefined();
  });

  it('collection nova conta as requests que vão ser apagadas', () => {
    const local = [folder('Nova', [folder('P', [req('x'), req('y')]), req('z')])];
    const result = rebaseCollections(local, [], {}, new Set(['Nova']));
    const overview = withContentPreviews(
      buildSyncOverview(result, { incomingNames: [], outgoingNames: [], keptMineNames: [] }),
      local,
      []
    );
    const root = overview.outgoing.find(i => i.id === 'Nova')!;
    expect(root.change).toBe('new');
    expect(root.insideRequests).toBe(3);
  });
});
