import { describe, it, expect } from 'vitest';
import {
  buildPushPlan,
  collectionFilePath,
  environmentFilePath,
  pushCommitMessage,
  sanitizeFileName,
} from './pushPlan';

const ws = 'Postman/Time';

describe('nomes de arquivo', () => {
  it('sanitiza igual em todo lugar', () => {
    expect(sanitizeFileName("API's Tests")).toBe('api-s-tests');
    expect(sanitizeFileName(undefined)).toBe('collection');
  });

  it('collection aceita name e info.name (formato Postman)', () => {
    expect(collectionFilePath(ws, { name: 'Pedidos' })).toBe(`${ws}/pedidos.postman_collection.json`);
    expect(collectionFilePath(ws, { info: { name: 'Pedidos' } })).toBe(`${ws}/pedidos.postman_collection.json`);
  });

  it('environment vai pra subpasta, e sem nome tem nome padrão', () => {
    expect(environmentFilePath(ws, { name: 'Dev QA' })).toBe(`${ws}/environments/dev-qa.postman_environment.json`);
    expect(environmentFilePath(ws, {})).toBe(`${ws}/environments/environment.postman_environment.json`);
  });
});

describe('buildPushPlan', () => {
  const base = {
    wsRemotePath: ws,
    collections: [{ id: 'c1', name: 'Pedidos', type: 'folder', starred: true }],
    environments: [{ id: 'e1', name: 'Dev' }],
    markers: [],
    existingPaths: [] as string[],
  };

  it('planeja collections, environments e o catálogo', () => {
    const plan = buildPushPlan(base);
    expect(plan.files.map((f) => [f.kind, f.path])).toEqual([
      ['collection', `${ws}/pedidos.postman_collection.json`],
      ['environment', `${ws}/environments/dev.postman_environment.json`],
      ['markers', `${ws}/devflow-markers.json`],
    ]);
    expect(plan.collisions).toEqual([]);
  });

  it('não sobe a marca de favorito', () => {
    const plan = buildPushPlan(base);
    expect((plan.files[0].content as { starred?: boolean }).starred).toBeUndefined();
  });

  it('sem catálogo quando markers é null', () => {
    expect(buildPushPlan({ ...base, markers: null }).files.some((f) => f.kind === 'markers')).toBe(false);
  });

  it('acusa nomes que viram o mesmo arquivo — em collections e environments', () => {
    const plan = buildPushPlan({
      ...base,
      collections: [{ name: "API's Tests" }, { name: 'API S Tests' }],
      environments: [{ name: 'Dev QA' }, { name: 'dev-qa' }],
    });
    expect(plan.collisions).toEqual([
      { kind: 'collection', names: ["API's Tests", 'API S Tests'] },
      { kind: 'environment', names: ['Dev QA', 'dev-qa'] },
    ]);
  });

  it('o que está no GitHub e não corresponde a nada daqui é obsoleto', () => {
    const plan = buildPushPlan({
      ...base,
      existingPaths: [
        `${ws}/pedidos.postman_collection.json`,
        `${ws}/antiga.postman_collection.json`,
        `${ws}/environments/prod.postman_environment.json`,
      ],
    });
    expect(plan.stalePaths).toEqual([
      `${ws}/antiga.postman_collection.json`,
      `${ws}/environments/prod.postman_environment.json`,
    ]);
  });
});

describe('pushCommitMessage', () => {
  it('resume o push num commit só', () => {
    const plan = buildPushPlan({
      wsRemotePath: ws,
      collections: [{ name: 'A' }, { name: 'B' }],
      environments: [{ name: 'Dev' }],
      markers: [],
      existingPaths: [],
    });
    expect(pushCommitMessage('Time', plan, 1)).toBe('sync(Time): 2 collection(s), 1 environment(s), 1 file(s) removed');
    expect(pushCommitMessage('Time', plan, 0)).toBe('sync(Time): 2 collection(s), 1 environment(s)');
  });
});
