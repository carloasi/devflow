import { describe, it, expect } from 'vitest';
import {
  asCancelled,
  captureSyncStatus,
  isSyncCancelRequested,
  isSyncCenterBusy,
  reportSyncStatus,
  requestSyncCancel,
  resetSyncCancel,
  setSyncCenterBusy,
  SYNC_CANCELLED_MESSAGE,
  SyncCancelledError,
  throwIfSyncCancelled,
} from './syncCenterStore';

describe('captura das mensagens de uma ação da Central', () => {
  it('guarda só o que foi reportado durante a captura', () => {
    reportSyncStatus('info', 'antes — fica de fora');
    const capture = captureSyncStatus();
    reportSyncStatus('success', 'Pulled 2 change(s)');
    expect(capture.peek().map(m => m.message)).toEqual(['Pulled 2 change(s)']);
    reportSyncStatus('error', 'Push failed: network');
    reportSyncStatus('info', '');
    expect(capture.stop()).toEqual([
      { type: 'success', message: 'Pulled 2 change(s)' },
      { type: 'error', message: 'Push failed: network' },
    ]);
    reportSyncStatus('error', 'depois — fica de fora');
    expect(capture.stop()).toHaveLength(2);
  });

  it('marca a Central como ocupada', () => {
    setSyncCenterBusy(true);
    expect(isSyncCenterBusy()).toBe(true);
    setSyncCenterBusy(false);
    expect(isSyncCenterBusy()).toBe(false);
  });
});

describe('resultMessages', () => {
  it('tira o progresso e deixa os resultados', async () => {
    const { resultMessages } = await import('./syncCenterStore');
    const messages = [
      { type: 'success' as const, message: 'Pulled 2 change(s) from GitHub into "ws".' },
      { type: 'info' as const, message: 'Checking GitHub for changes before sending...' },
      { type: 'info' as const, message: 'Encrypting and sending files...' },
      { type: 'success' as const, message: 'Pushed "ws".' },
    ];
    expect(resultMessages({ result: 'done', messages }).map(m => m.message)).toEqual([
      'Pulled 2 change(s) from GitHub into "ws".',
      'Pushed "ws".',
    ]);
    expect(
      resultMessages({ result: 'failed', messages: [...messages, { type: 'error', message: 'Push failed: network' }] }).map(m => m.message)
    ).toEqual(['Push failed: network']);
  });
});

describe('withoutActions', () => {
  it('tira o "Desfazer" das mensagens guardadas antes da revisão', async () => {
    const { withoutActions } = await import('./syncCenterStore');
    const out = withoutActions([{ type: 'success', message: 'Pulled 1', action: { label: 'Undo', run: () => undefined } }]);
    expect(out).toEqual([{ type: 'success', message: 'Pulled 1' }]);
  });
});

describe('cancelar a ação da Central', () => {
  it('só para nos pontos seguros depois de pedido, e o pedido é zerado', () => {
    resetSyncCancel();
    expect(() => throwIfSyncCancelled()).not.toThrow();
    requestSyncCancel();
    expect(isSyncCancelRequested()).toBe(true);
    expect(() => throwIfSyncCancelled()).toThrow(SyncCancelledError);
    resetSyncCancel();
    expect(() => throwIfSyncCancelled()).not.toThrow();
  });

  it('vira um aviso só, mantendo o que terminou antes', () => {
    const result = asCancelled(
      [
        { type: 'success', message: 'Pulled 2 change(s)' },
        { type: 'error', message: `Push failed: ${SYNC_CANCELLED_MESSAGE}` },
      ],
      'Cancelado'
    );
    expect(result).toEqual({
      result: 'done',
      messages: [
        { type: 'success', message: 'Pulled 2 change(s)' },
        { type: 'info', message: 'Cancelado' },
      ],
    });
  });
});
