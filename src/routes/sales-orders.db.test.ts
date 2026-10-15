// Integration tests against the real sales_orders tables (supabase-tiendas,
// migration 20261015031310_create_sales_orders). Run with `npm run test:db` -
// needs the DATABASE_* / TIENDAS_DB_REF vars in .env.
//
// Everything runs inside ONE transaction that is always rolled back, so no
// row is ever left in the database (the PED-xxxx counter rolls back too).
// Each statement is wrapped in a SAVEPOINT so an expected error doesn't abort
// the rest of the transaction, and the service's own BEGIN/COMMIT/ROLLBACK
// become a SAVEPOINT / RELEASE / ROLLBACK TO inside it.
//
// While it runs, the project's row in sales_order_counters stays locked, so a
// real sales order of that project would wait a few seconds.
import 'dotenv/config';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { Client } from 'pg';

const holder: { client?: Client } = {};
let savepoint = 0;

// pg's Client queues queries, but the savepoint wrapper is several queries
// long; listSalesOrders fires two in parallel, so run one wrapper at a time.
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
};

const query = (sql: string, params?: unknown[]) =>
  serial(async () => {
    const client = holder.client!;
    const name = `sp_${++savepoint}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await client.query(sql, params);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw err;
    }
  });

const connect = async () => {
  const name = `tx_${++savepoint}`;
  const statement: Record<string, string> = {
    BEGIN: `SAVEPOINT ${name}`,
    COMMIT: `RELEASE SAVEPOINT ${name}`,
    ROLLBACK: `ROLLBACK TO SAVEPOINT ${name}`,
  };
  return {
    query: (sql: string, params?: unknown[]) =>
      serial(() => holder.client!.query(statement[sql.trim().toUpperCase()] ?? sql, params)),
    release: () => {},
  };
};

vi.mock('../config/db', () => ({ getUsersDb: () => ({ query, connect }) }));

import { registerSalesOrdersRoutes } from './sales-orders.routes';
import { validationHook } from '../lib/validation-hook';
import { errorHandler } from '../lib/error-handler';
import { mapSalesOrderError } from '../lib/pv-errors';

let PROJECT_A = 0;
let PROJECT_B = 0;
let ID_USER = 0;

// Fixtures created inside the rolled-back transaction.
const F = {
  cliente: '',
  clienteLista: '',
  clienteInactivo: '',
  clienteOtroProyecto: '',
  resma: '', // precio_venta_linea 18000
  lapicero: '', // precio_venta_linea 2500
  cuaderno: '', // precio_venta_linea 9990
  productoOtroProyecto: '',
};

const NOMBRE_CLIENTE = 'Cliente PV Test Zq';
const NOMBRE_CLIENTE_LISTA = 'Lista PV Kx Ñandú';

function buildApp(id_own_project: number) {
  const app = new OpenAPIHono<any>({ defaultHook: validationHook });
  app.use('*', async (c, next) => {
    c.set('id_user', ID_USER);
    c.set('id_own_project', id_own_project);
    await next();
  });
  registerSalesOrdersRoutes(app);
  app.onError(errorHandler);
  return app;
}

type App = ReturnType<typeof buildApp>;

const call = async (app: App, path: string, method = 'GET', body?: unknown) => {
  const res = await app.request(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

const pedido = (overrides: Record<string, unknown> = {}) => ({
  id_customer: F.cliente,
  fecha: '2026-10-15',
  fecha_entrega: '2099-12-31',
  notas: 'Pedido de prueba',
  lineas: [{ id_product: F.resma, cantidad: 1 }],
  ...overrides,
});

describe('sales orders against the real database (rolled back)', () => {
  let a: App;
  let b: App;

  const crear = async (overrides: Record<string, unknown> = {}) => {
    const res = await call(a, '/sales-orders', 'POST', pedido(overrides));
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.data;
  };

  const accion = (id: string, nombre: string, app = a) => call(app, `/sales-orders/${id}/${nombre}`, 'POST');

  beforeAll(async () => {
    const env = (k: string) => process.env[k]?.trim() ?? '';
    holder.client = new Client({
      connectionString: `${env('DATABASE_BASE')}${env('TIENDAS_DB_REF')}:${env('DATABASE_PASSWORD')}${env('DATABASE_HOST')}`,
      ssl: { rejectUnauthorized: false },
    });
    await holder.client.connect();
    await holder.client.query('BEGIN');

    // Project A is one that already has a product: new test products copy its
    // category/warehouse/etiquetas so they satisfy the productos constraints.
    const template = await holder.client.query(
      `SELECT id_product, id_own_project FROM productos WHERE deleted_at IS NULL ORDER BY id_product LIMIT 1`
    );
    const users = await holder.client.query('SELECT id_user FROM users ORDER BY id_user LIMIT 1');
    if (!template.rowCount || !users.rowCount) {
      throw new Error('The database needs at least 1 product and 1 user to run these tests');
    }
    PROJECT_A = Number(template.rows[0].id_own_project);
    const other = await holder.client.query(
      'SELECT id_own_project FROM own_projects WHERE id_own_project <> $1 ORDER BY id_own_project LIMIT 1',
      [PROJECT_A]
    );
    if (!other.rowCount) throw new Error('The database needs at least 2 own_projects to run these tests');
    PROJECT_B = Number(other.rows[0].id_own_project);
    ID_USER = users.rows[0].id_user;

    const customer = async (project: number, nombre: string, active = true) =>
      (
        await holder.client!.query(
          `INSERT INTO customers (id_own_project, nombre, email, telefono, direccion, active)
           VALUES ($1, $2, $3, '300 123 4567', 'Calle 1 # 2-3', $4)
           RETURNING id_customer::text AS id`,
          [project, nombre, `pv.${++savepoint}@zz-test.example`, active]
        )
      ).rows[0].id as string;

    const product = async (project: number, nombre: string, sku: string, precio: number) =>
      (
        await holder.client!.query(
          `INSERT INTO productos
             (id_own_project, nombre, sku, precio_costo, precio_venta_linea, precio_venta_fisico, stock,
              id_category, etiquetas, id_warehouse, id_sales_point, descripcion)
           SELECT $1, $2, $3, 1000, $4, $4, 0, id_category, etiquetas, id_warehouse, id_sales_point, descripcion
           FROM productos WHERE id_product = $5
           RETURNING id_product::text AS id`,
          [project, nombre, sku, precio, template.rows[0].id_product]
        )
      ).rows[0].id as string;

    F.cliente = await customer(PROJECT_A, NOMBRE_CLIENTE);
    F.clienteLista = await customer(PROJECT_A, NOMBRE_CLIENTE_LISTA);
    F.clienteInactivo = await customer(PROJECT_A, 'Cliente PV Inactivo', false);
    F.clienteOtroProyecto = await customer(PROJECT_B, 'Cliente PV Otro Proyecto');
    F.resma = await product(PROJECT_A, 'Resma carta PV test', 'PV-RES', 18000);
    F.lapicero = await product(PROJECT_A, 'Lapicero PV test', 'PV-LAP', 2500);
    F.cuaderno = await product(PROJECT_A, 'Cuaderno PV test', 'PV-CUA', 9990);
    F.productoOtroProyecto = await product(PROJECT_B, 'Producto PV otro proyecto', 'PV-OTRO', 5000);

    a = buildApp(PROJECT_A);
    b = buildApp(PROJECT_B);
  }, 30_000);

  afterAll(async () => {
    if (holder.client) {
      await holder.client.query('ROLLBACK');
      await holder.client.end();
    }
  });

  it('crea y relee: número PED-xxxx consecutivo, snapshots, total, orden de líneas y auditoría', async () => {
    const res = await call(a, '/sales-orders', 'POST', pedido({
      lineas: [
        { id_product: F.lapicero, cantidad: 3, precio_unitario: 2000 },
        { id_product: Number(F.resma), cantidad: 2, precio_unitario: 18000 },
      ],
    }));

    expect(res.status).toBe(201);
    const data = res.body.data;
    expect(data).toMatchObject({
      id_own_project: PROJECT_A,
      id_customer: F.cliente,
      cliente_nombre: NOMBRE_CLIENTE,
      fecha: '2026-10-15',
      fecha_entrega: '2099-12-31',
      notas: 'Pedido de prueba',
      estado: 'Pendiente',
      total: '42000.00',
      atrasado: false,
      entregado_en: null,
    });
    // Inserting the lines makes the AFTER trigger recompute the header total,
    // so set_timestamps already filled updated_at on a brand-new order.
    expect(data.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(typeof data.id_sales_order).toBe('string');
    expect(typeof data.id_customer).toBe('string');
    expect(data.numero).toMatch(/^PED-\d{4,}$/);
    expect(new Date(data.created_at).toISOString()).toBe(data.created_at);
    expect(data.lineas).toEqual([
      {
        id_sales_order_line: expect.any(String),
        id_product: F.lapicero,
        producto_nombre: 'Lapicero PV test',
        referencia: 'PV-LAP',
        cantidad: 3,
        precio_unitario: '2000.00',
        subtotal: '6000.00',
      },
      {
        id_sales_order_line: expect.any(String),
        id_product: F.resma,
        producto_nombre: 'Resma carta PV test',
        referencia: 'PV-RES',
        cantidad: 2,
        precio_unitario: '18000.00',
        subtotal: '36000.00',
      },
    ]);

    const got = await call(a, `/sales-orders/${data.id_sales_order}`);
    expect(got.status).toBe(200);
    expect(got.body.data).toEqual(data);

    const raw = await query('SELECT created_by_user_id, updated_by_user_id FROM sales_orders WHERE id_sales_order = $1', [data.id_sales_order]);
    expect(raw.rows[0]).toEqual({ created_by_user_id: ID_USER, updated_by_user_id: null });

    // El siguiente pedido del proyecto toma el número siguiente.
    const next = await crear();
    expect(Number(next.numero.slice(4))).toBe(Number(data.numero.slice(4)) + 1);
  });

  it('precio_unitario null o ausente usa el precio_venta_linea del producto', async () => {
    const data = await crear({
      lineas: [
        { id_product: F.cuaderno, cantidad: 2, precio_unitario: null },
        { id_product: F.resma, cantidad: 1 },
      ],
    });
    expect(data.lineas.map((l: any) => [l.precio_unitario, l.subtotal])).toEqual([
      ['9990.00', '19980.00'],
      ['18000.00', '18000.00'],
    ]);
    expect(data.total).toBe('37980.00');

    const raw = await query('SELECT precio_venta_linea::numeric(14,2)::text AS p FROM productos WHERE id_product = $1', [F.cuaderno]);
    expect(raw.rows[0].p).toBe('9990.00');
  });

  it('edita en Pendiente y en En preparación (reemplaza todas las líneas, no cambia el estado)', async () => {
    const created = await crear({ lineas: [{ id_product: F.resma, cantidad: 1 }, { id_product: F.lapicero, cantidad: 1 }] });

    const edited = await call(a, `/sales-orders/${created.id_sales_order}`, 'PUT', pedido({
      fecha_entrega: '2099-12-30',
      notas: '  editado  ',
      lineas: [{ id_product: F.cuaderno, cantidad: 1, precio_unitario: 1000 }],
    }));
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({
      id_sales_order: created.id_sales_order,
      numero: created.numero,
      estado: 'Pendiente',
      notas: 'editado',
      fecha_entrega: '2099-12-30',
      total: '1000.00',
    });
    expect(edited.body.data.lineas.map((l: any) => l.id_product)).toEqual([F.cuaderno]);
    expect(edited.body.data.updated_at).not.toBeNull();
    const raw = await query('SELECT updated_by_user_id FROM sales_orders WHERE id_sales_order = $1', [created.id_sales_order]);
    expect(raw.rows[0].updated_by_user_id).toBe(ID_USER);

    expect((await accion(created.id_sales_order, 'prepare')).status).toBe(200);

    const again = await call(a, `/sales-orders/${created.id_sales_order}`, 'PUT', pedido({
      lineas: [{ id_product: F.resma, cantidad: 1 }, { id_product: F.lapicero, cantidad: 2 }],
    }));
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ estado: 'En preparación', total: '23000.00' });
    expect(again.body.data.lineas.map((l: any) => l.id_product)).toEqual([F.resma, F.lapicero]);
  });

  it('recorre todas las transiciones válidas y rechaza las inválidas', async () => {
    const { id_sales_order: id, numero } = await crear();

    const deliverTooSoon = await accion(id, 'deliver');
    expect(deliverTooSoon.status).toBe(409);
    expect(deliverTooSoon.body).toEqual({
      success: false,
      error: 'Conflict',
      message: `El pedido ${numero} no puede pasar de Pendiente a Entregado.`,
      code: 'PV_TRANSICION_INVALIDA',
    });

    const prepared = await accion(id, 'prepare');
    expect(prepared.status).toBe(200);
    expect(prepared.body.data).toMatchObject({ estado: 'En preparación', entregado_en: null });
    expect(prepared.body.data.lineas).toHaveLength(1);

    const shipped = await accion(id, 'ship');
    expect(shipped.status).toBe(200);
    expect(shipped.body.data).toMatchObject({ estado: 'En camino', entregado_en: null });

    // En camino ya no se edita.
    const edit = await call(a, `/sales-orders/${id}`, 'PUT', pedido());
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe('PV_PEDIDO_NO_EDITABLE');

    const delivered = await accion(id, 'deliver');
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.estado).toBe('Entregado');
    expect(delivered.body.data.entregado_en).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);

    const raw = await query('SELECT updated_by_user_id FROM sales_orders WHERE id_sales_order = $1', [id]);
    expect(raw.rows[0].updated_by_user_id).toBe(ID_USER);

    // Entregado es final.
    const cancel = await accion(id, 'cancel');
    expect(cancel.status).toBe(409);
    expect(cancel.body.code).toBe('PV_TRANSICION_INVALIDA');
    expect((await call(a, `/sales-orders/${id}`)).body.data.estado).toBe('Entregado');
  });

  it('cancela desde Pendiente, En preparación y En camino; Cancelado es final', async () => {
    const pendiente = await crear();
    const preparacion = await crear();
    const camino = await crear();
    await accion(preparacion.id_sales_order, 'prepare');
    await accion(camino.id_sales_order, 'prepare');
    await accion(camino.id_sales_order, 'ship');

    for (const p of [pendiente, preparacion, camino]) {
      const res = await accion(p.id_sales_order, 'cancel');
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ estado: 'Cancelado', entregado_en: null });
    }
    expect((await accion(pendiente.id_sales_order, 'prepare')).body.code).toBe('PV_TRANSICION_INVALIDA');
  });

  it('borra solo en Pendiente (borrado lógico) y luego responde 404', async () => {
    const enPreparacion = await crear();
    await accion(enPreparacion.id_sales_order, 'prepare');
    const blocked = await call(a, `/sales-orders/${enPreparacion.id_sales_order}`, 'DELETE');
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('PV_BORRADO_NO_PERMITIDO');

    const pendiente = await crear();
    const deleted = await call(a, `/sales-orders/${pendiente.id_sales_order}`, 'DELETE');
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.id_sales_order).toBe(pendiente.id_sales_order);

    const raw = await query(
      'SELECT deleted_at IS NOT NULL AS borrado, deleted_by_user_id FROM sales_orders WHERE id_sales_order = $1',
      [pendiente.id_sales_order]
    );
    expect(raw.rows[0]).toEqual({ borrado: true, deleted_by_user_id: ID_USER });

    for (const [method, suffix] of [['GET', ''], ['DELETE', ''], ['POST', '/prepare']]) {
      const res = await call(a, `/sales-orders/${pendiente.id_sales_order}${suffix}`, method);
      expect(res.status, `${method} ${suffix}`).toBe(404);
      expect(res.body.code).toBe('PV_PEDIDO_NO_ENCONTRADO');
    }
    expect((await call(a, `/sales-orders/${pendiente.id_sales_order}`, 'PUT', pedido())).status).toBe(404);
  });

  it('rechaza un cliente de otro proyecto o inactivo sin dejar el pedido creado', async () => {
    const otro = await call(a, '/sales-orders', 'POST', pedido({ id_customer: F.clienteOtroProyecto }));
    expect(otro.status).toBe(400);
    expect(otro.body).toEqual({
      success: false,
      error: 'Bad Request',
      message: `El cliente ${F.clienteOtroProyecto} no pertenece al proyecto del pedido.`,
      code: 'PV_CLIENTE_OTRO_PROYECTO',
    });

    const inactivo = await call(a, '/sales-orders', 'POST', pedido({ id_customer: F.clienteInactivo }));
    expect(inactivo.status).toBe(400);
    expect(inactivo.body.code).toBe('PV_CLIENTE_INACTIVO');

    const noExiste = await call(a, '/sales-orders', 'POST', pedido({ id_customer: '999999999999' }));
    expect(noExiste.status).toBe(400);
    expect(noExiste.body.code).toBe('PV_CLIENTE_NO_ENCONTRADO');

    const raw = await query('SELECT count(*)::int AS n FROM sales_orders WHERE id_customer = ANY($1::bigint[])', [
      [F.clienteOtroProyecto, F.clienteInactivo],
    ]);
    expect(raw.rows[0].n).toBe(0);
  });

  it('un producto de otro proyecto deshace también la cabecera (atomicidad)', async () => {
    const before = await query('SELECT count(*)::int AS n FROM sales_orders WHERE id_own_project = $1', [PROJECT_A]);
    const res = await call(a, '/sales-orders', 'POST', pedido({
      lineas: [{ id_product: F.resma, cantidad: 1 }, { id_product: F.productoOtroProyecto, cantidad: 1 }],
    }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('PV_PRODUCTO_OTRO_PROYECTO');
    const after = await query('SELECT count(*)::int AS n FROM sales_orders WHERE id_own_project = $1', [PROJECT_A]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('producto repetido: la API lo rechaza antes y la BD también lo bloquea', async () => {
    const api = await call(a, '/sales-orders', 'POST', pedido({
      lineas: [{ id_product: F.resma, cantidad: 1 }, { id_product: Number(F.resma), cantidad: 2 }],
    }));
    expect(api.status).toBe(400);
    expect(api.body).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'Línea 2: Este producto ya está en el pedido',
      code: 'PV_VALIDACION',
    });

    // Directo a la BD, saltando la validación del API.
    const { id_sales_order: id } = await crear({ lineas: [{ id_product: F.resma, cantidad: 1 }] });
    const err = await query(
      'INSERT INTO sales_order_lines (id_sales_order, id_product, cantidad) VALUES ($1, $2, 1)',
      [id, F.resma]
    ).catch((e) => e);
    expect(err.code).toBe('P0001');
    expect(err.detail).toBe('PV_PRODUCTO_REPETIDO');
    expect(mapSalesOrderError(err)).toMatchObject({ status: 400, body: { code: 'PV_PRODUCTO_REPETIDO' } });
  });

  it('aísla proyectos: otro proyecto recibe 404 y nunca lo lista', async () => {
    const own = await crear();
    for (const [method, suffix, body] of [
      ['GET', '', undefined],
      ['PUT', '', pedido()],
      ['POST', '/prepare', undefined],
      ['POST', '/cancel', undefined],
      ['DELETE', '', undefined],
    ] as const) {
      const res = await call(b, `/sales-orders/${own.id_sales_order}${suffix}`, method, body);
      expect(res.status, `${method} ${suffix}`).toBe(404);
    }
    const list = await call(b, `/sales-orders?id_customer=${F.cliente}`);
    expect(list.body.data).toEqual([]);
    expect((await call(a, `/sales-orders/${own.id_sales_order}`)).body.data.estado).toBe('Pendiente');
  });

  it('lista con filtros, orden fecha DESC + número DESC, paginación y líneas agrupadas', async () => {
    const viejo = await crear({ id_customer: F.clienteLista, fecha: '2026-01-10', fecha_entrega: '2026-01-11' });
    const medio = await crear({ id_customer: F.clienteLista, fecha: '2026-05-10', fecha_entrega: '2099-01-01', lineas: [{ id_product: F.resma, cantidad: 1 }, { id_product: F.lapicero, cantidad: 1 }] });
    const nuevo1 = await crear({ id_customer: F.clienteLista, fecha: '2026-09-10', fecha_entrega: '2099-01-01' });
    const nuevo2 = await crear({ id_customer: F.clienteLista, fecha: '2026-09-10', fecha_entrega: '2099-01-01' });
    await accion(medio.id_sales_order, 'prepare');

    const all = await call(a, `/sales-orders?id_customer=${F.clienteLista}`);
    expect(all.status).toBe(200);
    expect(all.body.pagination).toEqual({ page: 1, limit: 10, total: 4, totalPages: 1 });
    expect(all.body.data.map((o: any) => o.id_sales_order)).toEqual([
      nuevo2.id_sales_order,
      nuevo1.id_sales_order,
      medio.id_sales_order,
      viejo.id_sales_order,
    ]);
    expect(all.body.data[2].lineas.map((l: any) => l.id_product)).toEqual([F.resma, F.lapicero]);
    expect(all.body.data.every((o: any) => o.lineas.length > 0)).toBe(true);

    const page2 = await call(a, `/sales-orders?id_customer=${F.clienteLista}&limit=3&page=2`);
    expect(page2.body.pagination).toEqual({ page: 2, limit: 3, total: 4, totalPages: 2 });
    expect(page2.body.data.map((o: any) => o.id_sales_order)).toEqual([viejo.id_sales_order]);

    const search = await call(a, `/sales-orders?search=${encodeURIComponent('lista pv kx ñ')}`);
    expect(search.body.pagination.total).toBe(4);
    const byNumero = await call(a, `/sales-orders?search=${encodeURIComponent(medio.numero.toLowerCase())}`);
    expect(byNumero.body.data.map((o: any) => o.id_sales_order)).toContain(medio.id_sales_order);
    const literal = await call(a, `/sales-orders?search=${encodeURIComponent('PV_Kx')}`);
    expect(literal.body.data).toEqual([]); // "_" no es comodín

    const estado = await call(a, `/sales-orders?id_customer=${F.clienteLista}&estado=${encodeURIComponent('En preparación')}`);
    expect(estado.body.data.map((o: any) => o.id_sales_order)).toEqual([medio.id_sales_order]);

    // atrasado viene de la vista (current_date en UTC): la entrega de 'viejo' ya pasó.
    const atrasados = await call(a, `/sales-orders?id_customer=${F.clienteLista}&atrasado=true`);
    expect(atrasados.body.data.map((o: any) => o.id_sales_order)).toEqual([viejo.id_sales_order]);
    expect(atrasados.body.data[0].atrasado).toBe(true);

    const rango = await call(a, `/sales-orders?id_customer=${F.clienteLista}&fecha_desde=2026-05-01&fecha_hasta=2026-09-09`);
    expect(rango.body.data.map((o: any) => o.id_sales_order)).toEqual([medio.id_sales_order]);
  });
});
