import { describe, expect, it } from 'vitest';
import {
  PREPARED_EDIT_TTL_MS,
  draftsFromPreparedEdits,
  getPreparedEdit,
  setPreparedEdit,
  takePreparedEdits,
} from './preparedMergeEdits';

const all = () => true;

describe('prepared merge edits store', () => {
  it('keeps, returns and clears an edit', () => {
    setPreparedEdit('a', 'body', 'x', 1000);
    expect(getPreparedEdit('a', 'body', 1001)).toBe('x');
    setPreparedEdit('a', 'body', undefined, 1002);
    expect(getPreparedEdit('a', 'body', 1003)).toBeUndefined();
  });

  it('hands over only the review items, keeping the others', () => {
    setPreparedEdit('a', 'body', 'A', 1000);
    setPreparedEdit('b', 'auth', 'B', 1000);
    expect(takePreparedEdits(id => id === 'a', 1001)).toEqual([{ itemId: 'a', field: 'body', text: 'A' }]);
    expect(getPreparedEdit('a', 'body', 1002)).toBeUndefined();
    expect(takePreparedEdits(all, 1002)).toEqual([{ itemId: 'b', field: 'auth', text: 'B' }]);
  });

  it('expires old edits', () => {
    setPreparedEdit('a', 'body', 'A', 1000);
    expect(getPreparedEdit('a', 'body', 1000 + PREPARED_EDIT_TTL_MS + 1)).toBeUndefined();
    setPreparedEdit('a', 'body', 'A', 1000);
    expect(takePreparedEdits(all, 1000 + PREPARED_EDIT_TTL_MS + 1)).toEqual([]);
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
