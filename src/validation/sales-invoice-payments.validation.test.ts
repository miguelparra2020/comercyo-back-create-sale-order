import { describe, it, expect } from 'vitest';
import { formatIssue, issueCode, MSG_PAGO, PaymentBodySchema, PaymentIdParamSchema, VoidPaymentBodySchema } from './sales-orders.validation';

const pago = { fecha: '2026-10-20', metodo: 'Efectivo', monto: 1500.5 };

describe('PaymentBodySchema', () => {
  it('acepta un pago válido y deja la referencia vacía si no viene', () => {
    expect(PaymentBodySchema.parse(pago)).toEqual({ ...pago, referencia: '', comprobanteKey: null });
  });

  it('recorta la referencia', () => {
    expect(PaymentBodySchema.parse({ ...pago, referencia: '  T-1 ' }).referencia).toBe('T-1');
  });

  it.each([
    ['método no permitido', { metodo: 'Cheque' }],
    ['monto 0', { monto: 0 }],
    ['monto negativo', { monto: -1 }],
    ['monto con 3 decimales', { monto: 1.234 }],
    ['monto como texto', { monto: '100' }],
    ['fecha inválida', { fecha: '2026-13-01' }],
    ['fecha ausente', { fecha: undefined }],
    ['referencia de 121 caracteres', { referencia: 'x'.repeat(121) }],
  ])('rechaza %s', (_, cambio) => {
    expect(PaymentBodySchema.safeParse({ ...pago, ...cambio }).success).toBe(false);
  });
});

describe('PaymentBodySchema comprobanteKey', () => {
  const transferencia = { fecha: '2026-10-20', metodo: 'Transferencia', monto: 5000 };

  it('Transferencia sin comprobante -> FV_PAGO_COMPROBANTE_REQUERIDO en comprobanteKey', () => {
    const parsed = PaymentBodySchema.safeParse(transferencia);
    expect(parsed.success).toBe(false);
    expect(issueCode(parsed.error?.issues)).toBe('FV_PAGO_COMPROBANTE_REQUERIDO');
    expect(parsed.error?.issues[0].path).toEqual(['comprobanteKey']);
    expect(formatIssue(parsed.error?.issues)).toBe(MSG_PAGO.comprobante);
  });

  it('Transferencia con comprobanteKey null -> FV_PAGO_COMPROBANTE_REQUERIDO', () => {
    const parsed = PaymentBodySchema.safeParse({ ...transferencia, comprobanteKey: null });
    expect(issueCode(parsed.error?.issues)).toBe('FV_PAGO_COMPROBANTE_REQUERIDO');
  });

  it('acepta un UUID y lo deja en minúsculas', () => {
    const parsed = PaymentBodySchema.parse({ ...transferencia, comprobanteKey: '3F2504E0-4F89-41D3-9A0C-0305E82C3301' });
    expect(parsed.comprobanteKey).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('Efectivo sin comprobante -> comprobanteKey null', () => {
    expect(PaymentBodySchema.parse(pago).comprobanteKey).toBeNull();
  });

  it('Efectivo con comprobante lo conserva', () => {
    const key = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    expect(PaymentBodySchema.parse({ ...pago, comprobanteKey: key }).comprobanteKey).toBe(key);
  });

  it('un valor que no es UUID -> mensaje comprobanteInvalido', () => {
    const parsed = PaymentBodySchema.safeParse({ ...transferencia, comprobanteKey: 'abc' });
    expect(parsed.success).toBe(false);
    expect(formatIssue(parsed.error?.issues)).toBe(MSG_PAGO.comprobanteInvalido);
  });
});

describe('VoidPaymentBodySchema', () => {
  it('acepta un motivo y lo recorta', () => {
    expect(VoidPaymentBodySchema.parse({ motivo: ' Duplicado ' })).toEqual({ motivo: 'Duplicado' });
  });

  it.each([[{ motivo: '  ' }], [{}]])('motivo vacío o ausente -> FV_PAGO_MOTIVO_REQUERIDO', (body) => {
    const parsed = VoidPaymentBodySchema.safeParse(body);
    expect(parsed.success).toBe(false);
    expect(issueCode(parsed.error?.issues)).toBe('FV_PAGO_MOTIVO_REQUERIDO');
  });

  it('rechaza un motivo de 501 caracteres', () => {
    expect(VoidPaymentBodySchema.safeParse({ motivo: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('PaymentIdParamSchema', () => {
  it('exige ids enteros positivos', () => {
    expect(PaymentIdParamSchema.safeParse({ id: '1', idPago: '9' }).success).toBe(true);
    expect(PaymentIdParamSchema.safeParse({ id: '1', idPago: 'abc' }).success).toBe(false);
    expect(PaymentIdParamSchema.safeParse({ id: '0', idPago: '9' }).success).toBe(false);
  });
});
