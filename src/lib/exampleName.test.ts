import { describe, expect, it } from 'vitest';
import { exampleNameFor, notificationMessages } from './exampleName';

describe('exampleNameFor', () => {
  it('puts the notification message after the status', () => {
    const body = { notifications: [{ code: 'E001', message: 'CPF inválido' }] };
    expect(exampleNameFor(400, 'Bad Request', body)).toBe('400 Bad Request - CPF inválido');
  });

  it('keeps only the status when there is no notification', () => {
    expect(exampleNameFor(200, 'OK', { id: 1 })).toBe('200 OK');
    expect(exampleNameFor(204, 'No Content', null)).toBe('204 No Content');
  });

  it('counts the other notifications', () => {
    const body = { notifications: [{ message: 'Voo esgotado' }, { message: 'Tarifa expirada' }] };
    expect(exampleNameFor(422, 'Unprocessable Entity', body)).toBe('422 Unprocessable Entity - Voo esgotado (+1)');
  });

  it('cuts a long message', () => {
    const name = exampleNameFor(500, 'Internal Server Error', { notifications: [{ message: 'x'.repeat(300) }] });
    expect(name.length).toBeLessThan(160);
    expect(name.endsWith('…')).toBe(true);
  });
});

describe('notificationMessages', () => {
  it('reads a single notification, any key case, and a string body', () => {
    expect(notificationMessages({ Notification: { Message: 'Sem saldo' } })).toEqual(['Sem saldo']);
    expect(notificationMessages(JSON.stringify({ notifications: [{ message: 'A' }] }))).toEqual(['A']);
  });

  it('looks inside data/result and skips empty messages', () => {
    expect(notificationMessages({ data: { notifications: [{ message: ' ' }, { message: 'B' }] } })).toEqual(['B']);
    expect(notificationMessages('not json')).toEqual([]);
  });
});
