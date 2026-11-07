import type { Pool, PoolClient } from 'pg';
import { returnNotFound } from '../lib/pv-errors';
import { withTransaction } from '../lib/transaction';
import type { MetodoPago, ResolucionDevolucion, ResolveReturnBody, ReturnBody } from '../validation/sales-orders.validation';
import { findInvoiceId } from './sales-invoice-payments.service';
import type { Scope } from './sales-orders.service';

// Devoluciones del cliente sobre la factura de venta del pedido. Las reglas viven
// en los triggers de sales_returns / sales_return_lines
// (20261107180000_devoluciones_compra_venta):
//   * crear la devolución recibe la mercancía: suma al stock (si la factura lo
//     descontó), nunca más de lo facturado menos lo ya devuelto (FV_DEV_CANTIDAD_EXCEDE);
//   * se resuelve una vez: 'Reposición' (se le vuelve a entregar -> sale del
//     stock, FV_DEV_STOCK_INSUFICIENTE si no alcanza) o 'Reintegro' (dinero
//     devuelto, <= valor), que baja el saldo de la factura;
//   * una devolución no se edita ni se borra; con devoluciones la factura no se anula.
// La BD las numera (DV-0001) y copia nombre y precio de la línea del pedido.

type Db = Pick<Pool, 'query' | 'connect'>;
type Queryable = Pick<Pool | PoolClient, 'query'>;

export type SalesReturnLineDto = {
  id_product: string;
  producto_nombre: string;
  cantidad: number;
  precio_unitario: string;
  subtotal: string;
};

export type SalesReturnDto = {
  id_sales_return: string;
  numero: string;
  fecha: string;
  motivo: string;
  // false si la factura no descontó inventario: la devolución tampoco lo mueve.
  mueve_inventario: boolean;
  valor: string;
  resolucion: ResolucionDevolucion | null;
  resuelta_fecha: string | null;
  metodo: MetodoPago | null;
  monto_reintegro: string | null;
  referencia: string;
  created_at: string;
  lineas: SalesReturnLineDto[];
};

// devuelto: value of every return; reintegrado: money refunded; por_resolver:
// value of the returns still waiting for a replacement or a refund.
export type ReturnsSummaryDto = { devuelto: string; reintegrado: string; por_resolver: string };

export type ReturnsResponseDto = { devoluciones: SalesReturnDto[]; resumen: ReturnsSummaryDto };

const toIso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : String(value);

const readReturns = async (q: Queryable, idInvoice: string): Promise<ReturnsResponseDto> => {
  const devoluciones = await q.query(
    `SELECT id_sales_return::text AS id_sales_return, numero, to_char(fecha, 'YYYY-MM-DD') AS fecha, motivo,
            mueve_inventario, valor::text AS valor, resolucion, to_char(resuelta_fecha, 'YYYY-MM-DD') AS resuelta_fecha,
            metodo, monto_reintegro::text AS monto_reintegro, referencia, created_at
       FROM sales_returns
      WHERE id_sales_invoice = $1::bigint
      ORDER BY sales_returns.fecha, sales_returns.id_sales_return`,
    [idInvoice]
  );
  const lineas = await q.query(
    `SELECT l.id_sales_return::text AS id_sales_return, l.id_product::text AS id_product, l.producto_nombre,
            l.cantidad, l.precio_unitario::text AS precio_unitario, (l.cantidad * l.precio_unitario)::text AS subtotal
       FROM sales_return_lines l
       JOIN sales_returns r ON r.id_sales_return = l.id_sales_return
      WHERE r.id_sales_invoice = $1::bigint
      ORDER BY l.id_sales_return_line`,
    [idInvoice]
  );
  const resumen = await q.query(
    `SELECT coalesce(sum(valor), 0)::text AS devuelto,
            coalesce(sum(monto_reintegro) FILTER (WHERE resolucion = 'Reintegro'), 0)::text AS reintegrado,
            coalesce(sum(valor) FILTER (WHERE resolucion IS NULL), 0)::text AS por_resolver
       FROM sales_returns
      WHERE id_sales_invoice = $1::bigint`,
    [idInvoice]
  );

  const porDevolucion = new Map<string, SalesReturnLineDto[]>();
  for (const l of lineas.rows) {
    const lista = porDevolucion.get(l.id_sales_return) ?? [];
    lista.push({
      id_product: l.id_product,
      producto_nombre: l.producto_nombre,
      cantidad: Number(l.cantidad),
      precio_unitario: l.precio_unitario,
      subtotal: l.subtotal,
    });
    porDevolucion.set(l.id_sales_return, lista);
  }

  return {
    devoluciones: devoluciones.rows.map((r: any) => ({
      id_sales_return: r.id_sales_return,
      numero: r.numero,
      fecha: r.fecha,
      motivo: r.motivo,
      mueve_inventario: r.mueve_inventario === true,
      valor: r.valor,
      resolucion: r.resolucion ?? null,
      resuelta_fecha: r.resuelta_fecha ?? null,
      metodo: r.metodo ?? null,
      monto_reintegro: r.monto_reintegro ?? null,
      referencia: r.referencia,
      created_at: toIso(r.created_at),
      lineas: porDevolucion.get(r.id_sales_return) ?? [],
    })),
    resumen: resumen.rows[0],
  };
};

export const listReturns = async (db: Db, idOwnProject: number, idOrder: string) =>
  readReturns(db, await findInvoiceId(db, idOwnProject, idOrder));

// Primero la cabecera (la BD la numera y copia mueve_inventario de la factura),
// luego una fila por producto: cada línea valida su tope y mueve el stock. Todo
// en una transacción: si una línea falla no queda nada.
export const createReturn = (db: Db, scope: Scope, idOrder: string, input: ReturnBody) =>
  withTransaction(db, async (client) => {
    const idInvoice = await findInvoiceId(client, scope.id_own_project, idOrder);
    const { rows } = await client.query(
      `INSERT INTO sales_returns (id_own_project, id_sales_invoice, fecha, motivo, created_by_user_id)
       VALUES ($1, $2::bigint, $3::date, $4, $5)
       RETURNING id_sales_return::text AS id`,
      [scope.id_own_project, idInvoice, input.fecha, input.motivo, scope.id_user]
    );
    for (const linea of input.lineas) {
      // producto_nombre / precio_unitario los sobrescribe la BD con la línea del pedido.
      await client.query(
        `INSERT INTO sales_return_lines (id_sales_return, id_product, cantidad, producto_nombre, precio_unitario)
         VALUES ($1::bigint, $2::bigint, $3, '', 0)`,
        [rows[0].id, linea.id_product, linea.cantidad]
      );
    }
    return readReturns(client, idInvoice);
  });

// Reposición saca del stock (trigger); Reintegro registra el dinero y baja el
// saldo de la factura. Resolver dos veces -> FV_DEV_YA_RESUELTA.
export const resolveReturn = (db: Db, scope: Scope, idOrder: string, idDev: string, input: ResolveReturnBody) =>
  withTransaction(db, async (client) => {
    const idInvoice = await findInvoiceId(client, scope.id_own_project, idOrder);
    const reintegro = input.resolucion === 'Reintegro';
    const { rows } = await client.query(
      `UPDATE sales_returns
          SET resolucion = $4, resuelta_fecha = $5::date, metodo = $6, monto_reintegro = $7, referencia = $8, resuelta_by_user_id = $9
        WHERE id_sales_return = $1::bigint AND id_sales_invoice = $2::bigint AND id_own_project = $3
        RETURNING 1 AS ok`,
      [
        idDev,
        idInvoice,
        scope.id_own_project,
        input.resolucion,
        input.fecha,
        reintegro ? input.metodo : null,
        reintegro ? input.monto : null,
        input.referencia,
        scope.id_user,
      ]
    );
    if (rows.length === 0) throw returnNotFound();
    return readReturns(client, idInvoice);
  });
