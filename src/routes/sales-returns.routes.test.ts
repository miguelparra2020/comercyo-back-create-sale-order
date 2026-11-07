import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createFakeDb, type FakeDb } from '../test-utils/fake-db';

const db: FakeDb = vi.hoisted(() => ({}) as FakeDb);
vi.mock('../config/db', () => ({
  requiredEnv: (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  },
  getUsersDb: () => db.pool,
}));

import { registerSalesReturnsRoutes } from './sales-returns.routes';
import { validationHook } from '../lib/validation-hook';
import { errorHandler } from '../lib/error-handler';
import type { AuthVariables } from '../middlewares/auth.middleware';
import type { OwnProjectVariables } from '../middlewares/require-own-project.middleware';

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
  registerSalesReturnsRoutes(app);
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
const RETURNS = /FROM sales_returns\s+WHERE id_sales_invoice = \$1::bigint\s+ORDER BY/;
const LINES = /FROM sales_return_lines l/;
const SUMMARY = /AS por_resolver/;
const INSERT_RETURN = /INSERT INTO sales_returns/;
const INSERT_LINE = /INSERT INTO sales_return_lines/;
const RESOLVE = /UPDATE sales_returns/;

const DEVOLUCION = {
  id_sales_return: '4',
  numero: 'DV-0001',
  fecha: '2026-11-07',
  motivo: 'Defectuoso',
  mueve_inventario: true,
  valor: '24000.00',
  resolucion: null,
  resuelta_fecha: null,
  metodo: null,
  monto_reintegro: null,
  referencia: '',
  created_at: new Date('2026-11-07T15:00:00Z'),
};
const LINEA = { id_sales_return: '4', id_product: '789', producto_nombre: 'Resma', cantidad: 2, precio_unitario: '12000.00', subtotal: '24000.00' };
const RESUMEN = { devuelto: '24000.00', reintegrado: '0.00', por_resolver: '24000.00' };

const url = `/sales-orders/${ORDER_ID}/returns`;
const body = { fecha: '2026-11-07', motivo: '  Defectuoso ', lineas: [{ id_product: 789, cantidad: 2 }] };

beforeEach(() => {
  Object.assign(
    db,
    createFakeDb()
      .on(FIND_INVOICE, { rows: [{ id_sales_invoice: '55' }] })
      .on(RETURNS, { rows: [DEVOLUCION] })
      .on(LINES, { rows: [LINEA] })
      .on(SUMMARY, { rows: [RESUMEN] })
      .on(INSERT_RETURN, { rows: [{ id: '4' }] })
      .on(INSERT_LINE, { rowCount: 1 })
      .on(RESOLVE, { rows: [{ ok: 1 }] })
  );
});

describe('GET /sales-orders/:id/returns', () => {
  it('devuelve las devoluciones con sus líneas y el resumen', async () => {
    const res = await send(url);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      data: {
        devoluciones: [
          {
            ...DEVOLUCION,
            created_at: '2026-11-07T15:00:00.000Z',
            lineas: [{ id_product: '789', producto_nombre: 'Resma', cantidad: 2, precio_unitario: '12000.00', subtotal: '24000.00' }],
          },
        ],
        resumen: RESUMEN,
      },
    });
    expect(db.find(FIND_INVOICE)?.params).toEqual([ORDER_ID, ID_OWN_PROJECT]);
    expect(db.find(RETURNS)?.params).toEqual(['55']);
  });

  it('409 FV_PEDIDO_NO_FACTURADO cuando la orden no tiene factura', async () => {
    db.on(FIND_INVOICE, { rows: [{ id_sales_invoice: null }] });
    const res = await send(url);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('FV_PEDIDO_NO_FACTURADO');
  });
});

describe('POST /sales-orders/:id/returns', () => {
  it('201: crea cabecera y líneas en una transacción', async () => {
    const res = await send(url, 'POST', body);
    expect(res.status).toBe(201);
    expect(db.find(INSERT_RETURN)?.params).toEqual([ID_OWN_PROJECT, '55', '2026-11-07', 'Defectuoso', ID_USER]);
    expect(db.find(INSERT_LINE)?.params).toEqual(['4', '789', 2]);
    expect(db.statements()[0]).toBe('BEGIN');
    expect(db.statements()).toContain('COMMIT');
  });

  it('400 sin productos, motivo vacío o producto repetido, sin tocar la BD', async () => {
    for (const malo of [
      { ...body, lineas: [] },
      { ...body, motivo: '  ' },
      { ...body, lineas: [{ id_product: 789, cantidad: 1 }, { id_product: 789, cantidad: 1 }] },
      { ...body, lineas: [{ id_product: 789, cantidad: 0 }] },
    ]) {
      const res = await send(url, 'POST', malo);
      expect(res.status).toBe(400);
    }
    expect(db.calls).toEqual([]);
  });

  it('409 FV_DEV_CANTIDAD_EXCEDE con el texto de la BD, y ROLLBACK', async () => {
    db.on(INSERT_LINE, () => {
      throw Object.assign(new Error('FV_DEV_CANTIDAD_EXCEDE: De Resma se facturaron 2 y ya se devolvieron 2: se pueden devolver 0.'), { code: 'P0001' });
    });
    const res = await send(url, 'POST', body);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'FV_DEV_CANTIDAD_EXCEDE', message: 'De Resma se facturaron 2 y ya se devolvieron 2: se pueden devolver 0.' });
    expect(db.statements()).toContain('ROLLBACK');
  });
});

describe('POST /sales-orders/:id/returns/:idDev/resolve', () => {
  const resolverUrl = `${url}/4/resolve`;

  it('Reposición: guarda sin método ni monto', async () => {
    const res = await send(resolverUrl, 'POST', { resolucion: 'Reposición', fecha: '2026-11-08', metodo: 'Efectivo', monto: 10 });
    expect(res.status).toBe(200);
    expect(db.find(RESOLVE)?.params).toEqual(['4', '55', ID_OWN_PROJECT, 'Reposición', '2026-11-08', null, null, '', ID_USER]);
  });

  it('Reintegro: guarda método, monto y referencia', async () => {
    const res = await send(resolverUrl, 'POST', { resolucion: 'Reintegro', fecha: '2026-11-08', metodo: 'Transferencia', monto: 24000, referencia: ' T-9 ' });
    expect(res.status).toBe(200);
    expect(db.find(RESOLVE)?.params).toEqual(['4', '55', ID_OWN_PROJECT, 'Reintegro', '2026-11-08', 'Transferencia', 24000, 'T-9', ID_USER]);
  });

  it('400: Reintegro sin método o sin monto; resolución desconocida', async () => {
    expect((await send(resolverUrl, 'POST', { resolucion: 'Reintegro', fecha: '2026-11-08', monto: 1 })).status).toBe(400);
    expect((await send(resolverUrl, 'POST', { resolucion: 'Reintegro', fecha: '2026-11-08', metodo: 'Efectivo' })).status).toBe(400);
    expect((await send(resolverUrl, 'POST', { resolucion: 'Nota', fecha: '2026-11-08' })).status).toBe(400);
    expect(db.calls).toEqual([]);
  });

  it('404 FV_DEV_NO_ENCONTRADA si la devolución no es de esa factura', async () => {
    db.on(RESOLVE, { rows: [] });
    const res = await send(resolverUrl, 'POST', { resolucion: 'Reposición', fecha: '2026-11-08' });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('FV_DEV_NO_ENCONTRADA');
  });

  it('409 FV_DEV_YA_RESUELTA y FV_DEV_REINTEGRO_EXCEDE vienen de la BD', async () => {
    for (const code of ['FV_DEV_YA_RESUELTA', 'FV_DEV_REINTEGRO_EXCEDE', 'FV_DEV_STOCK_INSUFICIENTE']) {
      db.on(RESOLVE, () => {
        throw Object.assign(new Error(`${code}: texto`), { code: 'P0001' });
      });
      const res = await send(resolverUrl, 'POST', { resolucion: 'Reintegro', fecha: '2026-11-08', metodo: 'Efectivo', monto: 1 });
      expect(res.status).toBe(409);
      expect((await res.json()).code).toBe(code);
    }
  });
});
