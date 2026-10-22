import { describe, it, expect } from 'vitest';
import { buildRunReport } from './runReport';
import type { RunEntry } from '@/components/CollectionRunner/runCollectionRequest';

function ran(id: string, httpStatus: number, startedAt: string, finishedAt: string): RunEntry {
  return {
    id,
    itemId: id,
    iteration: 1,
    name: `Request ${id}`,
    method: 'GET',
    state: 'success',
    startedAt,
    finishedAt,
    outcome: {
      itemId: id,
      status: 'success',
      httpStatus,
      responseTime: 100,
      resolvedUrl: `https://api.test/${id}`,
      sentHeaders: { Accept: 'application/json' },
      fullResponseBody: '{"ok":true}',
      tests: [{ name: 'status 200', passed: httpStatus === 200, message: '' }],
      envAfter: {},
      logs: [],
      variablesSet: [{ key: 'token', value: 'abc', phase: 'post-response' }],
    },
  };
}

const isFailure = (e: RunEntry) => (e.outcome?.httpStatus ?? 0) >= 400;

describe('buildRunReport', () => {
  it('records the flow in order with each step’s timestamps', () => {
    const report = buildRunReport({
      collectionName: 'Fluxo',
      environmentName: 'dev',
      startedAt: '2026-10-22T10:00:00.000Z',
      finishedAt: '2026-10-22T10:00:02.500Z',
      entries: [
        ran('a', 200, '2026-10-22T10:00:00.010Z', '2026-10-22T10:00:01.000Z'),
        ran('b', 500, '2026-10-22T10:00:01.010Z', '2026-10-22T10:00:02.400Z'),
        { id: 'c', itemId: 'c', iteration: 1, name: 'Request c', method: 'GET', state: 'pending' },
      ],
      isFailure,
      failureReason: () => 'HTTP 500',
    });

    expect(report.environment).toBe('dev');
    expect(report.durationMs).toBe(2500);
    expect(report.summary).toMatchObject({ steps: 3, executed: 2, notExecuted: 1, passed: 1, failed: 1 });
    expect(report.steps.map(s => [s.order, s.result])).toEqual([
      [1, 'passed'],
      [2, 'failed'],
      [3, 'not-executed'],
    ]);
    expect(report.steps[0].startedAt).toBe('2026-10-22T10:00:00.010Z');
    expect(report.steps[1].failure).toBe('HTTP 500');
    expect(report.steps[0].request?.url).toBe('https://api.test/a');
    expect(report.steps[0].response?.body).toBe('{"ok":true}');
    expect(report.steps[2].request).toBeNull();
  });

  it('falls back to the steps’ timestamps when the run has none (older stored runs)', () => {
    const report = buildRunReport({
      collectionName: 'Fluxo',
      entries: [
        ran('a', 200, '2026-10-22T10:00:00.000Z', '2026-10-22T10:00:01.000Z'),
        ran('b', 200, '2026-10-22T10:00:01.000Z', '2026-10-22T10:00:03.000Z'),
      ],
      isFailure,
      failureReason: () => '',
    });
    expect(report.startedAt).toBe('2026-10-22T10:00:00.000Z');
    expect(report.finishedAt).toBe('2026-10-22T10:00:03.000Z');
    expect(report.durationMs).toBe(3000);
  });
});
