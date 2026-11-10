import { describe, it, expect, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@/components/CollectionRunner/runCollectionRequest', () => ({
  runCollectionRequest: vi.fn(async (item: { id: string }, env: Record<string, string>) =>
    item.id === 'broken'
      ? { status: 'error', errorMessage: 'Sign-in was not completed', envAfter: env }
      : { status: 'success', envAfter: { ...env, msal: 'eyJ.a.b' }, responseBodySnippet: 'New token stored in {{msal}}' }
  ),
}));

import { resolveTokenSteps } from './resolveTokenSteps';
import type { CollectionItem } from '@/app/types/CollectionItem';

const token = (id: string) =>
  ({ id, name: id, type: 'request', request: { url: '', auth: { type: 'oauth2' } } }) as unknown as CollectionItem;
const call = { id: 'call', name: 'call', type: 'request', request: { url: '{{baseUrl}}/x' } } as unknown as CollectionItem;

describe('resolveTokenSteps', () => {
  it('tira o passo de token do flow e põe o token no environment da carga', async () => {
    const out = await resolveTokenSteps([token('tok'), call], { baseUrl: 'http://x' });
    expect(out.requests.map(r => r.id)).toEqual(['call']);
    expect(out.envMap).toEqual({ baseUrl: 'http://x', msal: 'eyJ.a.b' });
    expect(out.tokenSteps).toHaveLength(1);
  });

  it('flow sem passo de token passa intacto', async () => {
    const out = await resolveTokenSteps([call], { baseUrl: 'http://x' });
    expect(out.requests).toEqual([call]);
    expect(out.tokenSteps).toEqual([]);
  });

  it('falha no login interrompe com o nome do passo', async () => {
    await expect(resolveTokenSteps([token('broken'), call], {})).rejects.toThrow(/broken.*Sign-in/);
  });
});
