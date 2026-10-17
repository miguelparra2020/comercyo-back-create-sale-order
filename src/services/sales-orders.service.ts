import type { Pool, PoolClient } from 'pg';
import { escapeLike } from '../lib/like';
import { orderNotFound } from '../lib/pv-errors';
import { withTransaction } from '../lib/transaction';
import {
  AJUSTES_COLUMNS,
  type Estado,
  type ListQuery,
  type OrderBody,
  type OrderLineInput,
  type TipoAjuste,
  type UpdateOrderBody,
} from '../validation/sales-orders.validation';

type Db = Pick<Pool, 'query' | 'connect'>;
type Queryable = Pick<Pool | PoolClient, 'query'>;

export type Scope = {
  id_own_project: number;
  id_user: number;
};

// Target state of each action route (POST /sales-orders/:id/<action>).
export const TRANSICIONES = {
  prepare: 'En preparación',
  ship: 'En camino',
  deliver: 'Entregado',
  cancel: 'Cancelado',
} as const satisfies Record<string, Estado>;

export type Transicion = keyof typeof TRANSICIONES;

export type SalesOrderLineDto = {
  id_sales_order_line: string;
  id_product: string;
  producto_nombre: string;
  referencia: string;
  cantidad: number;
  precio_unitario: string;
  subtotal: string;
};

export type SalesOrderDto = {
  id_sales_order: string;
  id_own_project: number;
  numero: string;
  id_customer: string;
  cliente_nombre: string;
  fecha: string;
  fecha_entrega: string;
  notas: string;
  estado: Estado;
  // Adjustments sent by the API.
  descuento_tipo: TipoAjuste | null;
  descuento_valor: string;
  impuesto_tipo: TipoAjuste | null;
  impuesto_valor: string;
  costo_envio: string;
  // Computed by the DB (sales_orders_sync_total), read-only.
  subtotal: string;
  descuento_monto: string;
  impuesto_monto: string;
  total: string;
  atrasado: boolean;
  entregado_en: string | null;
  created_at: string;
  updated_at: string | null;
  lineas: SalesOrderLineDto[];
};

// --------------------------------------------------------------------------
// SQL
// --------------------------------------------------------------------------

// Dates go out through to_char so they are plain 'YYYY-MM-DD' strings: pg
// would otherwise parse a `date` into a JS Date at local midnight, which
// shifts a day when serialized to UTC. bigint/numeric are cast to text so
// they never lose precision.
const orderColumns = (atrasado: string) => `
  so.id_sales_order::text AS id_sales_order,
  so.id_own_project::text AS id_own_project,
  so.numero,
  so.id_customer::text AS id_customer,
  so.cliente_nombre,
  to_char(so.fecha, 'YYYY-MM-DD') AS fecha,
  to_char(so.fecha_entrega, 'YYYY-MM-DD') AS fecha_entrega,
  so.notas,
  so.estado::text AS estado,
  so.descuento_tipo,
  so.descuento_valor::text AS descuento_valor,
  so.impuesto_tipo,
  so.impuesto_valor::text AS impuesto_valor,
  so.costo_envio::text AS costo_envio,
  so.subtotal::text AS subtotal,
  so.descuento_monto::text AS descuento_monto,
  so.impuesto_monto::text AS impuesto_monto,
  so.total::text AS total,
  ${atrasado} AS atrasado,
  so.entregado_en,
  so.created_at,
  so.updated_at
`;

// Same definition as v_sales_orders.atrasado, for reads off the base table.
const ATRASADO_EXPRESSION = `(so.estado IN ('Pendiente', 'En preparación', 'En camino') AND so.fecha_entrega < current_date)`;

const SELECT_ORDER_FROM_VIEW = `SELECT ${orderColumns('so.atrasado')} FROM v_sales_orders so`;

const LINE_COLUMNS = `
  id_sales_order::text AS id_sales_order,
  id_sales_order_line::text AS id_sales_order_line,
  id_product::text AS id_product,
  producto_nombre,
  referencia,
  cantidad,
  precio_unitario::text AS precio_unitario,
  subtotal::text AS subtotal
`;

// numero is 'PED-' + a zero-padded counter that grows past 4 digits
// ('PED-10000' > 'PED-9999'), so order by length first to sort numerically.
const LIST_ORDER_BY = `ORDER BY so.fecha DESC, length(so.numero) DESC, so.numero DESC`;

// --------------------------------------------------------------------------
// Serialization
// --------------------------------------------------------------------------

const toIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

// Normally already a 'YYYY-MM-DD' string (see orderColumns). If a Date ever
// shows up, pg built it at local midnight, so read it back with local getters.
export const toDateOnly = (value: unknown): string => {
  if (value instanceof Date) {
    const y = String(value.getFullYear()).padStart(4, '0');
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value);
};

export const toLineDto = (row: any): SalesOrderLineDto => ({
  id_sales_order_line: String(row.id_sales_order_line),
  id_product: String(row.id_product),
  producto_nombre: row.producto_nombre,
  referencia: row.referencia,
  cantidad: Number(row.cantidad),
  precio_unitario: String(row.precio_unitario),
  subtotal: String(row.subtotal),
});

// id_own_project is a number (as in purchase orders); id_customer is a
// string (as comercyo-back-create-customers returns it).
export const toOrderDto = (row: any, lineas: SalesOrderLineDto[]): SalesOrderDto => ({
  id_sales_order: String(row.id_sales_order),
  id_own_project: Number(row.id_own_project),
  numero: row.numero,
  id_customer: String(row.id_customer),
  cliente_nombre: row.cliente_nombre,
  fecha: toDateOnly(row.fecha),
  fecha_entrega: toDateOnly(row.fecha_entrega),
  notas: row.notas,
  estado: row.estado,
  descuento_tipo: row.descuento_tipo ?? null,
  descuento_valor: String(row.descuento_valor),
  impuesto_tipo: row.impuesto_tipo ?? null,
  impuesto_valor: String(row.impuesto_valor),
  costo_envio: String(row.costo_envio),
  subtotal: String(row.subtotal),
  descuento_monto: String(row.descuento_monto),
  impuesto_monto: String(row.impuesto_monto),
  total: String(row.total),
  atrasado: row.atrasado === true,
  entregado_en: toIso(row.entregado_en),
  created_at: toIso(row.created_at),
  updated_at: toIso(row.updated_at),
  lineas,
});

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

// The lines of every order on the page come from ONE query and are grouped in
// memory - never one query per order. Lines are inserted in request order
// (WITH ORDINALITY), so the identity id keeps that order.
const fetchLines = async (db: Queryable, orderIds: string[]) => {
  const byOrder = new Map<string, SalesOrderLineDto[]>(orderIds.map((id) => [id, []]));
  if (!orderIds.length) return byOrder;

  const { rows } = await db.query(
    `SELECT ${LINE_COLUMNS} FROM sales_order_lines
     WHERE id_sales_order = ANY($1::bigint[])
     ORDER BY id_sales_order_line ASC`,
    [orderIds]
  );
  for (const row of rows) {
    byOrder.get(String(row.id_sales_order))?.push(toLineDto(row));
  }
  return byOrder;
};

const withLines = async (db: Queryable, rows: any[]) => {
  const lines = await fetchLines(db, rows.map((row) => String(row.id_sales_order)));
  return rows.map((row) => toOrderDto(row, lines.get(String(row.id_sales_order)) ?? []));
};

const findOrder = async (db: Queryable, id: string, id_own_project: number) => {
  const { rows } = await db.query(
    `${SELECT_ORDER_FROM_VIEW} WHERE so.id_sales_order = $1 AND so.id_own_project = $2`,
    [id, id_own_project]
  );
  if (!rows[0]) return null;
  const [order] = await withLines(db, rows);
  return order;
};

export const getSalesOrder = async (db: Db, id: string, id_own_project: number) => {
  const order = await findOrder(db, id, id_own_project);
  if (!order) throw orderNotFound();
  return order;
};

export const listSalesOrders = async (db: Db, id_own_project: number, query: ListQuery) => {
  const { search, estado, id_customer, atrasado, fecha_desde, fecha_hasta, page, limit } = query;

  const conditions = ['so.id_own_project = $1'];
  const values: unknown[] = [id_own_project];
  const add = (sql: (param: string) => string, value: unknown) => {
    values.push(value);
    conditions.push(sql(`$${values.length}`));
  };

  if (search) {
    add((p) => `(so.numero ILIKE '%' || ${p}::text || '%' OR so.cliente_nombre ILIKE '%' || ${p}::text || '%')`, escapeLike(search));
  }
  if (estado) add((p) => `so.estado = ${p}::sales_order_status`, estado);
  if (id_customer) add((p) => `so.id_customer = ${p}::bigint`, id_customer);
  if (atrasado !== undefined) add((p) => `so.atrasado = ${p}::boolean`, atrasado);
  if (fecha_desde) add((p) => `so.fecha >= ${p}::date`, fecha_desde);
  if (fecha_hasta) add((p) => `so.fecha <= ${p}::date`, fecha_hasta);

  const where = conditions.join(' AND ');
  const filterValues = [...values];
  const offset = (page - 1) * limit;

  const [countResult, pageResult] = await Promise.all([
    db.query(`SELECT count(*)::int AS total FROM v_sales_orders so WHERE ${where}`, filterValues),
    db.query(
      `${SELECT_ORDER_FROM_VIEW} WHERE ${where} ${LIST_ORDER_BY}
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...filterValues, limit, offset]
    ),
  ]);

  const total = Number(countResult.rows[0]?.total ?? 0);
  const data = await withLines(db, pageResult.rows);
  return { data, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
};

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

// One statement for every line, so the AFTER-statement trigger recalculates
// the order total once. A null precio_unitario lets the DB trigger use the
// product's precio_venta_linea. WITH ORDINALITY keeps the request's line order.
const insertLines = (client: Queryable, id: string, lineas: OrderLineInput[]) =>
  client.query(
    `INSERT INTO sales_order_lines (id_sales_order, id_product, cantidad, precio_unitario)
     SELECT $1::bigint, l.id_product, l.cantidad, l.precio_unitario
     FROM unnest($2::bigint[], $3::int[], $4::numeric[]) WITH ORDINALITY AS l(id_product, cantidad, precio_unitario, ord)
     ORDER BY l.ord`,
    [
      id,
      lineas.map((l) => l.id_product),
      lineas.map((l) => l.cantidad),
      lineas.map((l) => l.precio_unitario),
    ]
  );

const reread = async (client: Queryable, id: string, scope: Scope) => {
  const order = await findOrder(client, id, scope.id_own_project);
  if (!order) throw orderNotFound();
  return order;
};

// The DB forces new orders into 'Pendiente' and fills numero, cliente_nombre
// and the line snapshots. All three steps share one transaction.
// subtotal/descuento_monto/impuesto_monto/total are never written: the
// trigger computes them. The header goes in with subtotal 0, so a fixed
// discount is only checked against the lines at COMMIT (deferred trigger).
export const createSalesOrder = (db: Db, scope: Scope, input: OrderBody) =>
  withTransaction(db, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO sales_orders
         (id_own_project, id_customer, fecha, fecha_entrega, notas, created_by_user_id,
          descuento_tipo, descuento_valor, impuesto_tipo, impuesto_valor, costo_envio)
       VALUES ($1, $2::bigint, $3::date, $4::date, $5, $6, $7, $8::numeric, $9, $10::numeric, $11::numeric)
       RETURNING id_sales_order::text AS id_sales_order`,
      [
        scope.id_own_project,
        input.id_customer,
        input.fecha,
        input.fecha_entrega,
        input.notas,
        scope.id_user,
        ...AJUSTES_COLUMNS.map((column) => input[column]),
      ]
    );
    const id = rows[0].id_sales_order as string;

    await insertLines(client, id, input.lineas);
    return reread(client, id, scope);
  });

// Header update -> drop all lines -> insert the new ones. The DB rejects each
// step outside 'Pendiente'/'En preparación' (PV_PEDIDO_NO_EDITABLE), which
// rolls the whole thing back. Editing never changes the state.
// Adjustments left out of the body (undefined) are not in the SET, so they
// keep their current value.
export const updateSalesOrder = (db: Db, scope: Scope, id: string, input: UpdateOrderBody) =>
  withTransaction(db, async (client) => {
    const values: unknown[] = [input.id_customer, input.fecha, input.fecha_entrega, input.notas];
    const ajustes = AJUSTES_COLUMNS.filter((column) => input[column] !== undefined).map((column) => {
      values.push(input[column]);
      return `, ${column} = $${values.length}${column.endsWith('_tipo') ? '' : '::numeric'}`;
    });
    const n = values.length;
    const header = await client.query(
      `UPDATE sales_orders
       SET id_customer = $1::bigint, fecha = $2::date, fecha_entrega = $3::date, notas = $4${ajustes.join('')},
           updated_by_user_id = $${n + 1}
       WHERE id_sales_order = $${n + 2} AND id_own_project = $${n + 3} AND deleted_at IS NULL`,
      [...values, scope.id_user, id, scope.id_own_project]
    );
    if (!header.rowCount) throw orderNotFound();

    await client.query(`DELETE FROM sales_order_lines WHERE id_sales_order = $1`, [id]);
    await insertLines(client, id, input.lineas);
    return reread(client, id, scope);
  });

// The DB trigger enforces the state machine (PV_TRANSICION_INVALIDA) and sets
// entregado_en on 'Entregado'.
export const transitionSalesOrder = (db: Db, scope: Scope, id: string, accion: Transicion) =>
  withTransaction(db, async (client) => {
    const result = await client.query(
      `UPDATE sales_orders SET estado = $1::sales_order_status, updated_by_user_id = $2
       WHERE id_sales_order = $3 AND id_own_project = $4 AND deleted_at IS NULL`,
      [TRANSICIONES[accion], scope.id_user, id, scope.id_own_project]
    );
    if (!result.rowCount) throw orderNotFound();
    return reread(client, id, scope);
  });

// Soft delete. The DB trigger only allows it in 'Pendiente' (PV_BORRADO_NO_PERMITIDO).
// v_sales_orders hides the row from now on, so the response comes from
// RETURNING on the base table.
export const deleteSalesOrder = async (db: Db, scope: Scope, id: string) => {
  const result = await db.query(
    `UPDATE sales_orders so SET deleted_at = now(), deleted_by_user_id = $1
     WHERE so.id_sales_order = $2 AND so.id_own_project = $3 AND so.deleted_at IS NULL
     RETURNING ${orderColumns(ATRASADO_EXPRESSION)}`,
    [scope.id_user, id, scope.id_own_project]
  );
  if (!result.rowCount) throw orderNotFound();
  const [order] = await withLines(db, result.rows);
  return order;
};
