import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { createFakeDb, type FakeDb } from '../test-utils/fake-db';

const db: FakeDb = vi.hoisted(() => ({}) as FakeDb);
vi.mock('../config/db', () => ({ getUsersDb: () => db.pool }));
vi.mock('../services/sales-orders.service', async (orig) => ({
  ...(await orig<typeof import('../services/sales-orders.service')>()),
  transitionSalesOrder: vi.fn(async () => ({})),
}));

import { registerDespachosRoutes } from './despachos.routes';
import { transitionSalesOrder } from '../services/sales-orders.service';
import { validationHook } from '../lib/validation-hook';
import { errorHandler } from '../lib/error-handler';
import type { Acceso } from '../lib/permisos';

const ID_USER = 7;
const DUENIO: Acceso = { duenio: true };
const DOMICILIARIO: Acceso = { duenio: false, permisos: { despachos: ['ver'] } };

function buildApp(acceso: Acceso) {
  const app = new OpenAPIHono({ defaultHook: validationHook });
  app.use('*', async (c, next) => {
    c.set('id_user' as never, ID_USER as never);
    c.set('id_own_project' as never, 12 as never);
    c.set('acceso' as never, acceso as never);
    await next();
  });
  registerDespachosRoutes(app);
  app.onError(errorHandler);
  return app;
}

const fila = {
  id: '5', numero: 'PED-0005', cliente_nombre: 'Laura', estado: 'Listo para despachar', fecha_entrega: '2026-11-27',
  notas: '', total: '50000.00', empaca_id_user: '7', empaca_nombre: 'Ana', entrega_id_user: null, entrega_nombre: 'Sin nombre',
  empacado_en: new Date('2026-11-26T14:00:00Z'), empacado_por: 'Ana', en_camino_en: null, en_camino_por: null, entregado_en: null, entregado_por: null,
};

beforeEach(() => {
  Object.assign(db, createFakeDb());
  vi.mocked(transitionSalesOrder).mockClear();
});

describe('GET /despachos', () => {
  it('el dueño ve todos y quién empacó', async () => {
    db.on(/FROM sales_orders so/, { rows: [fila] });
    const res = await buildApp(DUENIO).request('/despachos');
    const body = await res.json();
    expect(body.gestiona).toBe(true);
    expect(body.data[0]).toMatchObject({ numero: 'PED-0005', empaca: { id_user: '7', nombre: 'Ana' }, entrega: null, empacado: { nombre: 'Ana' } });
    expect(db.calls[0].params[1]).toBe(false);
  });

  it('quien no gestiona solo ve lo suyo', async () => {
    db.on(/FROM sales_orders so/, { rows: [] });
    const body = await (await buildApp(DOMICILIARIO).request('/despachos')).json();
    expect(body.gestiona).toBe(false);
    expect(db.calls[0].params).toEqual([12, true, 2, ID_USER]);
  });
});

describe('POST /despachos/:id/:paso', () => {
  it('el domiciliario entrega lo que tiene asignado', async () => {
    db.on(/SELECT empaca_id_user/, { rows: [{ empaca: null, entrega: '7' }] });
    const res = await buildApp(DOMICILIARIO).request('/despachos/5/entregar', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(vi.mocked(transitionSalesOrder).mock.calls[0][3]).toBe('deliver');
  });

  it('no puede marcar un pedido de otro', async () => {
    db.on(/SELECT empaca_id_user/, { rows: [{ empaca: '9', entrega: '9' }] });
    const res = await buildApp(DOMICILIARIO).request('/despachos/5/empacado', { method: 'POST' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('DESPACHO_NO_ASIGNADO');
    expect(transitionSalesOrder).not.toHaveBeenCalled();
  });

  it('el dueño marca sin estar asignado', async () => {
    const res = await buildApp(DUENIO).request('/despachos/5/salir', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(vi.mocked(transitionSalesOrder).mock.calls[0][3]).toBe('ship');
  });

  it('paso desconocido: 400', async () => {
    expect((await buildApp(DUENIO).request('/despachos/5/volar', { method: 'POST' })).status).toBe(400);
  });
});

describe('PUT /despachos/:id/asignar', () => {
  it('asigna solo a personas del equipo', async () => {
    db.on(/FROM users u/, { rows: [{ id_user: '7', nombre: 'Ana' }] });
    db.on(/UPDATE sales_orders SET empaca_id_user/, { rowCount: 1 });
    const ok = await buildApp(DUENIO).request('/despachos/5/asignar', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ empaca_id_user: '7', entrega_id_user: null }),
    });
    expect(ok.status).toBe(200);
    const mal = await buildApp(DUENIO).request('/despachos/5/asignar', {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ empaca_id_user: '99', entrega_id_user: null }),
    });
    expect(mal.status).toBe(400);
    expect((await mal.json()).code).toBe('DESPACHO_PERSONA_INVALIDA');
  });

  it('la persona no expone correo', async () => {
    db.on(/FROM users u/, { rows: [{ id_user: '7', nombre: 'Ana' }] });
    const body = await (await buildApp(DUENIO).request('/despachos/personas')).json();
    expect(body.data).toEqual([{ id_user: '7', nombre: 'Ana' }]);
    expect(db.calls[0].sql).not.toMatch(/SELECT[^F]*email/);
  });
});
