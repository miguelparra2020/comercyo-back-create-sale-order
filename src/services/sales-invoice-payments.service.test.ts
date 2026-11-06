import { describe, it, expect, beforeEach } from 'vitest';
import { createFakeDb, pvError, type FakeDb } from '../test-utils/fake-db';
import { createPayment, listPayments, voidPayment } from './sales-invoice-payments.service';

const SCOPE = { id_own_project: 7, id_user: 3 };

const FIND_INVOICE = /FROM sales_orders so/;
const PAYMENTS = /FROM sales_invoice_payments p\s+WHERE/;
const SUMMARY = /FROM sales_invoices si,/;

const PAGO_VIGENTE = {
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

const PAGO_ANULADO = {
  ...PAGO_VIGENTE,
  id_sales_invoice_payment: '10',
  monto: '4000.00',
  referencia: 'T-2',
  anulado_en: new Date('2026-10-21T15:00:00Z'),
  motivo_anulacion: 'Duplicado',
  comprobante_key: null,
};

const RESUMEN = { total: '16032.50', pagado: '6000.00', saldo: '10032.50', estado: 'Pago parcial' };

let db: FakeDb;

beforeEach(() => {
  db = createFakeDb()
    .on(FIND_INVOICE, { rows: [{ id_sales_invoice: '55' }] })
    .on(PAYMENTS, { rows: [PAGO_VIGENTE, PAGO_ANULADO] })
    .on(SUMMARY, { rows: [RESUMEN] });
});

describe('listPayments', () => {
  it('Pedido inexistente u otro proyecto -> PV_PEDIDO_NO_ENCONTRADO', async () => {
    db.on(FIND_INVOICE, { rows: [] });
    await expect(listPayments(db.pool, 7, '123')).rejects.toMatchObject({ code: 'PV_PEDIDO_NO_ENCONTRADO', status: 404 });
  });

  it('Pedido sin factura -> FV_PEDIDO_NO_FACTURADO', async () => {
    db.on(FIND_INVOICE, { rows: [{ id_sales_invoice: null }] });
    await expect(listPayments(db.pool, 7, '123')).rejects.toMatchObject({ code: 'FV_PEDIDO_NO_FACTURADO', status: 409 });
  });

  it('busca la factura del pedido en el proyecto y devuelve pagos (incluidos los anulados) con el resumen', async () => {
    const data = await listPayments(db.pool, 7, '123');

    expect(db.find(FIND_INVOICE)?.params).toEqual(['123', 7]);
    expect(db.find(PAYMENTS)?.params).toEqual(['55']);
    expect(db.find(PAYMENTS)?.sql).toMatch(/ORDER BY p\.fecha, p\.id_sales_invoice_payment/);
    expect(data).toEqual({
      pagos: [
        {
          id_sales_invoice_payment: '9',
          fecha: '2026-10-20',
          metodo: 'Transferencia',
          monto: '6000.00',
          referencia: 'T-1',
          created_at: '2026-10-20T15:00:00.000Z',
          anulado_en: null,
          motivo_anulacion: null,
          comprobante_key: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
        },
        {
          id_sales_invoice_payment: '10',
          fecha: '2026-10-20',
          metodo: 'Transferencia',
          monto: '4000.00',
          referencia: 'T-2',
          created_at: '2026-10-20T15:00:00.000Z',
          anulado_en: '2026-10-21T15:00:00.000Z',
          motivo_anulacion: 'Duplicado',
          comprobante_key: null,
        },
      ],
      resumen: RESUMEN,
    });
  });

  it('el resumen solo suma los pagos vigentes y calcula el estado en SQL (sin floats)', async () => {
    await listPayments(db.pool, 7, '123');
    const sql = db.find(SUMMARY)?.sql ?? '';
    expect(sql).toMatch(/FILTER \(WHERE anulado_en IS NULL\)/);
    expect(sql).toMatch(/'Pendiente'/);
    expect(sql).toMatch(/'Pagada'/);
    expect(sql).toMatch(/'Pago parcial'/);
  });
});

describe('createPayment', () => {
  const INPUT = { fecha: '2026-10-22', metodo: 'Efectivo' as const, monto: 10032.5, referencia: 'R-3', comprobanteKey: null };

  it('inserta el pago en la factura del pedido dentro de una transacción y devuelve la lista', async () => {
    db.on(/INSERT INTO sales_invoice_payments/, { rows: [] });

    const data = await createPayment(db.pool, SCOPE, '123', INPUT);

    expect(db.statements()).toEqual([
      'BEGIN',
      'SELECT sales_orders',
      'INSERT sales_invoice_payments',
      'SELECT sales_invoice_payments',
      'SELECT sales_invoices',
      'COMMIT',
    ]);
    expect(db.calls.filter((c) => c.via === 'pool')).toEqual([]);
    expect(db.find(/INSERT INTO sales_invoice_payments/)?.params).toEqual([7, '55', '2026-10-22', 'Efectivo', 10032.5, 'R-3', 3, null]);
    expect(data.resumen).toEqual(RESUMEN);
  });

  it('inserta la key del comprobante como 8.o parametro (uuid)', async () => {
    db.on(/INSERT INTO sales_invoice_payments/, { rows: [] });

    await createPayment(db.pool, SCOPE, '123', { ...INPUT, metodo: 'Transferencia', comprobanteKey: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' });

    const insert = db.find(/INSERT INTO sales_invoice_payments/);
    expect(insert?.sql).toMatch(/comprobante_key/);
    expect(insert?.sql).toMatch(/[$]8::uuid/);
    expect(insert?.params?.[7]).toBe('3f2504e0-4f89-41d3-9a0c-0305e82c3301');
  });

  it('lista el comprobante como texto en el SELECT', async () => {
    await listPayments(db.pool, 7, '123');
    expect(db.find(PAYMENTS)?.sql).toMatch(/comprobante_key::text AS comprobante_key/);
  });

  it('Pedido sin factura -> FV_PEDIDO_NO_FACTURADO sin insertar', async () => {
    db.on(FIND_INVOICE, { rows: [{ id_sales_invoice: null }] });
    await expect(createPayment(db.pool, SCOPE, '123', INPUT)).rejects.toMatchObject({ code: 'FV_PEDIDO_NO_FACTURADO' });
    expect(db.statements()).toEqual(['BEGIN', 'SELECT sales_orders', 'ROLLBACK']);
  });

  it('un error del trigger (saldo excedido) hace ROLLBACK y se propaga', async () => {
    db.on(/INSERT INTO sales_invoice_payments/, () => {
      throw pvError('FV_PAGO_EXCEDE_SALDO', 'El monto supera el saldo');
    });
    await expect(createPayment(db.pool, SCOPE, '123', INPUT)).rejects.toThrow(/FV_PAGO_EXCEDE_SALDO/);
    expect(db.statements().at(-1)).toBe('ROLLBACK');
  });
});

describe('voidPayment', () => {
  it('anula solo un pago de la factura de ese pedido y proyecto, con usuario y motivo', async () => {
    db.on(/UPDATE sales_invoice_payments/, { rows: [{ ok: 1 }] });

    const data = await voidPayment(db.pool, SCOPE, '123', '9', { motivo: 'Duplicado' });

    const update = db.find(/UPDATE sales_invoice_payments/);
    expect(update?.sql).toMatch(/id_sales_invoice_payment = \$1::bigint/);
    expect(update?.sql).toMatch(/id_sales_invoice = \$2::bigint/);
    expect(update?.sql).toMatch(/id_own_project = \$3/);
    expect(update?.params).toEqual(['9', '55', 7, 3, 'Duplicado']);
    expect(db.statements().at(-1)).toBe('COMMIT');
    expect(data.pagos).toHaveLength(2);
  });

  it('pago de otra factura u otro proyecto -> FV_PAGO_NO_ENCONTRADO', async () => {
    db.on(/UPDATE sales_invoice_payments/, { rows: [] });
    await expect(voidPayment(db.pool, SCOPE, '123', '999', { motivo: 'x' })).rejects.toMatchObject({
      code: 'FV_PAGO_NO_ENCONTRADO',
      status: 404,
    });
    expect(db.statements().at(-1)).toBe('ROLLBACK');
  });

  it('Pedido inexistente -> PV_PEDIDO_NO_ENCONTRADO', async () => {
    db.on(FIND_INVOICE, { rows: [] });
    await expect(voidPayment(db.pool, SCOPE, '123', '9', { motivo: 'x' })).rejects.toMatchObject({
      code: 'PV_PEDIDO_NO_ENCONTRADO',
    });
  });
});
