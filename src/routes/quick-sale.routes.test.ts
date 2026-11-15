import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createFakeDb, pvError, type FakeDb } from '../test-utils/fake-db';

const db: FakeDb = vi.hoisted(() => ({}) as FakeDb);
vi.mock('../config/db', () => ({ getUsersDb: () => db.pool }));

import { registerSalesOrdersRoutes } from './sales-orders.routes';
import { validationHook } from '../lib/validation-hook';
import { errorHandler } from '../lib/error-handler';

const ID_USER = 7;
const ID_OWN_PROJECT = 12;

const buildApp = () => {
  const app = new OpenAPIHono<any>({ defaultHook: validationHook });
  app.use('*', async (c: any, next) => {
    c.set('id_user', ID_USER);
    c.set('id_own_project', ID_OWN_PROJECT);
    await next();
  });
  registerSalesOrdersRoutes(app);
  app.onError(errorHandler);
  return app;
};

const venta = (body: unknown) =>
  buildApp().request('/sales-orders/quick-sale', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

const orderRow = {
  id_sales_order: '900', id_own_project: '12', numero: 'PED-0060', id_customer: '44', cliente_nombre: 'Cliente de mostrador',
  fecha: '2026-11-14', fecha_entrega: '2026-11-14', notas: '', estado: 'Entregado',
  descuento_tipo: null, descuento_valor: '0.00', impuesto_tipo: null, impuesto_valor: '0.00', costo_envio: '0.00',
  subtotal: '22400.00', descuento_monto: '0.00', impuesto_monto: '0.00', total: '22400.00',
  atrasado: false, origen: 'Manual', entregado_en: new Date('2026-11-14T20:00:00Z'), created_at: new Date('2026-11-14T20:00:00Z'), updated_at: null,
};

const happy = () =>
  db
    .on(/FROM customers/, { rows: [{ id_customer: '44' }] })
    .on(/INSERT INTO sales_orders\b/, { rows: [{ id_sales_order: '900' }] })
    .on(/INSERT INTO sales_order_lines/, { rowCount: 1 })
    .on(/UPDATE sales_orders SET estado/, { rowCount: 1 })
    .on(/INSERT INTO sales_invoices/, { rows: [{ id_sales_invoice: '70', total: '22400.00' }] })
    .on(/INSERT INTO sales_invoice_payments/, { rowCount: 1 })
    .on(/FROM v_sales_orders/, { rows: [orderRow] })
    .on(/FROM sales_order_lines/, { rows: [] })
    .on(/FROM v_sales_invoices|FROM sales_invoices/, { rows: [] });

beforeEach(() => {
  Object.assign(db, createFakeDb());
});

describe('POST /sales-orders/quick-sale (Caja rápida)', () => {
  it('sin cliente: usa el de mostrador, entrega, factura y paga el total en una transacción', async () => {
    happy();
    const res = await venta({ lineas: [{ id_product: 789, cantidad: 2, precio_unitario: 11200 }], metodo: 'Efectivo' });

    expect(res.status).toBe(201);
    const pasos = db.statements();
    expect(pasos.slice(0, 10)).toEqual([
      'BEGIN',
      'SELECT customers',
      'INSERT sales_orders',
      'INSERT sales_order_lines',
      'UPDATE sales_orders.estado',
      'UPDATE sales_orders.estado',
      'UPDATE sales_orders.estado',
      'INSERT sales_invoices',
      'INSERT sales_invoice_payments',
      'COMMIT',
    ]);
    expect(db.calls.filter((c) => /SET estado/.test(c.sql)).map((c) => c.params[0])).toEqual(['En preparación', 'En camino', 'Entregado']);
    expect(db.find(/INSERT INTO sales_orders\b/)!.params.slice(0, 2)).toEqual([ID_OWN_PROJECT, '44']);
    const pago = db.find(/INSERT INTO sales_invoice_payments/)!;
    expect(pago.params).toEqual([ID_OWN_PROJECT, '70', 'Efectivo', '22400.00', '', ID_USER]);
    expect((await res.json()).data).toMatchObject({ numero: 'PED-0060', estado: 'Entregado' });
  });

  it('la primera venta de la tienda crea el Cliente de mostrador', async () => {
    happy().on(/FROM customers/, { rows: [] }).on(/INSERT INTO customers/, { rows: [{ id_customer: '45' }] });
    await venta({ lineas: [{ id_product: 789, cantidad: 1 }], metodo: 'Transferencia', referencia: 'NEQUI-1' });

    const cliente = db.find(/INSERT INTO customers/)!;
    expect(cliente.params).toEqual([ID_OWN_PROJECT, 'Cliente de mostrador', 'mostrador+12@comercyo.com', '0000000', 'Venta en mostrador', ID_USER]);
    expect(db.find(/INSERT INTO sales_orders\b/)!.params[1]).toBe('45');
    expect(db.find(/INSERT INTO sales_invoice_payments/)!.params[4]).toBe('NEQUI-1');
  });

  it('con cliente no busca el de mostrador', async () => {
    happy();
    await venta({ id_customer: '5', lineas: [{ id_product: 789, cantidad: 1 }], metodo: 'Efectivo' });
    expect(db.find(/customers/)).toBeUndefined();
    expect(db.find(/INSERT INTO sales_orders\b/)!.params[1]).toBe('5');
  });

  it('sin stock no queda nada: ROLLBACK y 409', async () => {
    happy().on(/INSERT INTO sales_invoices/, () => { throw pvError('FV_STOCK_INSUFICIENTE', 'No hay stock suficiente'); });
    const res = await venta({ lineas: [{ id_product: 789, cantidad: 9 }], metodo: 'Efectivo' });
    expect(res.status).toBe(409);
    expect(db.statements()).toContain('ROLLBACK');
    expect(db.statements()).not.toContain('COMMIT');
  });

  it('valida antes de tocar la BD (método de pago y líneas)', async () => {
    const res = await venta({ lineas: [], metodo: 'Bitcoin' });
    expect(res.status).toBe(400);
    expect(db.calls).toHaveLength(0);
  });
});
