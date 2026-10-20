import { describe, it, expect } from 'vitest';
import { hasFailureReason, failureReason, isExpectedErrorStatus } from './runVerdict';
import type { RunEntry } from './runCollectionRequest';
import type { RunItemOutcome } from './runCollectionRequest';

function entry(outcome?: Partial<RunItemOutcome>): RunEntry {
  return {
    id: 'e1',
    itemId: 'r1',
    iteration: 1,
    name: 'Payments',
    method: 'POST',
    state: outcome?.status === 'error' ? 'error' : 'success',
    outcome: outcome
      ? {
          itemId: 'r1',
          status: 'success',
          responseTime: 10,
          tests: [],
          envAfter: {},
          logs: [],
          variablesSet: [],
          ...outcome,
        }
      : undefined,
  };
}

const pass = (name: string) => ({ name, passed: true, message: '' });
const fail = (name: string, message = 'expected 200') => ({ name, passed: false, message });

describe('hasFailureReason', () => {
  it('não acusa request que ainda não rodou', () => {
    expect(hasFailureReason(entry())).toBe(false);
  });

  it('acusa erro de transporte', () => {
    expect(hasFailureReason(entry({ status: 'error', errorMessage: 'ECONNREFUSED' }))).toBe(true);
  });

  it('acusa erro de script', () => {
    expect(hasFailureReason(entry({ httpStatus: 200, scriptError: 'x is not defined' }))).toBe(true);
  });

  it('acusa 4xx sem nenhuma asserção', () => {
    expect(hasFailureReason(entry({ httpStatus: 400 }))).toBe(true);
  });

  it('não acusa 2xx', () => {
    expect(hasFailureReason(entry({ httpStatus: 201 }))).toBe(false);
  });

  // O caso que motivou o módulo: fluxo de teste negativo, em que 400 é o
  // resultado certo.
  describe('quando há asserção, ela é que decide', () => {
    it('400 asseverado não é falha', () => {
      const e = entry({ httpStatus: 400, tests: [pass('bloqueia pagamento sem CPF')] });
      expect(hasFailureReason(e)).toBe(false);
    });

    it('200 com asserção quebrada é falha', () => {
      expect(hasFailureReason(entry({ httpStatus: 200, tests: [fail('tem recordLocator')] }))).toBe(true);
    });

    it('400 com asserção quebrada continua falha', () => {
      expect(hasFailureReason(entry({ httpStatus: 400, tests: [fail('esperava 422')] }))).toBe(true);
    });

    // Asserção que passou não apaga a request não ter respondido.
    it('não encobre erro de transporte', () => {
      const e = entry({ status: 'error', errorMessage: 'timeout', tests: [pass('qualquer')] });
      expect(hasFailureReason(e)).toBe(true);
    });

    it('não encobre erro de script', () => {
      const e = entry({ httpStatus: 400, scriptError: 'boom', tests: [pass('qualquer')] });
      expect(hasFailureReason(e)).toBe(true);
    });
  });
});

describe('isExpectedErrorStatus', () => {
  it('reconhece o 400 declarado pela asserção', () => {
    expect(isExpectedErrorStatus(entry({ httpStatus: 400, tests: [pass('bloqueia')] }))).toBe(true);
  });

  it('não vale para 2xx', () => {
    expect(isExpectedErrorStatus(entry({ httpStatus: 200, tests: [pass('ok')] }))).toBe(false);
  });

  it('não vale sem asserção', () => {
    expect(isExpectedErrorStatus(entry({ httpStatus: 400 }))).toBe(false);
  });

  it('não vale com asserção quebrada', () => {
    expect(isExpectedErrorStatus(entry({ httpStatus: 400, tests: [fail('x')] }))).toBe(false);
  });
});

describe('failureReason', () => {
  it('traz status e corpo', () => {
    const text = failureReason(entry({ httpStatus: 400, responseBodySnippet: '{"code":"RequiredField"}' }));
    expect(text).toContain('HTTP 400');
    expect(text).toContain('RequiredField');
  });

  it('omite o corpo quando pedido', () => {
    const text = failureReason(entry({ httpStatus: 400, responseBodySnippet: '{"code":"X"}' }), false);
    expect(text).toContain('HTTP 400');
    expect(text).not.toContain('"code"');
  });

  // Antes isto devolvia só a URL: no relatório copiado e no JUnit não existe
  // a lista de testes da tela, então a falha ficava sem motivo nenhum.
  it('nomeia a asserção que quebrou num 200', () => {
    const text = failureReason(entry({ httpStatus: 200, tests: [fail('tem recordLocator', 'undefined')] }));
    expect(text).toContain('tem recordLocator');
    expect(text).toContain('undefined');
  });

  it('lista só as que quebraram', () => {
    const text = failureReason(entry({ httpStatus: 200, tests: [pass('status 200'), fail('tem id')] }));
    expect(text).toContain('tem id');
    expect(text).not.toContain('status 200');
  });

  it('inclui a URL resolvida', () => {
    const text = failureReason(entry({ httpStatus: 400, resolvedUrl: 'http://localhost:6007/api/v1/order/payments' }));
    expect(text).toContain('URL: http://localhost:6007/api/v1/order/payments');
  });

  it('traz a mensagem do erro de transporte', () => {
    expect(failureReason(entry({ status: 'error', errorMessage: 'ECONNREFUSED' }))).toContain('ECONNREFUSED');
  });

  it('devolve vazio quando não rodou', () => {
    expect(failureReason(entry())).toBe('');
  });
});
