import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import { applySelectedChanges } from '@/lib/applyDiff';
import { diffTrees } from '@/lib/collectionDiff';
import { conflictingIds } from '@/lib/diffSelection';
import { nodeHashes } from '@/lib/syncBase';
import { autoMerge, mergeFieldValues, mergePrefill, mergeText, resolveNode, selectionAfter, type AutoMergeContext } from './autoMerge';

const req = (id: string, patch: Partial<NonNullable<CollectionItem['request']>> = {}, extra: Partial<CollectionItem> = {}): CollectionItem => ({
  id,
  name: id,
  type: 'request',
  method: 'POST',
  request: { url: '/x', urlexport: { host: [], path: [], raw: '/x' }, headers: [], body: '', ...patch },
  ...extra,
});

const folder = (id: string, item: CollectionItem[]): CollectionItem => ({ id, name: id, type: 'folder', item });

/** O mesmo cenário dos três lados: base (última sincronização), aqui e GitHub. */
function scenario(baseTree: CollectionItem[], local: CollectionItem[], remote: CollectionItem[]) {
  const base = nodeHashes(baseTree);
  const nodes = diffTrees(local, remote);
  const find = (items: CollectionItem[], id: string): CollectionItem | undefined => {
    for (const item of items) {
      if (item.id === id) return item;
      const inner = item.item ? find(item.item, id) : undefined;
      if (inner) return inner;
    }
    return undefined;
  };
  const ctx: AutoMergeContext = {
    base,
    conflicts: conflictingIds(nodes, new Set(local.map(r => r.id)), base),
    baseItemOf: node => find(baseTree, node.id) ?? null,
  };
  return { nodes, ctx, base };
}

// O body do print: "Payment Report" (Barramento B2B - Dev / REPORTS / V2).
const PAYMENT_BODY = [
  '{',
  '  "header": {',
  '    "createdBy": "20202020WS"',
  '  },',
  '  "paymentCriteria": {',
  '    "transaction": "Payment",',
  '    "status": "Approved"',
  '  },',
  '  "payments": [',
  '    {',
  '      "method": "Credit",',
  '      "methodCode": "VI",',
  '      "cardEnd": "1111",',
  '      "authorization": "b2b"',
  '    }',
  '  ]',
  '}',
].join('\n');

describe('mergeText', () => {
  it('combines changes on different lines', () => {
    const base = 'a\nb\nc\nd\ne';
    expect(mergeText(base, 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE')).toEqual({ ok: true, text: 'A\nb\nc\nd\nE' });
  });

  it('takes the only side that changed', () => {
    expect(mergeText('a', 'a', 'b')).toEqual({ ok: true, text: 'b' });
    expect(mergeText('a', 'b', 'a')).toEqual({ ok: true, text: 'b' });
    expect(mergeText('a', 'b', 'b')).toEqual({ ok: true, text: 'b' });
  });

  it('combines insertions and deletions in different places', () => {
    const base = '1\n2\n3\n4\n5\n6';
    expect(mergeText(base, '0\n1\n2\n3\n4\n5\n6', '1\n2\n3\n4\n6')).toEqual({ ok: true, text: '0\n1\n2\n3\n4\n6' });
  });

  it('is a conflict when both sides change the same line differently', () => {
    expect(mergeText('a\nb\nc', 'a\nX\nc', 'a\nY\nc')).toEqual({ ok: false });
  });

  it('is a conflict when both sides change adjacent lines (like git)', () => {
    expect(mergeText('a\nb\nc\nd', 'a\nB\nc\nd', 'a\nb\nC\nd')).toEqual({ ok: false });
  });

  it('accepts the same change made on both sides', () => {
    expect(mergeText('a\nb\nc\nd\ne', 'a\nB\nc\nd\nE', 'a\nB\nc\nd\ne')).toEqual({ ok: true, text: 'a\nB\nc\nd\nE' });
  });

  it('treats CRLF as LF and keeps the local line endings', () => {
    expect(mergeText('a\nb\nc\nd', 'A\r\nb\r\nc\r\nd', 'a\nb\nc\nD')).toEqual({ ok: true, text: 'A\r\nb\r\nc\r\nD' });
  });
});

describe('mergeFieldValues', () => {
  it('keeps the markers each side added and drops the ones each side removed', () => {
    expect(mergeFieldValues('markers', ['a', 'b'], ['a', 'b', 'mine'], ['b', 'theirs'])).toEqual({
      ok: true,
      value: ['b', 'theirs', 'mine'],
    });
  });

  it('merges marker notes per marker, and conflicts on the same one', () => {
    expect(mergeFieldValues('markerNotes', {}, { a: 'mine' }, { b: 'theirs' })).toEqual({ ok: true, value: { a: 'mine', b: 'theirs' } });
    expect(mergeFieldValues('markerNotes', { a: 'x' }, { a: 'mine' }, { a: 'theirs' })).toEqual({ ok: false });
  });

  it('merges structured fields line by line only while the result is valid JSON', () => {
    const base = { type: 'bearer', bearer: { token: 'old' }, note: 'x' };
    expect(
      mergeFieldValues('auth', base, { ...base, bearer: { token: 'new' } }, { ...base, type: 'basic' })
    ).toEqual({ ok: true, value: { type: 'basic', bearer: { token: 'new' }, note: 'x' } });
  });

  it('never combines single-value fields', () => {
    expect(mergeFieldValues('url', '/a', '/b', '/c')).toEqual({ ok: false });
  });
});

describe('resolveNode / autoMerge', () => {
  it('combines the two commented lines of the Payment Report body (the case from the screen)', () => {
    const baseItem = req('pay', { body: PAYMENT_BODY }, { name: 'Payment Report' });
    const local = req('pay', { body: PAYMENT_BODY.replace('"authorization": "b2b"', '//"authorization": "b2b"') }, { name: 'Payment Report' });
    const remote = req('pay', { body: PAYMENT_BODY.replace('"transaction": "Payment",', '//"transaction": "Payment",') }, { name: 'Payment Report' });
    const { nodes, ctx } = scenario([baseItem], [local], [remote]);

    expect(nodes).toHaveLength(1);
    const resolution = resolveNode(nodes[0], ctx);
    expect(resolution.kind).toBe('merged');
    if (resolution.kind !== 'merged') return;
    expect(resolution.combined).toEqual(['body']);

    const body = resolution.overrides.body as string;
    expect(body).toContain('//"authorization": "b2b"');
    expect(body).toContain('//"transaction": "Payment",');
    expect(body).not.toMatch(/^\s*"authorization"/m);
    expect(body).not.toMatch(/^\s*"transaction"/m);

    // E é isso que a tela aplica: GitHub marcado + o body combinado por cima.
    const { resolutions } = autoMerge(nodes, ctx);
    const selected = selectionAfter(new Set(), resolutions);
    const [applied] = applySelectedChanges([local], [remote], selected, { pay: resolution.overrides });
    expect(applied.request?.body).toBe(body);
  });

  it('leaves a real conflict when both sides changed the same line', () => {
    const baseItem = req('pay', { body: PAYMENT_BODY });
    const local = req('pay', { body: PAYMENT_BODY.replace('"cardEnd": "1111"', '"cardEnd": "2222"') });
    const remote = req('pay', { body: PAYMENT_BODY.replace('"cardEnd": "1111"', '"cardEnd": "3333"') });
    const { nodes, ctx } = scenario([baseItem], [local], [remote]);

    expect(resolveNode(nodes[0], ctx)).toEqual({ kind: 'conflict', fields: ['body'] });
    expect(autoMerge(nodes, ctx).summary.conflicts).toEqual(['pay']);
  });

  it('combines different fields without needing the base content', () => {
    const baseItem = req('r');
    const local = req('r', { url: '/v2', urlexport: { host: [], path: ['v2'], raw: '/v2' } });
    const remote = req('r', { body: '{"a":1}' });
    const { nodes, ctx } = scenario([baseItem], [local], [remote]);

    expect(resolveNode(nodes[0], { ...ctx, baseItemOf: undefined })).toEqual({
      kind: 'merged',
      overrides: { url: '/v2', urlexport: { host: [], path: ['v2'], raw: '/v2' } },
      mine: ['url'],
      combined: [],
    });
  });

  it('is a conflict when the same body changed on both sides and the base content is unknown', () => {
    const baseItem = req('r', { body: 'a\nb\nc\nd' });
    const { nodes, ctx } = scenario([baseItem], [req('r', { body: 'A\nb\nc\nd' })], [req('r', { body: 'a\nb\nc\nD' })]);
    expect(resolveNode(nodes[0], { ...ctx, baseItemOf: () => undefined })).toEqual({ kind: 'conflict', fields: ['body'] });
  });

  it('keeps GitHub for what changed only there and Mine for what changed only here', () => {
    const baseTree = [req('theirs'), req('mine')];
    const local = [req('theirs'), req('mine', { body: 'mine' })];
    const remote = [req('theirs', { body: 'theirs' }), req('mine')];
    const { nodes, ctx } = scenario(baseTree, local, remote);

    const { resolutions, summary } = autoMerge(nodes, ctx);
    expect(resolutions.get('theirs')).toEqual({ kind: 'github' });
    expect(resolutions.get('mine')).toEqual({ kind: 'mine' });
    expect(summary).toEqual({ github: 1, mine: 1, merged: 0, combined: 0, conflicts: [] });

    const selected = selectionAfter(new Set(['mine']), resolutions);
    expect([...selected]).toEqual(['theirs']);
  });

  it('is a conflict when one side deleted the item and the other changed it', () => {
    const baseTree = [req('r')];
    const { nodes, ctx } = scenario(baseTree, [req('r', { body: 'changed' })], []);
    expect(resolveNode(nodes[0], ctx)).toEqual({ kind: 'conflict', fields: [] });
  });

  it('keeps a conflict untouched in the selection', () => {
    const baseItem = req('r', { body: 'a' });
    const { nodes, ctx } = scenario([baseItem], [req('r', { body: 'b' })], [req('r', { body: 'c' })]);
    const { resolutions } = autoMerge(nodes, ctx);
    expect([...selectionAfter(new Set(['r']), resolutions)]).toEqual(['r']);
    expect([...selectionAfter(new Set(), resolutions)]).toEqual([]);
  });

  it('is a conflict when a setting without its own field changed here and GitHub changed something else', () => {
    const baseItem = req('r');
    const local = req('r', { bodyType: 'graphql' } as Partial<NonNullable<CollectionItem['request']>>);
    const remote = req('r', { body: 'theirs' });
    const { nodes, ctx } = scenario([baseItem], [local], [remote]);
    expect(resolveNode(nodes[0], ctx)).toEqual({ kind: 'conflict', fields: ['~rest'] });
  });

  it('takes the folder order from the side that reordered', () => {
    const baseTree = [folder('f', [req('a'), req('b'), req('c')])];
    const local = [folder('f', [req('a', { body: 'mine' }), req('b'), req('c')])];
    const remote = [folder('f', [req('c'), req('a'), req('b')])];
    const { nodes, ctx } = scenario(baseTree, local, remote);

    const { resolutions } = autoMerge(nodes, ctx);
    expect(resolutions.get('f')).toEqual({ kind: 'github' });
    expect(resolutions.get('a')).toEqual({ kind: 'mine' });
  });
});

describe('mergePrefill (the Merge button)', () => {
  it('starts the Payment Report merge with both commented lines, not with the GitHub body', () => {
    const baseItem = req('pay', { body: PAYMENT_BODY });
    const local = req('pay', { body: PAYMENT_BODY.replace('"authorization": "b2b"', '//"authorization": "b2b"') });
    const remote = req('pay', { body: PAYMENT_BODY.replace('"transaction": "Payment",', '//"transaction": "Payment",') });
    const { nodes, base } = scenario([baseItem], [local], [remote]);

    const prefill = mergePrefill(nodes[0], base, baseItem);
    expect(prefill.combined).toEqual(['body']);
    expect(prefill.conflicts).toEqual([]);
    expect(prefill.overrides.body).toContain('//"authorization": "b2b"');
    expect(prefill.overrides.body).toContain('//"transaction": "Payment",');
  });

  it('marks the field it could not combine, and keeps the fields only I changed', () => {
    const baseItem = req('r', { body: ['a', 'b', 'c'].join('\n') });
    const local = req('r', {
      body: ['a', 'X', 'c'].join('\n'),
      url: '/mine',
      urlexport: { host: [], path: ['mine'], raw: '/mine' },
    });
    const remote = req('r', { body: ['a', 'Y', 'c'].join('\n') });
    const { nodes, base } = scenario([baseItem], [local], [remote]);

    expect(mergePrefill(nodes[0], base, baseItem)).toEqual({
      overrides: { url: '/mine', urlexport: { host: [], path: ['mine'], raw: '/mine' } },
      combined: [],
      conflicts: ['body'],
    });
  });

  it('marks a field changed on both sides as a conflict when the last synced version is unknown', () => {
    const baseItem = req('r', { body: ['a', 'b', 'c', 'd'].join('\n') });
    const { nodes, base } = scenario(
      [baseItem],
      [req('r', { body: ['A', 'b', 'c', 'd'].join('\n') })],
      [req('r', { body: ['a', 'b', 'c', 'D'].join('\n') })]
    );
    expect(mergePrefill(nodes[0], base, undefined)).toEqual({ overrides: {}, combined: [], conflicts: ['body'] });
  });
});

