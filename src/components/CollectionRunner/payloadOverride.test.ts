import { describe, expect, it } from 'vitest';
import type { CollectionItem } from '@/app/types/CollectionItem';
import {
  applyBodyOverride,
  applyEnvChanges,
  effectiveBodyOverride,
  isBodyEdited,
  prettyBodyPreservingTemplates,
} from './payloadOverride';

const original = '{"Journeys":[{"Origin":"REC","Destination":"CGH","Departure":"2026-11-17T00:00:00"}],"token":"{{bearer}}"}';

describe('prettyBodyPreservingTemplates', () => {
  it('reindents JSON keeping quoted and unquoted {{vars}} intact', () => {
    const out = prettyBodyPreservingTemplates('{"a":"{{x}}","n":{{count}}}');
    expect(out).toBe('{\n  "a": "{{x}}",\n  "n": {{count}}\n}');
  });

  it('returns non-JSON text untouched', () => {
    expect(prettyBodyPreservingTemplates('a=1&b={{x}}')).toBe('a=1&b={{x}}');
    expect(prettyBodyPreservingTemplates('{"broken": ')).toBe('{"broken": ');
  });
});

describe('isBodyEdited', () => {
  it('is false without a draft', () => {
    expect(isBodyEdited(original, undefined)).toBe(false);
  });

  it('ignores formatting-only changes', () => {
    expect(isBodyEdited(original, prettyBodyPreservingTemplates(original))).toBe(false);
    expect(isBodyEdited('a=1', '  a=1\n')).toBe(false);
  });

  it('detects a changed value', () => {
    const draft = original.replace('2026-11-17', '2026-12-01');
    expect(isBodyEdited(original, draft)).toBe(true);
  });

  it('detects a template replaced by a literal', () => {
    expect(isBodyEdited(original, original.replace('{{bearer}}', 'abc'))).toBe(true);
  });
});

describe('effectiveBodyOverride', () => {
  it('returns the draft only when it changes the content', () => {
    const draft = original.replace('REC', 'GRU');
    expect(effectiveBodyOverride(original, draft)).toBe(draft);
    expect(effectiveBodyOverride(original, prettyBodyPreservingTemplates(original))).toBeUndefined();
    expect(effectiveBodyOverride(original, undefined)).toBeUndefined();
  });
});

describe('applyBodyOverride', () => {
  const item: CollectionItem = {
    id: 'r1',
    name: 'AirSearch V3',
    type: 'request',
    method: 'POST',
    request: { url: '{{urlShopping}}/api/v3/airSearch', body: original, bodyType: 'raw' },
  } as CollectionItem;

  it('returns the same item without an override', () => {
    expect(applyBodyOverride(item, undefined)).toBe(item);
  });

  it('swaps the body on a copy, leaving the saved request untouched', () => {
    const out = applyBodyOverride(item, '{"x":1}');
    expect(out.request?.body).toBe('{"x":1}');
    expect(out.request?.url).toBe(item.request?.url);
    expect(item.request?.body).toBe(original);
    expect(out).not.toBe(item);
    expect(out.request).not.toBe(item.request);
  });
});

describe('applyEnvChanges', () => {
  it('carries sets, updates and deletions onto the target', () => {
    const target = { keep: '1', token: 'old', gone: 'x', other: 'paused-only' };
    const before = { keep: '1', token: 'old', gone: 'x' };
    const after = { keep: '1', token: 'new', added: 'y' };
    expect(applyEnvChanges(target, before, after)).toEqual({
      keep: '1',
      token: 'new',
      added: 'y',
      other: 'paused-only',
    });
  });

  it('does not overwrite target keys the step did not change', () => {
    const out = applyEnvChanges({ a: 'row-value' }, { a: 'env-value' }, { a: 'env-value' });
    expect(out).toEqual({ a: 'row-value' });
  });
});
