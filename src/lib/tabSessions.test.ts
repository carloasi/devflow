import { describe, it, expect } from 'vitest';
import { stripTabForSession, stripTabsForSession, sameSessionTabs } from './tabSessions';
import type { Tab } from '@/app/types/Tab';

const tab = (patch: Partial<Tab> = {}): Tab =>
  ({
    id: 'r1',
    name: 'Request',
    kind: 'request',
    method: 'GET',
    urlInput: '{{base}}/api',
    requestBodyValue: '{"a":1}',
    requestHeadersValue: [],
    response: null,
    ...patch,
  }) as Tab;

const umaResposta = { status: 200, parsedBody: { x: 'y'.repeat(2000) } } as never;

describe('stripTabForSession', () => {
  // 63% do arquivo de sessões era resposta guardada que ninguém lia.
  it('tira a resposta', () => {
    const out = stripTabForSession(tab({ response: umaResposta }));
    expect(out.response).toBeNull();
  });

  it('tira tempo e resultado de teste', () => {
    const out = stripTabForSession(
      tab({ responseTime: 812, testResults: [{ name: 't', passed: true }] as never })
    );
    expect('responseTime' in out).toBe(false);
    expect('testResults' in out).toBe(false);
  });

  // O que importa é a request pronta pra enviar — isso tem que sobreviver.
  it('preserva o conjunto de trabalho', () => {
    const out = stripTabForSession(tab({ response: umaResposta }));
    expect(out).toMatchObject({
      id: 'r1',
      name: 'Request',
      urlInput: '{{base}}/api',
      requestBodyValue: '{"a":1}',
    });
  });

  it('não altera a aba recebida', () => {
    const original = tab({ response: umaResposta, responseTime: 10 });
    stripTabForSession(original);
    expect(original.response).toBe(umaResposta);
    expect(original.responseTime).toBe(10);
  });

  it('aba que já não tem resposta passa igual', () => {
    const out = stripTabForSession(tab());
    expect(out.response).toBeNull();
  });

  it('encolhe de verdade', () => {
    const cheia = JSON.stringify(tab({ response: umaResposta })).length;
    const limpa = JSON.stringify(stripTabForSession(tab({ response: umaResposta }))).length;
    expect(limpa).toBeLessThan(cheia / 2);
  });
});

describe('stripTabsForSession', () => {
  it('aplica em todas', () => {
    const out = stripTabsForSession([tab({ response: umaResposta }), tab({ id: 'r2' })]);
    expect(out.every(t => t.response === null)).toBe(true);
    expect(out.map(t => t.id)).toEqual(['r1', 'r2']);
  });

  it('lista vazia', () => {
    expect(stripTabsForSession([])).toEqual([]);
  });
});

describe('sameSessionTabs', () => {
  // O ponto da extração: gravação e comparação usando a MESMA forma. Antes
  // discordavam, e por isso o arquivo inchava sem que a tela acusasse nada.
  it('resposta diferente não conta como alteração', () => {
    const a = [tab({ response: umaResposta })];
    const b = [tab({ response: null })];
    expect(sameSessionTabs(a, b)).toBe(true);
  });

  it('mudar a URL conta', () => {
    expect(sameSessionTabs([tab()], [tab({ urlInput: '{{base}}/outro' })])).toBe(false);
  });

  it('mudar o corpo conta', () => {
    expect(sameSessionTabs([tab()], [tab({ requestBodyValue: '{"a":2}' })])).toBe(false);
  });

  it('quantidade diferente conta', () => {
    expect(sameSessionTabs([tab()], [tab(), tab({ id: 'r2' })])).toBe(false);
  });

  it('duas listas vazias são iguais', () => {
    expect(sameSessionTabs([], [])).toBe(true);
  });

  it('ordem diferente conta — a ordem das abas é visível', () => {
    const a = [tab({ id: 'r1' }), tab({ id: 'r2' })];
    const b = [tab({ id: 'r2' }), tab({ id: 'r1' })];
    expect(sameSessionTabs(a, b)).toBe(false);
  });
});
