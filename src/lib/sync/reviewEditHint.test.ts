import { describe, expect, it } from 'vitest';
import { REVIEW_EDIT_HINT_TTL_MS, requestReviewEdit, takeReviewEdit } from './reviewEditHint';

const has = (...ids: string[]) => (id: string) => ids.includes(id);

describe('reviewEditHint', () => {
  it('returns the hint once, for an item in the review', () => {
    requestReviewEdit({ itemId: 'a', field: 'auth' }, 1000);
    expect(takeReviewEdit(has('a'), 2000)).toEqual({ itemId: 'a', field: 'auth' });
    expect(takeReviewEdit(has('a'), 2000)).toBeNull();
  });

  it('drops a hint for an item the review does not have', () => {
    requestReviewEdit({ itemId: 'a', field: 'body' }, 1000);
    expect(takeReviewEdit(has('b'), 2000)).toBeNull();
    // consumed even so: it must not leak into a later review
    expect(takeReviewEdit(has('a'), 2000)).toBeNull();
  });

  it('expires', () => {
    requestReviewEdit({ itemId: 'a', field: 'body' }, 1000);
    expect(takeReviewEdit(has('a'), 1000 + REVIEW_EDIT_HINT_TTL_MS + 1)).toBeNull();
  });

  it('keeps only the latest hint', () => {
    requestReviewEdit({ itemId: 'a', field: 'body' }, 1000);
    requestReviewEdit({ itemId: 'b', field: 'url' }, 1001);
    expect(takeReviewEdit(has('a', 'b'), 1002)).toEqual({ itemId: 'b', field: 'url' });
  });
});
