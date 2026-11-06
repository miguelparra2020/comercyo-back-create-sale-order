import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createFakeDb, pvError, type FakeDb } from '../test-utils/fake-db';

const db: FakeDb = vi.hoisted(() => ({}) as FakeDb);
vi.mock('../config/db', () => ({
  requiredEnv: (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  },
  getUsersDb: () => db.pool,
}));

import { registerSalesInvoicePaymentsRoutes } from './sales-invoice-payments.routes';
import { validationHook } from '../lib/validation-hook';
import { errorHandler } from '../lib/error-handler';
import type { AuthVariables } from '../middlewares/auth.middleware';
import type { OwnProjectVariables } from '../middlewares/require-own-project.middleware';

const ID_USER = 7;
const ID_OWN_PROJECT = 12;
const ORDER_ID = '123';

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables & OwnProjectVariables }>({ defaultHook: validationHook });
  // Stand in for requireAuth() + requireOwnProject().
  app.use('*', async (c, next) => {
    c.set('id_user', ID_USER);
    c.set('id_own_project', ID_OWN_PROJECT);
    await next();
  });
  registerSalesInvoicePaymentsRoutes(app);
  app.onError(errorHandler);
  return app;
}

const send = (path: string, method = 'GET', body?: unknown) =>
  buildApp().request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const FIND_INVOICE = /FROM sales_orders so/;
const PAYMENTS = /FROM sales_invoice_payments p\s+WHERE/;
const SUMMARY = /FROM sales_invoices si,/;
const INSERT = /INSERT INTO sales_invoice_payments/;
const VOID = /UPDATE sales_invoice_payments/;

const PAGO = {
  id_sales_invoice_payment: '9',
  fecha: '2026-10-20',
  metodo: 'Transferencia',
  monto: '6000.00',
  referencia: 'T-1',
  created_at: new Date('2026-10-20T15:00:00Z'),
  anulado_en: null,
  motivo_anulacion: null,
  comprobante_key: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
};
const RESUMEN = { total: '16032.50', pagado: '6000.00', saldo: '10032.50', estado: 'Pago parcial' };

const pagosUrl = `/sales-orders/${ORDER_ID}/payments`;
const pagoBody = { fecha: '2026-10-20', metodo: 'Transferencia', monto: 6000, referencia: 'T-1', comprobanteKey: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };

beforeEach(() => {
  Object.assign(
    db,
    createFakeDb()
      .on(FIND_INVOICE, { rows: [{ id_sales_invoice: '55' }] })
      .on(PAYMENTS, { rows: [PAGO] })
      .on(SUMMARY, { rows: [RESUMEN] })
      .on(INSERT, { rowCount: 1 })
      .on(VOID, { rows: [{ ok: 1 }] })
  );
});

describe('GET /sales-orders/:id/payments', () => {
  it('returns the payments and the summary of the order invoice', async () => {
    const res = await send(pagosUrl);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: { pagos: [{ ...PAGO, created_at: '2026-10-20T15:00:00.000Z' }], resumen: RESUMEN },
    });
    expect(db.find(FIND_INVOICE)?.params).toEqual([ORDER_ID, ID_OWN_PROJECT]);
  });

  it('409 FV_PEDIDO_NO_FACTURADO when the order has no invoice', async () => {
    db.on(FIND_INVOICE, { rows: [{ id_sales_invoice: null }] });
    const res = await send(pagosUrl);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FV_PEDIDO_NO_FACTURADO');
  });

  it('400 for a non numeric order id', async () => {
    expect((await send('/sales-orders/abc/payments')).status).toBe(400);
  });
});

describe('POST /sales-orders/:id/payments', () => {
  it('201: registers the payment with the scope of the request', async () => {
    const res = await send(pagosUrl, 'POST', pagoBody);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.resumen).toEqual(RESUMEN);
    expect(db.find(INSERT)?.params).toEqual([ID_OWN_PROJECT, '55', '2026-10-20', 'Transferencia', 6000, 'T-1', ID_USER, '3f2504e0-4f89-41d3-9a0c-0305e82c3301']);
    expect(json.data.pagos[0].comprobante_key).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('201: Efectivo sin foto guarda comprobante null', async () => {
    const { comprobanteKey: _omit, ...sinFoto } = pagoBody;
    const res = await send(pagosUrl, 'POST', { ...sinFoto, metodo: 'Efectivo' });

    expect(res.status).toBe(201);
    expect(db.find(INSERT)?.params?.[7]).toBeNull();
  });

  it('400 FV_PAGO_COMPROBANTE_REQUERIDO: Transferencia sin comprobanteKey, sin tocar la BD', async () => {
    const { comprobanteKey: _omit, ...sinFoto } = pagoBody;
    const res = await send(pagosUrl, 'POST', sinFoto);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('FV_PAGO_COMPROBANTE_REQUERIDO');
    expect(db.calls).toEqual([]);
  });

  it('409 FV_PAGO_COMPROBANTE_EN_USO cuando la key ya respalda otro pago (indice unico)', async () => {
    db.on(INSERT, () => {
      throw Object.assign(new Error('duplicate key'), {
        code: '23505',
        constraint: 'sales_invoice_payments_comprobante_key_uniq',
      });
    });
    const res = await send(pagosUrl, 'POST', pagoBody);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FV_PAGO_COMPROBANTE_EN_USO');
  });

  it.each([
    ['monto 0', { monto: 0 }],
    ['método Cheque', { metodo: 'Cheque' }],
    ['fecha inválida', { fecha: '2026-02-30' }],
  ])('400 PV_VALIDACION con %s, sin tocar la BD', async (_, cambio) => {
    const res = await send(pagosUrl, 'POST', { ...pagoBody, ...cambio });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('PV_VALIDACION');
    expect(db.calls).toEqual([]);
  });

  it('409 FV_PAGO_EXCEDE_SALDO from the DB trigger keeps its message', async () => {
    db.on(INSERT, () => {
      throw pvError('FV_PAGO_EXCEDE_SALDO', 'El monto supera el saldo de la factura (10032.50)');
    });
    const res = await send(pagosUrl, 'POST', pagoBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Conflict',
      message: 'El monto supera el saldo de la factura (10032.50)',
      code: 'FV_PAGO_EXCEDE_SALDO',
    });
  });

  it('400 FV_PAGO_FECHA_FUTURA from the DB trigger', async () => {
    db.on(INSERT, () => {
      throw pvError('FV_PAGO_FECHA_FUTURA', 'La fecha del pago no puede ser posterior a hoy');
    });
    const res = await send(pagosUrl, 'POST', pagoBody);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('FV_PAGO_FECHA_FUTURA');
  });
});

describe('POST /sales-orders/:id/payments/:idPago/void', () => {
  const voidUrl = `${pagosUrl}/9/void`;

  it('200: voids the payment with the reason and the user of the request', async () => {
    const res = await send(voidUrl, 'POST', { motivo: ' Duplicado ' });

    expect(res.status).toBe(200);
    expect(db.find(VOID)?.params).toEqual(['9', '55', ID_OWN_PROJECT, ID_USER, 'Duplicado']);
  });

  it('400 FV_PAGO_MOTIVO_REQUERIDO with an empty reason', async () => {
    const res = await send(voidUrl, 'POST', { motivo: '   ' });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('FV_PAGO_MOTIVO_REQUERIDO');
    expect(db.calls).toEqual([]);
  });

  it('400 for a non numeric payment id', async () => {
    expect((await send(`${pagosUrl}/abc/void`, 'POST', { motivo: 'x' })).status).toBe(400);
  });

  it('404 FV_PAGO_NO_ENCONTRADO for a payment of another invoice', async () => {
    db.on(VOID, { rows: [] });
    const res = await send(voidUrl, 'POST', { motivo: 'x' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FV_PAGO_NO_ENCONTRADO');
  });

  it('409 FV_PAGO_YA_ANULADO from the DB trigger', async () => {
    db.on(VOID, () => {
      throw pvError('FV_PAGO_YA_ANULADO', 'El pago ya está anulado');
    });
    const res = await send(voidUrl, 'POST', { motivo: 'x' });
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FV_PAGO_YA_ANULADO');
  });
});
