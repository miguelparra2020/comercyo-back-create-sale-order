import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createFakeDb, pvError, pgError, type FakeDb } from '../test-utils/fake-db';

const db: FakeDb = vi.hoisted(() => ({}) as FakeDb);
vi.mock('../config/db', () => ({
  getUsersDb: () => db.pool,
}));

import { registerSalesOrdersRoutes } from './sales-orders.routes';
import { validationHook } from '../lib/validation-hook';
import { errorHandler } from '../lib/error-handler';
import { mapSalesOrderError } from '../lib/pv-errors';
import { toInvoiceDto } from '../services/sales-orders.service';
import type { AuthVariables } from '../middlewares/auth.middleware';
import type { OwnProjectVariables } from '../middlewares/require-own-project.middleware';

// POST /sales-orders/:id/invoice and the `factura` field of every order response.
// Mirror of the purchase-order invoice in comercyo-back-create-purchase-order.

const ID_USER = 7;
const ID_OWN_PROJECT = 12;
const ORDER_ID = '123';

function buildApp() {
  const app = new OpenAPIHono<{ Variables: AuthVariables & OwnProjectVariables }>({ defaultHook: validationHook });
  app.use('*', async (c, next) => {
    c.set('id_user', ID_USER);
    c.set('id_own_project', ID_OWN_PROJECT);
    await next();
  });
  registerSalesOrdersRoutes(app);
  app.onError(errorHandler);
  return app;
}

const send = (path: string, method = 'GET', body?: unknown) =>
  buildApp().request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const FACTURA_ROW = {
  factura_id: '55',
  factura_numero: 'FV-0001',
  factura_fecha_emision: '2026-11-06',
  factura_fecha_vencimiento: '2026-12-06',
  factura_total: '51000.00',
  factura_notas: 'Pago a 30 días',
  factura_created_at: new Date('2026-11-06T15:00:00.000Z'),
  factura_pagado: '20000.00',
  factura_saldo: '31000.00',
  factura_estado: 'Pendiente',
  factura_dias_vencida: null,
};

const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id_sales_order: ORDER_ID,
  id_own_project: String(ID_OWN_PROJECT),
  numero: 'PED-0001',
  id_customer: '5',
  cliente_nombre: 'Laura Gómez',
  fecha: '2026-10-15',
  fecha_entrega: '2026-10-18',
  notas: '',
  estado: 'Entregado',
  descuento_tipo: null,
  descuento_valor: '0.00',
  impuesto_tipo: null,
  impuesto_valor: '0.00',
  costo_envio: '0.00',
  subtotal: '51000.00',
  descuento_monto: '0.00',
  impuesto_monto: '0.00',
  total: '51000.00',
  atrasado: false,
  entregado_en: null,
  created_at: new Date('2026-10-15T15:00:00.000Z'),
  updated_at: null,
  ...overrides,
});

const P = {
  exists: /SELECT 1 FROM sales_orders WHERE id_sales_order = \$1/,
  insertInvoice: /INSERT INTO sales_invoices/,
  detail: /FROM v_sales_orders so[\s\S]*?WHERE so\.id_sales_order = \$1/,
  lines: /FROM sales_order_lines\s+WHERE id_sales_order = ANY/,
};

const invoiceBody = { fecha_emision: '2026-11-06', fecha_vencimiento: '2026-12-06', notas: '  Pago a 30 días  ' };
const url = `/sales-orders/${ORDER_ID}/invoice`;

beforeEach(() => {
  Object.assign(
    db,
    createFakeDb()
      .on(P.exists, { rows: [{ '?column?': 1 }] })
      .on(P.insertInvoice, { rowCount: 1 })
      .on(P.detail, { rows: [orderRow(FACTURA_ROW)] })
      .on(P.lines, { rows: [] })
  );
});

describe('POST /sales-orders/:id/invoice', () => {
  it('inserta la factura en una transacción y devuelve el pedido con su factura', async () => {
    const res = await send(url, 'POST', invoiceBody);
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.factura).toEqual({
      id_sales_invoice: '55',
      numero: 'FV-0001',
      fecha_emision: '2026-11-06',
      fecha_vencimiento: '2026-12-06',
      total: '51000.00',
      notas: 'Pago a 30 días',
      created_at: '2026-11-06T15:00:00.000Z',
      pagado: '20000.00',
      saldo: '31000.00',
      estado: 'Pendiente',
      dias_vencida: null,
    });
    expect(db.statements()).toEqual([
      'BEGIN',
      'SELECT sales_orders',
      'INSERT sales_invoices',
      'SELECT v_sales_orders',
      'SELECT sales_order_lines',
      'COMMIT',
    ]);
    // Solo lo que envía la API: numero, cliente y total los pone la BD.
    // descuenta_inventario no viene en el body: por defecto true.
    expect(db.find(P.insertInvoice)!.params).toEqual([ID_OWN_PROJECT, ORDER_ID, '2026-11-06', '2026-12-06', 'Pago a 30 días', true, ID_USER]);
  });

  it('descuenta_inventario: false se envía tal cual; si no es booleano -> 400', async () => {
    const ok = await send(url, 'POST', { fecha_emision: '2026-11-06', fecha_vencimiento: '2026-12-06', descuenta_inventario: false });
    expect(ok.status).toBe(200);
    expect(db.find(P.insertInvoice)!.params[5]).toBe(false);

    const mal = await send(url, 'POST', { fecha_emision: '2026-11-06', fecha_vencimiento: '2026-12-06', descuenta_inventario: 'si' });
    expect(mal.status).toBe(400);
  });

  it('notas es opcional (se guarda vacío)', async () => {
    const res = await send(url, 'POST', { fecha_emision: '2026-11-06', fecha_vencimiento: '2026-11-06' });
    expect(res.status).toBe(200);
    expect(db.find(P.insertInvoice)!.params[4]).toBe('');
  });

  it('pedido de otro proyecto o inexistente -> 404 sin insertar', async () => {
    db.on(P.exists, { rows: [] });
    const res = await send(url, 'POST', invoiceBody);
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PV_PEDIDO_NO_ENCONTRADO');
    expect(db.find(P.insertInvoice)).toBeUndefined();
    expect(db.statements()).toContain('ROLLBACK');
  });

  it('vencimiento anterior a la emisión -> 400 FV_FACTURA_VENCIMIENTO_ANTERIOR sin tocar la BD', async () => {
    const res = await send(url, 'POST', { fecha_emision: '2026-11-06', fecha_vencimiento: '2026-11-05' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'FV_FACTURA_VENCIMIENTO_ANTERIOR',
      message: 'La fecha de vencimiento no puede ser anterior a la fecha de la factura',
    });
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    [{}, 'La fecha de la factura es obligatoria'],
    [{ fecha_emision: '2026-02-30', fecha_vencimiento: '2026-03-01' }, 'La fecha de la factura debe tener el formato YYYY-MM-DD y ser válida'],
    [{ fecha_emision: '2026-11-06' }, 'La fecha de vencimiento es obligatoria'],
    [{ fecha_emision: '2026-11-06', fecha_vencimiento: '2026-12-06', notas: 'x'.repeat(501) }, 'Las notas pueden tener máximo 500 caracteres'],
  ])('body inválido %j -> 400 PV_VALIDACION', async (body, message) => {
    const res = await send(url, 'POST', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'PV_VALIDACION', message });
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ['FV_PEDIDO_CANCELADO', 409],
    ['FV_PEDIDO_YA_FACTURADO', 409],
    ['FV_PEDIDO_SIN_TOTAL', 409],
    ['FV_STOCK_INSUFICIENTE', 409],
    ['FV_PEDIDO_ELIMINADO', 404],
  ])('la BD lanza %s -> %i con rollback', async (code, status) => {
    db.on(P.insertInvoice, () => {
      throw pvError(code, 'texto de la BD');
    });
    const res = await send(url, 'POST', invoiceBody);
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ code, message: 'texto de la BD' });
    expect(db.statements()).toContain('ROLLBACK');
  });

  it('dos facturas a la vez: el índice único -> 409 FV_PEDIDO_YA_FACTURADO', async () => {
    db.on(P.insertInvoice, () => {
      throw pgError('23505', 'sales_invoices_pedido_uniq');
    });
    const res = await send(url, 'POST', invoiceBody);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'FV_PEDIDO_YA_FACTURADO', message: 'El pedido de venta ya está facturado' });
  });
});

describe('factura en el pedido', () => {
  it('sin factura -> null; con factura -> tipos del contrato', () => {
    expect(toInvoiceDto({ factura_id: null })).toBeNull();
    expect(toInvoiceDto({})).toBeNull();
    expect(toInvoiceDto({ ...FACTURA_ROW, factura_estado: 'Vencida', factura_dias_vencida: '3' })).toMatchObject({
      estado: 'Vencida',
      dias_vencida: 3,
    });
  });

  it('GET /sales-orders/:id lee la factura vigente desde v_sales_invoices', async () => {
    const res = await send(`/sales-orders/${ORDER_ID}`);
    expect(res.status).toBe(200);
    expect((await res.json()).data.factura.numero).toBe('FV-0001');
    const sql = db.find(P.detail)!.sql;
    expect(sql).toMatch(/LEFT JOIN v_sales_invoices vi ON vi\.id_sales_order = so\.id_sales_order AND vi\.anulada_en IS NULL/);
  });
});

describe('errores FV_* de la BD', () => {
  it('FV_PEDIDO_FACTURADO (cancelar/editar un pedido facturado) -> 409 con el texto de la BD', () => {
    const mapped = mapSalesOrderError(pvError('FV_PEDIDO_FACTURADO', 'El pedido PED-0001 tiene la factura vigente FV-0001; anúlela antes de cancelar el pedido.'));
    expect(mapped).toEqual({
      status: 409,
      body: {
        success: false,
        error: 'Conflict',
        message: 'El pedido PED-0001 tiene la factura vigente FV-0001; anúlela antes de cancelar el pedido.',
        code: 'FV_PEDIDO_FACTURADO',
      },
    });
  });

  it('un código FV_ desconocido no se traduce (500 genérico)', () => {
    expect(mapSalesOrderError(pvError('FV_NUEVO_CODIGO'))).toBeNull();
  });
});
