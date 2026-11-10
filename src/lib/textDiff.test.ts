import { describe, expect, it } from 'vitest';
import { collapseUnchanged, diffLines, diffableText } from './textDiff';

describe('diffLines', () => {
  it('marks added and removed lines', () => {
    const out = diffLines('a\nb\nc', 'a\nc\nd');
    expect(out.map(l => `${l.type}:${l.text}`)).toEqual(['same:a', 'del:b', 'same:c', 'add:d']);
  });

  it('highlights the changed part inside a replaced line', () => {
    const out = diffLines('const url = "/v1/token";', 'const url = "/v2/token";');
    expect(out.map(l => l.type)).toEqual(['del', 'add']);
    expect(out[0].segments?.filter(s => s.changed).map(s => s.text)).toEqual(['1']);
    expect(out[1].segments?.filter(s => s.changed).map(s => s.text)).toEqual(['2']);
  });

  it('does not pair lines that have nothing in common', () => {
    const out = diffLines('alpha', 'zzzzzzzz');
    expect(out.every(l => !l.segments)).toBe(true);
  });

  it('identical texts are all "same"', () => {
    expect(diffLines('x\ny', 'x\ny').every(l => l.type === 'same')).toBe(true);
  });
});

describe('collapseUnchanged', () => {
  it('keeps context around changes and collapses the rest', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const out = collapseUnchanged(diffLines(before, after), 2);
    expect(out[0]).toEqual({ type: 'collapsed', count: 8 });
    expect(out.filter(l => 'text' in l && l.type !== 'same')).toHaveLength(2);
    expect(out[out.length - 1]).toEqual({ type: 'collapsed', count: 7 });
  });
});

describe('diffableText', () => {
  it('pretty-prints objects and keeps strings', () => {
    expect(diffableText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(diffableText('x')).toBe('x');
    expect(diffableText(undefined)).toBe('');
  });
});
