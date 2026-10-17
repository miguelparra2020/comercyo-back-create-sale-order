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
import { PV_ERROR_STATUS } from '../lib/pv-errors';
import type { AuthVariables } from '../middlewares/auth.middleware';
import type { OwnProjectVariables } from '../middlewares/require-own-project.middleware';

const ID_USER = 7;
const ID_OWN_PROJECT = 12;
const OTHER_OWN_PROJECT = 34;
const ORDER_ID = '123';

function buildApp(id_own_project = ID_OWN_PROJECT) {
  const app = new OpenAPIHono<{ Variables: AuthVariables & OwnProjectVariables }>({ defaultHook: validationHook });
  // Stand in for requireAuth() + requireOwnProject().
  app.use('*', async (c, next) => {
    c.set('id_user', ID_USER);
    c.set('id_own_project', id_own_project);
    await next();
  });
  registerSalesOrdersRoutes(app);
  app.onError(errorHandler);
  return app;
}

// Rows exactly as pg returns them for the service's SELECTs (::text casts).
const orderRow = (overrides: Record<string, unknown> = {}) => ({
  id_sales_order: ORDER_ID,
  id_own_project: String(ID_OWN_PROJECT),
  numero: 'PED-0001',
  id_customer: '5',
  cliente_nombre: 'Laura Gómez',
  fecha: '2026-10-15',
  fecha_entrega: '2026-10-18',
  notas: '',
  estado: 'Pendiente',
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

// 51000 - 10% (5100) = 45900; + 19% (8721) + envío 8000 = 62621
const AJUSTADO = {
  descuento_tipo: 'porcentaje',
  descuento_valor: '10.00',
  impuesto_tipo: 'porcentaje',
  impuesto_valor: '19.00',
  costo_envio: '8000.00',
  subtotal: '51000.00',
  descuento_monto: '5100.00',
  impuesto_monto: '8721.00',
  total: '62621.00',
};

const AJUSTES_BODY = {
  descuento_tipo: 'porcentaje',
  descuento_valor: 10,
  impuesto_tipo: 'porcentaje',
  impuesto_valor: 19,
  costo_envio: 8000,
};

const lineRow = (overrides: Record<string, unknown> = {}) => ({
  id_sales_order: ORDER_ID,
  id_sales_order_line: '456',
  id_product: '789',
  producto_nombre: 'Resma carta',
  referencia: 'RES-CARTA',
  cantidad: 2,
  precio_unitario: '18000.00',
  subtotal: '36000.00',
  ...overrides,
});

const validBody = (overrides: Record<string, unknown> = {}) => ({
  id_customer: 5,
  fecha: '2026-10-15',
  fecha_entrega: '2026-10-18',
  notas: 'Entregar en portería',
  lineas: [
    { id_product: 789, cantidad: 2, precio_unitario: 18000 },
    { id_product: '790', cantidad: 1 },
  ],
  ...overrides,
});

const P = {
  insertOrder: /INSERT INTO sales_orders\b/,
  insertLines: /INSERT INTO sales_order_lines/,
  setEstado: /UPDATE sales_orders SET estado/,
  updateHeader: /UPDATE sales_orders\s+SET id_customer/,
  deleteLines: /DELETE FROM sales_order_lines/,
  softDelete: /UPDATE sales_orders so SET deleted_at/,
  detail: /FROM v_sales_orders so WHERE so\.id_sales_order = \$1/,
  count: /SELECT count\(\*\)::int AS total FROM v_sales_orders/,
  page: /FROM v_sales_orders so WHERE[\s\S]*ORDER BY/,
  lines: /FROM sales_order_lines\s+WHERE id_sales_order = ANY/,
};

// Happy-path answers for every statement; tests override what they need.
function happyDb(order = orderRow()) {
  return db
    .on(P.insertOrder, { rows: [{ id_sales_order: ORDER_ID }] })
    .on(P.insertLines, { rowCount: 2 })
    .on(P.setEstado, { rowCount: 1 })
    .on(P.updateHeader, { rowCount: 1 })
    .on(P.deleteLines, { rowCount: 1 })
    .on(P.softDelete, { rows: [order] })
    .on(P.detail, { rows: [order] })
    .on(P.count, { rows: [{ total: 1 }] })
    .on(P.page, { rows: [order] })
    .on(P.lines, {
      rows: [
        lineRow(),
        lineRow({ id_sales_order_line: '457', id_product: '790', producto_nombre: 'Lapicero', referencia: 'LAP-01', cantidad: 1, precio_unitario: '15000.00', subtotal: '15000.00' }),
      ],
    });
}

const send = (app: ReturnType<typeof buildApp>, path: string, method = 'GET', body?: unknown) =>
  app.request(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });

const writeSql = () => db.calls.filter((c) => /^\s*(INSERT|UPDATE|DELETE)/i.test(c.sql));

beforeEach(() => {
  Object.assign(db, createFakeDb());
});

// ===========================================================================
describe('validación del body (POST y PUT) -> 400 PV_VALIDACION sin tocar la BD', () => {
  it.each([
    ['sin cliente', { id_customer: undefined }, 'Selecciona un cliente'],
    ['sin fecha', { fecha: undefined }, 'Selecciona la fecha'],
    ['sin entrega', { fecha_entrega: undefined }, 'Selecciona la fecha de entrega'],
    ['entrega antes de la fecha', { fecha_entrega: '2026-10-14' }, 'La entrega no puede ser antes de la fecha del pedido'],
    ['notas > 500', { notas: 'a'.repeat(501) }, 'Las notas pueden tener máximo 500 caracteres'],
    ['sin líneas', { lineas: [] }, 'Agrega al menos un producto'],
    ['más de 50 líneas', { lineas: Array.from({ length: 51 }, (_, i) => ({ id_product: i + 1, cantidad: 1 })) }, 'Un pedido puede tener máximo 50 productos'],
    ['producto repetido', { lineas: [{ id_product: 789, cantidad: 1 }, { id_product: '789', cantidad: 2 }] }, 'Línea 2: Este producto ya está en el pedido'],
    ['cantidad 0', { lineas: [{ id_product: 789, cantidad: 0 }] }, 'Línea 1: La cantidad debe ser un número entero mayor que 0'],
    ['precio negativo', { lineas: [{ id_product: 789, cantidad: 1, precio_unitario: -5 }] }, 'Línea 1: El precio no puede ser negativo'],
  ])('POST rechaza %s', async (_label, overrides, message) => {
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody(overrides));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Bad Request', message, code: 'PV_VALIDACION' });
    expect(db.calls).toHaveLength(0);
  });

  it('rechaza un body que no es JSON', async () => {
    const res = await send(buildApp(), '/sales-orders', 'POST', '{no es json');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'El cuerpo de la petición debe ser un JSON válido',
      code: 'PV_VALIDACION',
    });
    expect(db.calls).toHaveLength(0);
  });

  it('PUT aplica las mismas reglas', async () => {
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody({ fecha: '2026-02-30' }));
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('La fecha debe tener el formato YYYY-MM-DD y ser válida');
    expect(db.calls).toHaveLength(0);
  });

  it('rechaza un :id inválido en todas las rutas', async () => {
    for (const [method, path] of [
      ['GET', '/sales-orders/abc'],
      ['PUT', '/sales-orders/abc'],
      ['POST', '/sales-orders/abc/prepare'],
      ['POST', '/sales-orders/-1/ship'],
      ['POST', '/sales-orders/1.5/deliver'],
      ['POST', '/sales-orders/x/cancel'],
      ['DELETE', '/sales-orders/0'],
    ]) {
      const res = await send(buildApp(), path, method, method === 'PUT' ? validBody() : undefined);
      expect(res.status, `${method} ${path}`).toBe(400);
      expect((await res.json()).code).toBe('PV_VALIDACION');
    }
    expect(db.calls).toHaveLength(0);
  });

  it('ignora campos desconocidos y calculados: nunca llegan a la BD', async () => {
    happyDb();
    const res = await send(buildApp(), '/sales-orders', 'POST', {
      ...validBody(),
      numero: 'PED-9999',
      total: '1.00',
      estado: 'Entregado',
      entregado_en: '2026-01-01T00:00:00Z',
      cliente_nombre: 'Hackeado',
      id_own_project: OTHER_OWN_PROJECT,
      hack: 'x',
      lineas: [{ id_product: 789, cantidad: 2, subtotal: '1', producto_nombre: 'X', referencia: 'Y', id_sales_order_line: 1 }],
    });

    expect(res.status).toBe(201);
    for (const call of writeSql()) {
      const columns = call.sql.split(/RETURNING|SELECT|WHERE/i)[0];
      expect(columns).not.toMatch(/numero|total|subtotal|cliente_nombre|producto_nombre|referencia|entregado_en/);
      expect(JSON.stringify(call.params)).not.toMatch(/PED-9999|Hackeado|Entregado|"x"/);
    }
    expect(db.find(P.insertOrder)!.sql).not.toMatch(/estado/);
    expect(db.find(P.insertOrder)!.params[0]).toBe(ID_OWN_PROJECT);
  });
});

// ===========================================================================
describe('validación de la query de GET /sales-orders -> 400', () => {
  it.each([
    ['estado=Enviada', 'estado debe ser uno de: Pendiente, En preparación, En camino, Entregado, Cancelado'],
    ['id_customer=x', 'id_customer debe ser un entero positivo'],
    ['atrasado=si', 'atrasado debe ser true o false'],
    ['fecha_desde=2026-02-30', 'fecha_desde debe tener el formato YYYY-MM-DD y ser válida'],
    ['fecha_desde=2026-10-10&fecha_hasta=2026-10-01', 'fecha_desde no puede ser posterior a fecha_hasta'],
    ['page=0', 'page debe ser como mínimo 1'],
    ['limit=101', 'limit debe ser como máximo 100'],
  ])('%s', async (qs, message) => {
    const res = await send(buildApp(), `/sales-orders?${qs}`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Bad Request', message, code: 'PV_VALIDACION' });
    expect(db.calls).toHaveLength(0);
  });
});

// ===========================================================================
describe('POST /sales-orders', () => {
  it('crea en una transacción (cabecera -> líneas -> releer) y responde 201', async () => {
    happyDb();
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());

    expect(res.status).toBe(201);
    expect(db.statements()).toEqual([
      'BEGIN',
      'INSERT sales_orders',
      'INSERT sales_order_lines',
      'SELECT v_sales_orders',
      'SELECT sales_order_lines',
      'COMMIT',
    ]);
    expect(db.calls.every((c) => c.via === 'client')).toBe(true);
    expect(db.release).toHaveBeenCalledTimes(1);

    const insert = db.find(P.insertOrder)!;
    expect(insert.sql).toMatch(/created_by_user_id/);
    expect(insert.sql).toMatch(/RETURNING/);
    // sin ajustes en el body -> null / 0
    expect(insert.params).toEqual([ID_OWN_PROJECT, '5', '2026-10-15', '2026-10-18', 'Entregar en portería', ID_USER, null, 0, null, 0, 0]);
    // id_product normalizado a string; sin precio -> null (la BD usa precio_venta_linea)
    expect(db.find(P.insertLines)!.params).toEqual([ORDER_ID, ['789', '790'], [2, 1], [18000, null]]);
    expect(db.find(P.insertLines)!.sql).toMatch(/WITH ORDINALITY[\s\S]*ORDER BY l\.ord/);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({ id_sales_order: ORDER_ID, numero: 'PED-0001', estado: 'Pendiente', total: '51000.00' });
    expect(body.data.lineas.map((l: any) => l.id_product)).toEqual(['789', '790']);
  });

  it('notas es opcional y por defecto es cadena vacía', async () => {
    happyDb();
    await send(buildApp(), '/sales-orders', 'POST', validBody({ notas: undefined }));
    expect(db.find(P.insertOrder)!.params[4]).toBe('');
  });
});

// ===========================================================================
describe('atomicidad', () => {
  it('POST: si falla una línea se hace ROLLBACK y no hay COMMIT', async () => {
    happyDb().on(P.insertLines, () => {
      throw pvError('PV_PRODUCTO_ELIMINADO', 'El producto "Resma carta" está eliminado.');
    });
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'El producto "Resma carta" está eliminado.',
      code: 'PV_PRODUCTO_ELIMINADO',
    });
    expect(db.statements()).toEqual(['BEGIN', 'INSERT sales_orders', 'INSERT sales_order_lines', 'ROLLBACK']);
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it('PUT: si falla la inserción de líneas no quedan ni la cabecera ni el borrado de líneas', async () => {
    happyDb().on(P.insertLines, () => {
      throw pvError('PV_PRODUCTO_OTRO_PROYECTO');
    });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody());

    expect(res.status).toBe(400);
    expect(db.statements()).toEqual([
      'BEGIN',
      'UPDATE sales_orders.id_customer',
      'DELETE sales_order_lines',
      'INSERT sales_order_lines',
      'ROLLBACK',
    ]);
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it('un error inesperado también hace ROLLBACK y responde 500 genérico sin filtrar SQL', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    happyDb().on(P.insertLines, () => {
      throw pgError('XX000');
    });
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());

    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/SQL|pg error|XX000|stack/i);
    expect(JSON.parse(text).code).toBe('INTERNAL_ERROR');
    expect(db.statements().at(-1)).toBe('ROLLBACK');
    errorSpy.mockRestore();
  });
});

// ===========================================================================
describe('GET /sales-orders', () => {
  it('lista desde v_sales_orders con paginación por defecto, orden y líneas en UNA consulta', async () => {
    const other = orderRow({ id_sales_order: '124', numero: 'PED-0002' });
    happyDb()
      .on(P.count, { rows: [{ total: 25 }] })
      .on(P.page, { rows: [other, orderRow()] })
      .on(P.lines, { rows: [lineRow(), lineRow({ id_sales_order: '124', id_sales_order_line: '900' })] });

    const res = await send(buildApp(), '/sales-orders');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.pagination).toEqual({ page: 1, limit: 10, total: 25, totalPages: 3 });
    expect(body.data.map((o: any) => o.id_sales_order)).toEqual(['124', ORDER_ID]);
    expect(body.data[0].lineas.map((l: any) => l.id_sales_order_line)).toEqual(['900']);
    expect(body.data[1].lineas.map((l: any) => l.id_sales_order_line)).toEqual(['456']);

    const page = db.find(P.page)!;
    expect(page.sql).toMatch(/FROM v_sales_orders so/);
    expect(page.sql).toMatch(/ORDER BY so\.fecha DESC, length\(so\.numero\) DESC, so\.numero DESC/);
    expect(page.params).toEqual([ID_OWN_PROJECT, 10, 0]);

    // Nunca una consulta por pedido.
    expect(db.calls.filter((c) => P.lines.test(c.sql))).toHaveLength(1);
    expect(db.find(P.lines)!.params).toEqual([['124', ORDER_ID]]);
  });

  it('no consulta líneas si la página viene vacía', async () => {
    happyDb().on(P.count, { rows: [{ total: 0 }] }).on(P.page, { rows: [] });
    const res = await send(buildApp(), '/sales-orders?page=3');
    expect(await res.json()).toMatchObject({ data: [], pagination: { page: 3, total: 0, totalPages: 0 } });
    expect(db.find(P.lines)).toBeUndefined();
  });

  it.each([
    ['search=ped-00', /so\.numero ILIKE '%' \|\| \$2::text \|\| '%' OR so\.cliente_nombre ILIKE '%' \|\| \$2::text \|\| '%'/, 'ped-00'],
    ['search=50%25_x%5C', /ILIKE/, '50\\%\\_x\\\\'],
    ['estado=En%20preparaci%C3%B3n', /so\.estado = \$2::sales_order_status/, 'En preparación'],
    ['id_customer=5', /so\.id_customer = \$2::bigint/, '5'],
    ['atrasado=true', /so\.atrasado = \$2::boolean/, true],
    ['atrasado=false', /so\.atrasado = \$2::boolean/, false],
    ['fecha_desde=2026-10-01', /so\.fecha >= \$2::date/, '2026-10-01'],
    ['fecha_hasta=2026-10-31', /so\.fecha <= \$2::date/, '2026-10-31'],
  ])('filtro %s', async (qs, sqlPattern, param) => {
    happyDb();
    const res = await send(buildApp(), `/sales-orders?${qs}`);

    expect(res.status).toBe(200);
    const count = db.find(P.count)!;
    const page = db.find(P.page)!;
    expect(count.sql).toMatch(sqlPattern);
    expect(page.sql).toMatch(sqlPattern);
    expect(count.params).toEqual([ID_OWN_PROJECT, param]);
    expect(page.params).toEqual([ID_OWN_PROJECT, param, 10, 0]);
  });

  it('combina filtros y calcula el offset', async () => {
    happyDb();
    await send(buildApp(), '/sales-orders?estado=Pendiente&id_customer=5&page=3&limit=20&search=%20%20');
    expect(db.find(P.page)!.params).toEqual([ID_OWN_PROJECT, 'Pendiente', '5', 20, 40]);
  });
});

// ===========================================================================
describe('GET /sales-orders/:id', () => {
  it('devuelve el pedido con sus líneas', async () => {
    happyDb();
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.lineas).toHaveLength(2);
    expect(db.find(P.detail)!.params).toEqual([ORDER_ID, ID_OWN_PROJECT]);
  });

  it('404 si no existe (o está borrado: la vista lo excluye)', async () => {
    happyDb().on(P.detail, { rows: [] });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Not Found',
      message: 'El pedido no existe',
      code: 'PV_PEDIDO_NO_ENCONTRADO',
    });
    expect(db.find(P.detail)!.sql).toMatch(/FROM v_sales_orders/);
  });
});

// ===========================================================================
describe('serialización', () => {
  it('bigint y numeric como string, id_own_project number, id_customer string, fechas sin desfase', async () => {
    const at = new Date('2026-10-17T20:30:00.000Z');
    happyDb(orderRow({ estado: 'Entregado', entregado_en: at, updated_at: at }));
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`);
    const { data } = await res.json();

    expect(data).toEqual({
      id_sales_order: '123',
      id_own_project: 12,
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
      entregado_en: '2026-10-17T20:30:00.000Z',
      created_at: '2026-10-15T15:00:00.000Z',
      updated_at: '2026-10-17T20:30:00.000Z',
      lineas: [
        { id_sales_order_line: '456', id_product: '789', producto_nombre: 'Resma carta', referencia: 'RES-CARTA', cantidad: 2, precio_unitario: '18000.00', subtotal: '36000.00' },
        { id_sales_order_line: '457', id_product: '790', producto_nombre: 'Lapicero', referencia: 'LAP-01', cantidad: 1, precio_unitario: '15000.00', subtotal: '15000.00' },
      ],
    });
  });

  it('pide las fechas a Postgres como texto YYYY-MM-DD y bigint/numeric como texto', async () => {
    happyDb();
    await send(buildApp(), `/sales-orders/${ORDER_ID}`);
    const sql = db.find(P.detail)!.sql;
    expect(sql).toMatch(/to_char\(so\.fecha, 'YYYY-MM-DD'\) AS fecha/);
    expect(sql).toMatch(/to_char\(so\.fecha_entrega, 'YYYY-MM-DD'\) AS fecha_entrega/);
    expect(sql).toMatch(/so\.id_sales_order::text/);
    expect(sql).toMatch(/so\.id_customer::text/);
    expect(sql).toMatch(/so\.total::text/);
    const lines = db.find(P.lines)!.sql;
    expect(lines).toMatch(/precio_unitario::text/);
    expect(lines).toMatch(/subtotal::text/);
    expect(lines).toMatch(/id_product::text/);
  });

  it('un bigint mayor que Number.MAX_SAFE_INTEGER no pierde precisión', async () => {
    happyDb(orderRow({ id_sales_order: '9007199254740993' }));
    const res = await send(buildApp(), `/sales-orders/9007199254740993`);
    expect((await res.json()).data.id_sales_order).toBe('9007199254740993');
  });
});

// ===========================================================================
describe('PUT /sales-orders/:id', () => {
  it('reemplaza cabecera y todas las líneas en una transacción, con updated_by_user_id', async () => {
    happyDb();
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody({ notas: '  ajustado  ' }));

    expect(res.status).toBe(200);
    expect(db.statements()).toEqual([
      'BEGIN',
      'UPDATE sales_orders.id_customer',
      'DELETE sales_order_lines',
      'INSERT sales_order_lines',
      'SELECT v_sales_orders',
      'SELECT sales_order_lines',
      'COMMIT',
    ]);
    expect(db.find(P.updateHeader)!.params).toEqual(['5', '2026-10-15', '2026-10-18', 'ajustado', ID_USER, ORDER_ID, ID_OWN_PROJECT]);
    expect(db.find(P.updateHeader)!.sql).not.toMatch(/estado/);
    expect(db.find(P.deleteLines)!.params).toEqual([ORDER_ID]);
    expect(db.find(P.insertLines)!.params).toEqual([ORDER_ID, ['789', '790'], [2, 1], [18000, null]]);
  });

  it('fuera de Pendiente/En preparación -> 409 PV_PEDIDO_NO_EDITABLE y ROLLBACK', async () => {
    const message = 'El pedido PED-0001 está en estado En camino; sus líneas solo se pueden modificar en Pendiente o En preparación.';
    happyDb().on(P.deleteLines, () => {
      throw pvError('PV_PEDIDO_NO_EDITABLE', message);
    });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody());

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'Conflict', message, code: 'PV_PEDIDO_NO_EDITABLE' });
    expect(db.statements().at(-1)).toBe('ROLLBACK');
  });

  it('404 si el pedido no existe en el proyecto, sin tocar las líneas', async () => {
    happyDb().on(P.updateHeader, { rowCount: 0 });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody());

    expect(res.status).toBe(404);
    expect(db.statements()).toEqual(['BEGIN', 'UPDATE sales_orders.id_customer', 'ROLLBACK']);
  });
});

// ===========================================================================
describe('acciones de estado', () => {
  it.each([
    ['prepare', 'En preparación'],
    ['ship', 'En camino'],
    ['deliver', 'Entregado'],
    ['cancel', 'Cancelado'],
  ])('%s -> %s, devuelve el pedido completo con sus líneas', async (action, estado) => {
    happyDb(orderRow({ estado }));
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}/${action}`, 'POST');

    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.estado).toBe(estado);
    expect(data.lineas).toHaveLength(2);
    expect(db.statements()).toEqual([
      'BEGIN',
      'UPDATE sales_orders.estado',
      'SELECT v_sales_orders',
      'SELECT sales_order_lines',
      'COMMIT',
    ]);
    expect(db.find(P.setEstado)!.params).toEqual([estado, ID_USER, ORDER_ID, ID_OWN_PROJECT]);
  });

  it.each([
    ['prepare', 'En camino', 'En preparación'],
    ['ship', 'Pendiente', 'En camino'],
    ['deliver', 'En preparación', 'Entregado'],
    ['cancel', 'Entregado', 'Cancelado'],
    ['cancel', 'Cancelado', 'Cancelado'],
  ])('%s desde %s -> 409 PV_TRANSICION_INVALIDA', async (action, from, to) => {
    const message = `El pedido PED-0001 no puede pasar de ${from} a ${to}.`;
    happyDb().on(P.setEstado, () => {
      throw pvError('PV_TRANSICION_INVALIDA', message);
    });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}/${action}`, 'POST');

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: 'Conflict', message, code: 'PV_TRANSICION_INVALIDA' });
    expect(db.statements().at(-1)).toBe('ROLLBACK');
  });
});

// ===========================================================================
describe('DELETE /sales-orders/:id', () => {
  it('hace borrado lógico con deleted_by_user_id y devuelve el pedido', async () => {
    happyDb();
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'DELETE');

    expect(res.status).toBe(200);
    expect((await res.json()).data.id_sales_order).toBe(ORDER_ID);
    const call = db.find(P.softDelete)!;
    expect(call.sql).toMatch(/SET deleted_at = now\(\), deleted_by_user_id = \$1/);
    expect(call.sql).toMatch(/deleted_at IS NULL/);
    expect(call.params).toEqual([ID_USER, ORDER_ID, ID_OWN_PROJECT]);
    expect(db.find(/DELETE FROM sales_orders/)).toBeUndefined();
  });

  it('fuera de Pendiente -> 409 PV_BORRADO_NO_PERMITIDO', async () => {
    happyDb().on(P.softDelete, () => {
      throw pvError('PV_BORRADO_NO_PERMITIDO');
    });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'DELETE');
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('PV_BORRADO_NO_PERMITIDO');
  });

  it('un pedido ya borrado da 404 (y la vista lo excluye de GET)', async () => {
    happyDb().on(P.softDelete, { rows: [] }).on(P.detail, { rows: [] });
    expect((await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'DELETE')).status).toBe(404);
    expect((await send(buildApp(), `/sales-orders/${ORDER_ID}`)).status).toBe(404);
  });
});

// ===========================================================================
describe('aislamiento entre proyectos', () => {
  // The fake DB only "has" the order for ID_OWN_PROJECT, like the real
  // WHERE id_own_project = $n would.
  function scopedDb() {
    const mine = (params: unknown[]) => params.includes(ID_OWN_PROJECT);
    happyDb()
      .on(P.detail, (params) => ({ rows: mine(params) ? [orderRow()] : [] }))
      .on(P.updateHeader, (params) => ({ rowCount: mine(params) ? 1 : 0 }))
      .on(P.setEstado, (params) => ({ rowCount: mine(params) ? 1 : 0 }))
      .on(P.softDelete, (params) => ({ rows: mine(params) ? [orderRow()] : [] }));
  }

  it.each([
    ['GET', ''],
    ['PUT', ''],
    ['POST', '/prepare'],
    ['POST', '/ship'],
    ['POST', '/deliver'],
    ['POST', '/cancel'],
    ['DELETE', ''],
  ])('%s /sales-orders/:id%s de otro proyecto -> 404', async (method, suffix) => {
    scopedDb();
    const res = await send(buildApp(OTHER_OWN_PROJECT), `/sales-orders/${ORDER_ID}${suffix}`, method, method === 'PUT' ? validBody() : undefined);

    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe('PV_PEDIDO_NO_ENCONTRADO');
    expect(db.find(P.insertLines)).toBeUndefined();
    expect(db.find(P.deleteLines)).toBeUndefined();
  });

  it('el listado siempre filtra por el proyecto del header', async () => {
    happyDb();
    await send(buildApp(OTHER_OWN_PROJECT), '/sales-orders?estado=Pendiente');
    expect(db.find(P.count)!.sql).toMatch(/so\.id_own_project = \$1/);
    expect(db.find(P.count)!.params[0]).toBe(OTHER_OWN_PROJECT);
    expect(db.find(P.page)!.params[0]).toBe(OTHER_OWN_PROJECT);
  });

  it('crear con un cliente de otro proyecto -> 400 PV_CLIENTE_OTRO_PROYECTO', async () => {
    happyDb().on(P.insertOrder, () => {
      throw pvError('PV_CLIENTE_OTRO_PROYECTO', 'El cliente 5 no pertenece al proyecto del pedido.');
    });
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'El cliente 5 no pertenece al proyecto del pedido.',
      code: 'PV_CLIENTE_OTRO_PROYECTO',
    });
  });
});

// ===========================================================================
describe('mapeo de errores de la BD -> HTTP', () => {
  it.each(Object.entries(PV_ERROR_STATUS))('%s -> %i', async (code, status) => {
    happyDb().on(P.insertOrder, () => {
      throw pvError(code, 'Texto en español.');
    });
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());

    expect(res.status).toBe(status);
    const message = code === 'PV_DESCUENTO_EXCEDE_SUBTOTAL' ? 'El descuento no puede ser mayor al subtotal del pedido' : 'Texto en español.';
    expect(await res.json()).toMatchObject({ success: false, message, code });
  });

  it.each([
    ['sales_orders_descuento_tipo_check', 'PV_DESCUENTO_TIPO_INVALIDO', 'El tipo de descuento debe ser porcentaje, valor o null'],
    ['sales_orders_impuesto_tipo_check', 'PV_IMPUESTO_TIPO_INVALIDO', 'El tipo de impuesto debe ser porcentaje, valor o null'],
    ['sales_orders_descuento_valor_check', 'PV_DESCUENTO_NEGATIVO', 'El descuento no puede ser negativo'],
    ['sales_orders_impuesto_valor_check', 'PV_IMPUESTO_NEGATIVO', 'El impuesto no puede ser negativo'],
    ['sales_orders_costo_envio_check', 'PV_COSTO_ENVIO_NEGATIVO', 'El costo de envío no puede ser negativo'],
    ['sales_orders_descuento_sin_tipo_check', 'PV_DESCUENTO_SIN_TIPO', 'El descuento debe ser 0 si no se indica si es porcentaje o valor'],
    ['sales_orders_impuesto_sin_tipo_check', 'PV_IMPUESTO_SIN_TIPO', 'El impuesto debe ser 0 si no se indica si es porcentaje o valor'],
    ['sales_orders_descuento_porcentaje_check', 'PV_DESCUENTO_PORCENTAJE_INVALIDO', 'El descuento no puede ser mayor a 100%'],
    ['sales_orders_impuesto_porcentaje_check', 'PV_IMPUESTO_PORCENTAJE_INVALIDO', 'El impuesto no puede ser mayor a 100%'],
  ])('CHECK %s (PUT) -> 400 %s con message en español', async (constraint, code, message) => {
    happyDb().on(P.updateHeader, () => {
      throw pgError('23514', constraint);
    });
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody());

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: 'Bad Request', message, code });
    expect(db.statements().at(-1)).toBe('ROLLBACK');
  });

  it.each([
    ['23505 líneas', pgError('23505', 'sales_order_lines_producto_uniq'), 'PV_PRODUCTO_REPETIDO'],
    ['23503 cliente', pgError('23503', 'sales_orders_id_customer_fkey'), 'PV_CLIENTE_NO_ENCONTRADO'],
    ['23503 producto', pgError('23503', 'sales_order_lines_id_product_fkey'), 'PV_PRODUCTO_NO_ENCONTRADO'],
    ['23514 fechas', pgError('23514', 'sales_orders_fechas_check'), 'PV_FECHAS_INVALIDAS'],
    ['23514 otro', pgError('23514', 'sales_order_lines_precio_check'), 'PV_DATOS_INVALIDOS'],
    ['22003 overflow', pgError('22003'), 'PV_VALOR_FUERA_DE_RANGO'],
    ['22P02 enum', pgError('22P02'), 'PV_VALIDACION'],
  ])('respaldo %s -> 400 %s sin filtrar el mensaje de pg', async (_label, err, code) => {
    happyDb().on(P.insertLines, () => {
      throw err;
    });
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.code).toBe(code);
    expect(body.message).not.toMatch(/pg error|SQL/);
  });

  it.each([
    ['número duplicado', pgError('23505', 'sales_orders_numero_uniq')],
    ['código PV_* desconocido', pvError('PV_NUEVO_CODIGO')],
  ])('%s -> 500 genérico', async (_label, err) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    happyDb().on(P.insertOrder, () => {
      throw err;
    });
    const res = await send(buildApp(), '/sales-orders', 'POST', validBody());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Internal Server Error',
      message: 'Ocurrió un error inesperado. Intente de nuevo más tarde.',
      code: 'INTERNAL_ERROR',
    });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

// ===========================================================================
describe('ajustes: descuento, impuesto y envío', () => {
  const AJUSTES_SELECT = [
    'so.descuento_tipo',
    'so.descuento_valor::text AS descuento_valor',
    'so.impuesto_tipo',
    'so.impuesto_valor::text AS impuesto_valor',
    'so.costo_envio::text AS costo_envio',
    'so.subtotal::text AS subtotal',
    'so.descuento_monto::text AS descuento_monto',
    'so.impuesto_monto::text AS impuesto_monto',
    'so.total::text AS total',
  ];

  // validBody: 2×18000 + 1×(sin precio); con precio explícito la API puede comparar el descuento fijo.
  const lineasConPrecio = [
    { id_product: 789, cantidad: 2, precio_unitario: 18000 },
    { id_product: 790, cantidad: 1, precio_unitario: 15000 },
  ];

  it('POST escribe los 5 campos editables en el INSERT de la cabecera y nunca los calculados', async () => {
    happyDb(orderRow(AJUSTADO));
    const res = await send(buildApp(), '/sales-orders', 'POST', {
      ...validBody(AJUSTES_BODY),
      subtotal: '1.00',
      descuento_monto: '999',
      impuesto_monto: '999',
      total: '1.00',
    });

    expect(res.status).toBe(201);
    const insert = db.find(P.insertOrder)!;
    expect(insert.sql).toMatch(/descuento_tipo, descuento_valor, impuesto_tipo, impuesto_valor, costo_envio/);
    expect(insert.params.slice(6)).toEqual(['porcentaje', 10, 'porcentaje', 19, 8000]);
    for (const call of writeSql()) {
      const columns = call.sql.split(/RETURNING|SELECT|WHERE/i)[0];
      expect(columns).not.toMatch(/\b(subtotal|descuento_monto|impuesto_monto|total)\b/);
    }
    expect(JSON.stringify(insert.params)).not.toMatch(/"1\.00"|"999"/);
    expect(db.statements()).toEqual([
      'BEGIN',
      'INSERT sales_orders',
      'INSERT sales_order_lines',
      'SELECT v_sales_orders',
      'SELECT sales_order_lines',
      'COMMIT',
    ]);
    expect((await res.json()).data).toMatchObject(AJUSTADO);
  });

  it('PUT escribe los 5 campos en el UPDATE de la cabecera, antes de reemplazar las líneas', async () => {
    happyDb(orderRow(AJUSTADO));
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody(AJUSTES_BODY));

    expect(res.status).toBe(200);
    const update = db.find(P.updateHeader)!;
    expect(update.sql).toMatch(
      /descuento_tipo = \$5, descuento_valor = \$6::numeric, impuesto_tipo = \$7, impuesto_valor = \$8::numeric, costo_envio = \$9::numeric,\s+updated_by_user_id = \$10\s+WHERE id_sales_order = \$11 AND id_own_project = \$12/
    );
    expect(update.params).toEqual([
      '5', '2026-10-15', '2026-10-18', 'Entregar en portería',
      'porcentaje', 10, 'porcentaje', 19, 8000,
      ID_USER, ORDER_ID, ID_OWN_PROJECT,
    ]);
    expect(db.statements()).toEqual([
      'BEGIN',
      'UPDATE sales_orders.id_customer',
      'DELETE sales_order_lines',
      'INSERT sales_order_lines',
      'SELECT v_sales_orders',
      'SELECT sales_order_lines',
      'COMMIT',
    ]);
    expect((await res.json()).data).toMatchObject(AJUSTADO);
  });

  it('PUT sin los campos de ajustes no los toca: conservan el valor actual del pedido', async () => {
    happyDb(orderRow(AJUSTADO));
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody());

    expect(res.status).toBe(200);
    const update = db.find(P.updateHeader)!;
    expect(update.sql).not.toMatch(/descuento|impuesto|costo_envio/);
    expect(update.params).toEqual(['5', '2026-10-15', '2026-10-18', 'Entregar en portería', ID_USER, ORDER_ID, ID_OWN_PROJECT]);
    // la respuesta trae los ajustes que ya tenía
    expect((await res.json()).data).toMatchObject(AJUSTADO);
  });

  it('PUT con solo algunos ajustes actualiza solo esos', async () => {
    happyDb();
    await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'PUT', validBody({ costo_envio: 5000, impuesto_tipo: null, impuesto_valor: 0 }));
    const update = db.find(P.updateHeader)!;
    expect(update.sql).toMatch(/impuesto_tipo = \$5, impuesto_valor = \$6::numeric, costo_envio = \$7::numeric/);
    expect(update.sql).not.toMatch(/descuento/);
    expect(update.params.slice(4, 7)).toEqual([null, 0, 5000]);
  });

  it.each([
    ['POST', '/sales-orders'],
    ['PUT', `/sales-orders/${ORDER_ID}`],
  ])('%s valida los ajustes -> 400 PV_VALIDACION sin tocar la BD', async (method, path) => {
    const casos: [Record<string, unknown>, string][] = [
      [{ descuento_tipo: null, descuento_valor: 5 }, 'El descuento debe ser 0 si no se indica si es porcentaje o valor'],
      [{ impuesto_tipo: 'porcentaje', impuesto_valor: 101 }, 'El impuesto no puede ser mayor a 100%'],
      [{ costo_envio: 1.234 }, 'El costo de envío debe tener máximo 2 decimales'],
      [{ costo_envio: -1 }, 'El costo de envío no puede ser negativo'],
      [{ descuento_tipo: 'fijo', descuento_valor: 1 }, 'El tipo de descuento debe ser porcentaje, valor o null'],
    ];
    for (const [overrides, message] of casos) {
      const res = await send(buildApp(), path, method, validBody(overrides));
      expect(res.status, message).toBe(400);
      expect(await res.json()).toEqual({ success: false, error: 'Bad Request', message, code: 'PV_VALIDACION' });
    }
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ['POST', '/sales-orders'],
    ['PUT', `/sales-orders/${ORDER_ID}`],
  ])('%s: descuento fijo mayor que las líneas del body -> 400 PV_DESCUENTO_EXCEDE_SUBTOTAL sin tocar la BD', async (method, path) => {
    const res = await send(buildApp(), path, method, validBody({ descuento_tipo: 'valor', descuento_valor: 51000.01, lineas: lineasConPrecio }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'El descuento no puede ser mayor al subtotal del pedido',
      code: 'PV_DESCUENTO_EXCEDE_SUBTOTAL',
    });
    expect(db.calls).toHaveLength(0);
  });

  it.each([
    ['POST', '/sales-orders'],
    ['PUT', `/sales-orders/${ORDER_ID}`],
  ])('%s: PV_DESCUENTO_EXCEDE_SUBTOTAL llega en el COMMIT (trigger diferido) -> 400 con message limpio', async (method, path) => {
    happyDb().on(/^COMMIT$/, () => {
      throw pvError('PV_DESCUENTO_EXCEDE_SUBTOTAL', 'El descuento no puede ser mayor al subtotal del pedido PED-0001.');
    });
    // La segunda línea no trae precio: la API no puede comparar, lo atrapa la BD.
    const res = await send(buildApp(), path, method, validBody({ descuento_tipo: 'valor', descuento_valor: 99999 }));

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'El descuento no puede ser mayor al subtotal del pedido',
      code: 'PV_DESCUENTO_EXCEDE_SUBTOTAL',
    });
    expect(db.statements().slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(db.release).toHaveBeenCalledTimes(1);
  });

  it.each(['prepare', 'ship', 'deliver', 'cancel'])('/%s devuelve los 9 campos de ajustes', async (action) => {
    happyDb(orderRow(AJUSTADO));
    const res = await send(buildApp(), `/sales-orders/${ORDER_ID}/${action}`, 'POST');
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject(AJUSTADO);
    for (const column of AJUSTES_SELECT) expect(db.find(P.detail)!.sql).toContain(column);
  });

  it('listado, detalle y DELETE piden los 9 campos y los devuelven', async () => {
    happyDb(orderRow(AJUSTADO));
    const list = await send(buildApp(), '/sales-orders');
    expect((await list.json()).data[0]).toMatchObject(AJUSTADO);
    const detail = await send(buildApp(), `/sales-orders/${ORDER_ID}`);
    expect((await detail.json()).data).toMatchObject(AJUSTADO);
    const deleted = await send(buildApp(), `/sales-orders/${ORDER_ID}`, 'DELETE');
    expect((await deleted.json()).data).toMatchObject(AJUSTADO);

    for (const pattern of [P.page, P.detail, P.softDelete]) {
      for (const column of AJUSTES_SELECT) expect(db.find(pattern)!.sql).toContain(column);
    }
  });
});
