import type { Pool, PoolClient } from 'pg';
import { expenseNotFound, sellerNotFound } from '../lib/pv-errors';
import { withTransaction } from '../lib/transaction';
import type { ExpenseBody, ModoComision, SellerBody, TipoGasto } from '../validation/sales-orders.validation';
import { findInvoiceId } from './sales-invoice-payments.service';
import type { Scope } from './sales-orders.service';

// Vendedores del proyecto y gastos de la factura de venta. Reglas en la BD
// (20261107200000_vendedores_gastos_factura_venta):
//   * comisión: vendedor activo del proyecto, una por vendedor y factura; en
//     'Ganancia' y 'Venta' la BD calcula el valor (y recalcula las de ganancia
//     cuando cambian los otros gastos); en 'Fijo' se guarda el valor enviado;
//   * los gastos no se editan: se borran y se registran de nuevo; con la factura
//     anulada no se agregan ni se borran.
// Ganancia neta = venta (subtotal - descuento) - costo - gastos.

type Db = Pick<Pool, 'query' | 'connect'>;
type Queryable = Pick<Pool | PoolClient, 'query'>;

export type SellerDto = {
  id_seller: string;
  nombre: string;
  telefono: string;
  modo_comision: ModoComision;
  valor_comision: string;
  activo: boolean;
  // Comisiones en facturas vigentes: cuánto ha ganado y en cuántas ventas.
  comisiones: string;
  ventas: number;
};

export type SalesExpenseDto = {
  id_sales_invoice_expense: string;
  tipo: TipoGasto;
  descripcion: string;
  fecha: string;
  id_seller: string | null;
  vendedor_nombre: string | null;
  modo_comision: ModoComision | null;
  porcentaje: string | null;
  valor: string;
  created_at: string;
};

// venta = subtotal - descuento; ganancia_bruta = venta - costo;
// ganancia_neta = ganancia_bruta - gastos.
export type ExpensesSummaryDto = {
  venta: string;
  costo: string;
  ganancia_bruta: string;
  comisiones: string;
  otros_gastos: string;
  gastos: string;
  ganancia_neta: string;
};

export type ExpensesResponseDto = { gastos: SalesExpenseDto[]; resumen: ExpensesSummaryDto };

const toIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const SELLER_COLUMNS = `s.id_seller::text AS id_seller, s.nombre, s.telefono, s.modo_comision,
       s.valor_comision::text AS valor_comision, s.activo,
       coalesce(c.comisiones, 0)::text AS comisiones, coalesce(c.ventas, 0)::int AS ventas`;

const SELLER_FROM = `sales_sellers s
  LEFT JOIN LATERAL (
    SELECT sum(g.valor) AS comisiones, count(*) AS ventas
      FROM sales_invoice_expenses g
      JOIN sales_invoices i ON i.id_sales_invoice = g.id_sales_invoice
     WHERE g.id_seller = s.id_seller AND i.anulada_en IS NULL AND i.deleted_at IS NULL
  ) c ON true`;

const toSellerDto = (r: any): SellerDto => ({
  id_seller: r.id_seller,
  nombre: r.nombre,
  telefono: r.telefono,
  modo_comision: r.modo_comision,
  valor_comision: r.valor_comision,
  activo: r.activo === true,
  comisiones: r.comisiones,
  ventas: Number(r.ventas),
});

export const listSellers = async (db: Queryable, idOwnProject: number): Promise<SellerDto[]> => {
  const { rows } = await db.query(
    `SELECT ${SELLER_COLUMNS} FROM ${SELLER_FROM}
      WHERE s.id_own_project = $1
      ORDER BY s.activo DESC, lower(s.nombre), s.id_seller`,
    [idOwnProject]
  );
  return rows.map(toSellerDto);
};

const readSeller = async (q: Queryable, idOwnProject: number, idSeller: string): Promise<SellerDto> => {
  const { rows } = await q.query(
    `SELECT ${SELLER_COLUMNS} FROM ${SELLER_FROM} WHERE s.id_seller = $1::bigint AND s.id_own_project = $2`,
    [idSeller, idOwnProject]
  );
  if (rows.length === 0) throw sellerNotFound();
  return toSellerDto(rows[0]);
};

export const createSeller = async (db: Queryable, scope: Scope, input: SellerBody): Promise<SellerDto> => {
  const { rows } = await db.query(
    `INSERT INTO sales_sellers (id_own_project, nombre, telefono, modo_comision, valor_comision, activo, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id_seller::text AS id`,
    [scope.id_own_project, input.nombre, input.telefono, input.modo_comision, input.valor_comision, input.activo, scope.id_user]
  );
  return readSeller(db, scope.id_own_project, rows[0].id);
};

// Los vendedores no se borran (tienen comisiones): se desactivan con activo=false.
export const updateSeller = async (db: Queryable, scope: Scope, idSeller: string, input: SellerBody): Promise<SellerDto> => {
  const { rows } = await db.query(
    `UPDATE sales_sellers
        SET nombre = $3, telefono = $4, modo_comision = $5, valor_comision = $6, activo = $7,
            updated_at = now(), updated_by_user_id = $8
      WHERE id_seller = $1::bigint AND id_own_project = $2
      RETURNING id_seller::text AS id`,
    [idSeller, scope.id_own_project, input.nombre, input.telefono, input.modo_comision, input.valor_comision, input.activo, scope.id_user]
  );
  if (rows.length === 0) throw sellerNotFound();
  return readSeller(db, scope.id_own_project, rows[0].id);
};

const readExpenses = async (q: Queryable, idInvoice: string): Promise<ExpensesResponseDto> => {
  const gastos = await q.query(
    `SELECT g.id_sales_invoice_expense::text AS id_sales_invoice_expense, g.tipo, g.descripcion,
            to_char(g.fecha, 'YYYY-MM-DD') AS fecha, g.id_seller::text AS id_seller, s.nombre AS vendedor_nombre,
            g.modo_comision, g.porcentaje::text AS porcentaje, g.valor::text AS valor, g.created_at
       FROM sales_invoice_expenses g
       LEFT JOIN sales_sellers s ON s.id_seller = g.id_seller
      WHERE g.id_sales_invoice = $1::bigint
      ORDER BY g.fecha, g.id_sales_invoice_expense`,
    [idInvoice]
  );
  const resumen = await q.query(
    `SELECT b.venta::text AS venta, b.costo::text AS costo, (b.venta - b.costo)::text AS ganancia_bruta,
            g.comisiones::text AS comisiones, g.otros::text AS otros_gastos, (g.comisiones + g.otros)::text AS gastos,
            (b.venta - b.costo - g.comisiones - g.otros)::text AS ganancia_neta
       FROM (
         SELECT o.subtotal - o.descuento_monto AS venta,
                coalesce((SELECT sum(l.cantidad * coalesce(l.costo_unitario, 0))
                            FROM sales_order_lines l WHERE l.id_sales_order = o.id_sales_order), 0) AS costo
           FROM sales_invoices i JOIN sales_orders o ON o.id_sales_order = i.id_sales_order
          WHERE i.id_sales_invoice = $1::bigint
       ) b,
       (
         SELECT coalesce(sum(valor) FILTER (WHERE tipo = 'Comisión'), 0) AS comisiones,
                coalesce(sum(valor) FILTER (WHERE tipo <> 'Comisión'), 0) AS otros
           FROM sales_invoice_expenses WHERE id_sales_invoice = $1::bigint
       ) g`,
    [idInvoice]
  );

  return {
    gastos: gastos.rows.map((r: any) => ({
      id_sales_invoice_expense: r.id_sales_invoice_expense,
      tipo: r.tipo,
      descripcion: r.descripcion,
      fecha: r.fecha,
      id_seller: r.id_seller ?? null,
      vendedor_nombre: r.vendedor_nombre ?? null,
      modo_comision: r.modo_comision ?? null,
      porcentaje: r.porcentaje ?? null,
      valor: r.valor,
      created_at: toIso(r.created_at),
    })),
    resumen: resumen.rows[0],
  };
};

export const listExpenses = async (db: Db, idOwnProject: number, idOrder: string) =>
  readExpenses(db, await findInvoiceId(db, idOwnProject, idOrder));

export const createExpense = (db: Db, scope: Scope, idOrder: string, input: ExpenseBody) =>
  withTransaction(db, async (client) => {
    const idInvoice = await findInvoiceId(client, scope.id_own_project, idOrder);
    const comision = input.tipo === 'Comisión';
    const porcentaje = comision && input.modo_comision !== 'Fijo' ? input.porcentaje : null;
    // En % el valor lo calcula la BD: se envía 0 como marcador.
    const valor = porcentaje !== null ? 0 : input.valor;
    await client.query(
      `INSERT INTO sales_invoice_expenses
         (id_own_project, id_sales_invoice, tipo, descripcion, fecha, id_seller, modo_comision, porcentaje, valor, created_by_user_id)
       VALUES ($1, $2::bigint, $3, $4, $5::date, $6::bigint, $7, $8, $9, $10)`,
      [
        scope.id_own_project,
        idInvoice,
        input.tipo,
        input.descripcion,
        input.fecha,
        comision ? input.id_seller : null,
        comision ? input.modo_comision : null,
        porcentaje,
        valor,
        scope.id_user,
      ]
    );
    return readExpenses(client, idInvoice);
  });

export const deleteExpense = (db: Db, scope: Scope, idOrder: string, idGasto: string) =>
  withTransaction(db, async (client) => {
    const idInvoice = await findInvoiceId(client, scope.id_own_project, idOrder);
    const { rows } = await client.query(
      `DELETE FROM sales_invoice_expenses
        WHERE id_sales_invoice_expense = $1::bigint AND id_sales_invoice = $2::bigint AND id_own_project = $3
        RETURNING 1 AS ok`,
      [idGasto, idInvoice, scope.id_own_project]
    );
    if (rows.length === 0) throw expenseNotFound();
    return readExpenses(client, idInvoice);
  });
