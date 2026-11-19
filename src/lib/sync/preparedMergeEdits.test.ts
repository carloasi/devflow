import { describe, expect, it } from 'vitest';
import {
  PREPARED_EDIT_TTL_MS,
  clearPreparedEdits,
  draftsFromPreparedEdits,
  getPreparedEdit,
  preparedEditStamp,
  preparedEditsFor,
  setPreparedEdit,
} from './preparedMergeEdits';

const stampA = preparedEditStamp('mine', 'theirs');
/** Revisão em que todo item/campo está, com as mesmas versões da prévia. */
const sameVersions = () => stampA;

describe('prepared merge edits store', () => {
  it('keeps, returns and clears an edit', () => {
    setPreparedEdit('a', 'body', 'x', {}, 1000);
    expect(getPreparedEdit('a', 'body', {}, 1001)).toBe('x');
    setPreparedEdit('a', 'body', undefined, {}, 1002);
    expect(getPreparedEdit('a', 'body', {}, 1003)).toBeUndefined();
  });

  it('hands over the review items without removing them; applying clears them', () => {
    setPreparedEdit('a', 'body', 'A', { workspace: 'w', stamp: stampA }, 1000);
    setPreparedEdit('b', 'auth', 'B', { workspace: 'w', stamp: stampA }, 1000);
    const onlyA = (id: string) => (id === 'a' ? stampA : undefined);
    expect(preparedEditsFor('w', onlyA, 1001)).toEqual([{ itemId: 'a', field: 'body', text: 'A' }]);
    // Fechar a revisão sem aplicar: a edição continua lá.
    expect(preparedEditsFor('w', onlyA, 1002)).toHaveLength(1);
    clearPreparedEdits('w', ['a']);
    expect(preparedEditsFor('w', onlyA, 1003)).toEqual([]);
    expect(preparedEditsFor('w', sameVersions, 1003)).toEqual([{ itemId: 'b', field: 'auth', text: 'B' }]);
    clearPreparedEdits('w', ['b']);
  });

  it('drops an edit made over versions that changed since (the colleague pushed again)', () => {
    setPreparedEdit('a', 'body', 'A', { workspace: 'w', stamp: stampA }, 1000);
    const changed = preparedEditStamp('mine', 'theirs-v2');
    expect(preparedEditsFor('w', () => changed, 1001)).toEqual([]);
    // Descartada de vez: não volta nem com as versões antigas.
    expect(preparedEditsFor('w', sameVersions, 1002)).toEqual([]);
    expect(getPreparedEdit('a', 'body', { workspace: 'w', stamp: changed }, 1002)).toBeUndefined();
  });

  it('the stamp ignores CRLF vs LF', () => {
    expect(preparedEditStamp('a\r\nb', 'c')).toBe(preparedEditStamp('a\nb', 'c'));
  });

  it("does not hand another workspace's edit to this review", () => {
    setPreparedEdit('a', 'body', 'A', { workspace: 'w1', stamp: stampA }, 1000);
    expect(preparedEditsFor('w2', sameVersions, 1001)).toEqual([]);
    clearPreparedEdits('w2', ['a']);
    expect(preparedEditsFor('w1', sameVersions, 1002)).toHaveLength(1);
    clearPreparedEdits('w1', ['a']);
  });

  it('expires old edits', () => {
    setPreparedEdit('a', 'body', 'A', {}, 1000);
    expect(getPreparedEdit('a', 'body', {}, 1000 + PREPARED_EDIT_TTL_MS + 1)).toBeUndefined();
    setPreparedEdit('a', 'body', 'A', {}, 1000);
    expect(preparedEditsFor(undefined, sameVersions, 1000 + PREPARED_EDIT_TTL_MS + 1)).toEqual([]);
  });
});

describe('draftsFromPreparedEdits', () => {
  const node = {
    fields: [
      { field: 'body', local: '{"a":1}' },
      { field: 'auth', local: { type: 'bearer' } },
      { field: 'order', local: ['x'] },
    ],
  };
  const options = {
    isEditable: (f: string) => f !== 'order',
    format: (_f: string, v: unknown) => (typeof v === 'string' ? v : JSON.stringify(v)),
    inMine: () => false,
    canEditFromMine: () => true,
  };

  it('accepted from GitHub: only the edited field becomes a draft', () => {
    const out = draftsFromPreparedEdits([{ itemId: 'n', field: 'body', text: 'edited' }], () => node, options);
    expect(out).toEqual({ n: { body: 'edited' } });
  });

  it('in Mine: the other editable fields start with the local value', () => {
    const out = draftsFromPreparedEdits([{ itemId: 'n', field: 'body', text: 'edited' }], () => node, {
      ...options,
      inMine: () => true,
    });
    expect(out).toEqual({ n: { body: 'edited', auth: '{"type":"bearer"}' } });
  });

  it('skips what cannot be applied', () => {
    const edits = [
      { itemId: 'gone', field: 'body', text: 'x' },
      { itemId: 'n', field: 'order', text: 'x' },
      { itemId: 'n', field: 'url', text: 'x' },
    ];
    expect(draftsFromPreparedEdits(edits, id => (id === 'n' ? node : undefined), options)).toEqual({});
    expect(
      draftsFromPreparedEdits([{ itemId: 'n', field: 'body', text: 'x' }], () => node, {
        ...options,
        inMine: () => true,
        canEditFromMine: () => false,
      })
    ).toEqual({});
  });

  it('keeps two edits of the same item', () => {
    const out = draftsFromPreparedEdits(
      [
        { itemId: 'n', field: 'body', text: 'b' },
        { itemId: 'n', field: 'auth', text: 'a' },
      ],
      () => node,
      options
    );
    expect(out).toEqual({ n: { body: 'b', auth: 'a' } });
  });
});
