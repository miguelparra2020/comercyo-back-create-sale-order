// Integration tests against the real sales_orders tables (supabase-tiendas,
// migrations 20261015031310_create_sales_orders and
// 20261017034032_sales_orders_ajustes). Run with `npm run test:db` -
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

// RELEASE SAVEPOINT does not fire deferred constraint triggers (they wait for
// the real COMMIT), so the emulated COMMIT forces them with SET CONSTRAINTS
// ALL IMMEDIATE: trg_so_70_ajustes (PV_DESCUENTO_EXCEDE_SUBTOTAL) then fails
// at the same point it would in production. BEGIN puts them back to deferred.
const connect = async () => {
  const name = `tx_${++savepoint}`;
  const statements: Record<string, string[]> = {
    BEGIN: [`SAVEPOINT ${name}`, 'SET CONSTRAINTS ALL DEFERRED'],
    COMMIT: ['SET CONSTRAINTS ALL IMMEDIATE', 'SET CONSTRAINTS ALL DEFERRED', `RELEASE SAVEPOINT ${name}`],
    ROLLBACK: [`ROLLBACK TO SAVEPOINT ${name}`],
  };
  return {
    query: (sql: string, params?: unknown[]) =>
      serial(async () => {
        const tx = statements[sql.trim().toUpperCase()];
        if (!tx) return holder.client!.query(sql, params);
        let result;
        for (const statement of tx) result = await holder.client!.query(statement);
        return result!;
      }),
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

  // ---------------------------------------------------------------------------
  // Ajustes (migración 20261017034032_sales_orders_ajustes)
  // ---------------------------------------------------------------------------
  describe('ajustes: descuento, impuesto y envío', () => {
    const SIN_AJUSTES = { descuento_tipo: null, descuento_valor: 0, impuesto_tipo: null, impuesto_valor: 0, costo_envio: 0 };
    const AJUSTE_KEYS = [
      'descuento_tipo',
      'descuento_valor',
      'impuesto_tipo',
      'impuesto_valor',
      'costo_envio',
      'subtotal',
      'descuento_monto',
      'impuesto_monto',
      'total',
    ];

    it('crea con 10% de descuento, 19% de impuesto y 8000 de envío: la BD calcula subtotal, montos y total', async () => {
      const data = await crear({
        lineas: [
          { id_product: F.lapicero, cantidad: 2, precio_unitario: 2000 },
          { id_product: F.cuaderno, cantidad: 3, precio_unitario: 900 },
        ],
        descuento_tipo: 'porcentaje',
        descuento_valor: 10,
        impuesto_tipo: 'porcentaje',
        impuesto_valor: 19,
        costo_envio: 8000,
        // calculados: se ignoran
        subtotal: 1,
        descuento_monto: 1,
        impuesto_monto: 1,
        total: 1,
      });

      // 6700 - 670 = 6030; 6030 × 19% = 1145.70; 6030 + 1145.70 + 8000 = 15175.70
      expect(data).toMatchObject({
        descuento_tipo: 'porcentaje',
        descuento_valor: '10.00',
        impuesto_tipo: 'porcentaje',
        impuesto_valor: '19.00',
        costo_envio: '8000.00',
        subtotal: '6700.00',
        descuento_monto: '670.00',
        impuesto_monto: '1145.70',
        total: '15175.70',
      });
      expect((await call(a, `/sales-orders/${data.id_sales_order}`)).body.data).toEqual(data);
    });

    it('edita un pedido con descuento fijo reemplazando sus líneas en el mismo PUT', async () => {
      const created = await crear({
        lineas: [{ id_product: F.resma, cantidad: 1 }], // 18000
        descuento_tipo: 'valor',
        descuento_valor: 5000,
      });
      expect(created).toMatchObject({ subtotal: '18000.00', descuento_monto: '5000.00', total: '13000.00' });

      // Al borrar las líneas el subtotal es 0 por un momento (< descuento); el
      // trigger diferido solo mira el estado final. La línea sin precio usa el
      // del producto, así que este tope lo valida la BD y no zod.
      const edited = await call(a, `/sales-orders/${created.id_sales_order}`, 'PUT', pedido({
        lineas: [{ id_product: F.cuaderno, cantidad: 1 }], // 9990
        descuento_tipo: 'valor',
        descuento_valor: 5000,
        impuesto_tipo: 'valor',
        impuesto_valor: 500,
        costo_envio: 0,
      }));
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.data).toMatchObject({
        descuento_tipo: 'valor',
        descuento_valor: '5000.00',
        subtotal: '9990.00',
        descuento_monto: '5000.00',
        impuesto_monto: '500.00',
        total: '5490.00',
      });
      expect(edited.body.data.lineas.map((l: any) => l.id_product)).toEqual([F.cuaderno]);
    });

    it('PUT sin los campos de ajustes conserva los valores guardados', async () => {
      const created = await crear({ descuento_tipo: 'porcentaje', descuento_valor: 10, costo_envio: 2000 });
      const edited = await call(a, `/sales-orders/${created.id_sales_order}`, 'PUT', pedido({ notas: 'cliente viejo' }));
      expect(edited.status).toBe(200);
      expect(edited.body.data).toMatchObject({
        notas: 'cliente viejo',
        descuento_tipo: 'porcentaje',
        descuento_valor: '10.00',
        costo_envio: '2000.00',
        subtotal: '18000.00',
        descuento_monto: '1800.00',
        total: '18200.00',
      });
    });

    it('descuento fijo mayor que las líneas -> 400 PV_DESCUENTO_EXCEDE_SUBTOTAL (desde el COMMIT) sin dejar el pedido', async () => {
      const before = await query('SELECT count(*)::int AS n FROM sales_orders WHERE id_own_project = $1', [PROJECT_A]);

      // Sin precio en la línea la API no puede comparar: lo rechaza el trigger diferido.
      const porBd = await call(a, '/sales-orders', 'POST', pedido({
        lineas: [{ id_product: F.resma, cantidad: 1 }], // 18000
        descuento_tipo: 'valor',
        descuento_valor: 18000.01,
      }));
      expect(porBd.status).toBe(400);
      expect(porBd.body).toEqual({
        success: false,
        error: 'Bad Request',
        message: 'El descuento no puede ser mayor al subtotal del pedido',
        code: 'PV_DESCUENTO_EXCEDE_SUBTOTAL',
      });

      // Con precio explícito lo ataja zod, con el mismo código y mensaje.
      const api = await call(a, '/sales-orders', 'POST', pedido({
        lineas: [{ id_product: F.resma, cantidad: 1, precio_unitario: 100 }],
        descuento_tipo: 'valor',
        descuento_valor: 100.01,
      }));
      expect(api.status).toBe(400);
      expect(api.body).toEqual(porBd.body);

      const after = await query('SELECT count(*)::int AS n FROM sales_orders WHERE id_own_project = $1', [PROJECT_A]);
      expect(after.rows[0].n).toBe(before.rows[0].n);

      // También al editar: bajar las líneas por debajo del descuento fijo.
      const created = await crear({ lineas: [{ id_product: F.resma, cantidad: 1 }], descuento_tipo: 'valor', descuento_valor: 10000 });
      const edit = await call(a, `/sales-orders/${created.id_sales_order}`, 'PUT', pedido({
        lineas: [{ id_product: F.lapicero, cantidad: 1 }], // 2500 < 10000, sin precio -> lo valida la BD
      }));
      expect(edit.status).toBe(400);
      expect(edit.body.code).toBe('PV_DESCUENTO_EXCEDE_SUBTOTAL');
      expect(edit.body.message).toBe('El descuento no puede ser mayor al subtotal del pedido');
      // rollback: el pedido sigue como estaba
      expect((await call(a, `/sales-orders/${created.id_sales_order}`)).body.data).toMatchObject({
        subtotal: '18000.00',
        total: '8000.00',
      });
    });

    it("editar ajustes en 'En camino' -> 409 PV_PEDIDO_NO_EDITABLE", async () => {
      const { id_sales_order: id } = await crear();
      await accion(id, 'prepare');
      await accion(id, 'ship');

      // Solo cambia un ajuste: misma cabecera y mismas líneas.
      const res = await call(a, `/sales-orders/${id}`, 'PUT', pedido({ costo_envio: 3000 }));
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PV_PEDIDO_NO_EDITABLE');
      expect((await call(a, `/sales-orders/${id}`)).body.data.costo_envio).toBe('0.00');
    });

    it('/prepare, /ship, /deliver y /cancel devuelven los 9 campos', async () => {
      const ajustes = { descuento_tipo: 'porcentaje', descuento_valor: 10, impuesto_tipo: 'valor', impuesto_valor: 1000, costo_envio: 500 };
      // 18000 - 1800 = 16200; + 1000 + 500 = 17700
      const esperado = {
        descuento_tipo: 'porcentaje',
        descuento_valor: '10.00',
        impuesto_tipo: 'valor',
        impuesto_valor: '1000.00',
        costo_envio: '500.00',
        subtotal: '18000.00',
        descuento_monto: '1800.00',
        impuesto_monto: '1000.00',
        total: '17700.00',
      };
      const uno = await crear(ajustes);
      for (const nombre of ['prepare', 'ship', 'deliver']) {
        const res = await accion(uno.id_sales_order, nombre);
        expect(res.status, nombre).toBe(200);
        expect(res.body.data, nombre).toMatchObject(esperado);
      }
      const dos = await crear(ajustes);
      const cancel = await accion(dos.id_sales_order, 'cancel');
      expect(cancel.status).toBe(200);
      expect(cancel.body.data).toMatchObject(esperado);

      const list = await call(a, `/sales-orders?search=${encodeURIComponent(dos.numero)}`);
      expect(list.body.data[0]).toMatchObject(esperado);
    });

    it('un pedido sin ajustes devuelve subtotal = total y descuento/impuesto/envío en 0', async () => {
      // Cliente viejo: no manda ninguno de los 5 campos.
      const data = await crear({ lineas: [{ id_product: F.resma, cantidad: 2 }] });
      for (const key of AJUSTE_KEYS) expect(data, key).toHaveProperty(key);
      expect(data).toMatchObject({
        descuento_tipo: null,
        descuento_valor: '0.00',
        impuesto_tipo: null,
        impuesto_valor: '0.00',
        costo_envio: '0.00',
        subtotal: '36000.00',
        descuento_monto: '0.00',
        impuesto_monto: '0.00',
        total: '36000.00',
      });
      // Igual con el contrato del frontend (manda los 5 campos "vacíos").
      const front = await crear({ lineas: [{ id_product: F.resma, cantidad: 2 }], ...SIN_AJUSTES });
      expect(front).toMatchObject({ subtotal: '36000.00', total: '36000.00', descuento_monto: '0.00', impuesto_monto: '0.00' });
    });

    it('los CHECK de la BD respaldan a zod y se traducen a 400 con mensaje en español', async () => {
      const { id_sales_order: id } = await crear();
      for (const [set, code] of [
        [`descuento_tipo = 'fijo'`, 'PV_DESCUENTO_TIPO_INVALIDO'],
        [`impuesto_valor = 5`, 'PV_IMPUESTO_SIN_TIPO'],
        [`descuento_tipo = 'porcentaje', descuento_valor = 101`, 'PV_DESCUENTO_PORCENTAJE_INVALIDO'],
        [`costo_envio = -1`, 'PV_COSTO_ENVIO_NEGATIVO'],
      ]) {
        const err = await query(`UPDATE sales_orders SET ${set} WHERE id_sales_order = $1`, [id]).catch((e) => e);
        expect(err.code, set).toBe('23514');
        expect(mapSalesOrderError(err), set).toMatchObject({ status: 400, body: { code } });
      }
    });
  });
});
