import type { Pool, PoolClient } from 'pg';
import { orderNotFound, orderNotInvoiced, paymentNotFound } from '../lib/pv-errors';
import { withTransaction } from '../lib/transaction';
import type { MetodoPago, PaymentBody, VoidPaymentBody } from '../validation/sales-orders.validation';
import type { Scope } from './sales-orders.service';

// Abonos del cliente sobre la factura de venta de un pedido. Espejo de los pagos
// de compra (comercyo-back-create-purchase-order, purchase-invoice-payments.service).
// Las reglas viven en los triggers de sales_invoice_payments (migración
// 20261106220000_sales_invoice_payments_como_compras): la fila de la factura se
// bloquea para que dos abonos simultáneos se serialicen, el monto no puede
// superar el saldo (FV_PAGO_EXCEDE_SALDO), la fecha va entre la emisión y hoy
// (FV_PAGO_FECHA_*) y un abono nunca se edita ni se borra: solo se anula una
// vez, con motivo.

type Db = Pick<Pool, 'query' | 'connect'>;
type Queryable = Pick<Pool | PoolClient, 'query'>;

export type EstadoPago = 'Pendiente' | 'Pago parcial' | 'Pagada';

export type SalesInvoicePaymentDto = {
  id_sales_invoice_payment: string;
  fecha: string;
  metodo: MetodoPago;
  monto: string;
  referencia: string;
  created_at: string;
  anulado_en: string | null;
  motivo_anulacion: string | null;
  comprobante_key: string | null;
};

// reintegrado: dinero devuelto al cliente por devoluciones (sales_returns
// resueltas como 'Reintegro'); baja el saldo como una nota crédito.
export type PaymentsSummaryDto = { total: string; pagado: string; reintegrado: string; saldo: string; estado: EstadoPago };

export type PaymentsResponseDto = { pagos: SalesInvoicePaymentDto[]; resumen: PaymentsSummaryDto };

const toIso = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
};

// La factura vigente del pedido (a lo sumo una: sales_invoices_pedido_uniq).
// También la usan las devoluciones (sales-returns.service).
export const findInvoiceId = async (q: Queryable, idOwnProject: number, idOrder: string): Promise<string> => {
  const { rows } = await q.query(
    `SELECT si.id_sales_invoice::text AS id_sales_invoice
       FROM sales_orders so
       LEFT JOIN sales_invoices si
         ON si.id_sales_order = so.id_sales_order AND si.anulada_en IS NULL AND si.deleted_at IS NULL
      WHERE so.id_sales_order = $1::bigint AND so.id_own_project = $2 AND so.deleted_at IS NULL`,
    [idOrder, idOwnProject]
  );
  if (rows.length === 0) throw orderNotFound();
  if (!rows[0].id_sales_invoice) throw orderNotInvoiced();
  return rows[0].id_sales_invoice;
};

const toPaymentDto = (row: any): SalesInvoicePaymentDto => ({
  id_sales_invoice_payment: String(row.id_sales_invoice_payment),
  fecha: row.fecha,
  metodo: row.metodo,
  monto: row.monto,
  referencia: row.referencia,
  created_at: toIso(row.created_at) as string,
  anulado_en: toIso(row.anulado_en),
  motivo_anulacion: row.motivo_anulacion ?? null,
  comprobante_key: row.comprobante_key ?? null,
});

// Los anulados también se listan (la ventana los muestra tachados) pero solo
// cuentan los vigentes. Sumas y estado en numeric, no en floats de JS.
const readPayments = async (q: Queryable, idInvoice: string): Promise<PaymentsResponseDto> => {
  const pagos = await q.query(
    `SELECT id_sales_invoice_payment::text AS id_sales_invoice_payment,
            to_char(fecha, 'YYYY-MM-DD') AS fecha,
            metodo::text AS metodo, monto::text AS monto, referencia, created_at, anulado_en, motivo_anulacion,
            comprobante_key::text AS comprobante_key
       FROM sales_invoice_payments p
      WHERE id_sales_invoice = $1::bigint
      -- p.id_... (bigint): sin el alias de tabla ORDER BY usaría la columna de
      -- salida ::text y '10' quedaría antes que '9'.
      ORDER BY p.fecha, p.id_sales_invoice_payment`,
    [idInvoice]
  );
  const resumen = await q.query(
    `SELECT si.total::text AS total,
            s.pagado::text AS pagado,
            r.reintegrado::text AS reintegrado,
            greatest(si.total - s.pagado - r.reintegrado, 0)::text AS saldo,
            CASE WHEN s.pagado = 0 AND r.reintegrado = 0 THEN 'Pendiente'
                 WHEN si.total - s.pagado - r.reintegrado <= 0 THEN 'Pagada'
                 ELSE 'Pago parcial' END AS estado
       FROM sales_invoices si,
            LATERAL (SELECT coalesce(sum(p.monto) FILTER (WHERE anulado_en IS NULL), 0) AS pagado
                       FROM sales_invoice_payments p
                      WHERE p.id_sales_invoice = si.id_sales_invoice) s,
            LATERAL (SELECT coalesce(sum(d.monto_reintegro) FILTER (WHERE d.resolucion = 'Reintegro'), 0) AS reintegrado
                       FROM sales_returns d
                      WHERE d.id_sales_invoice = si.id_sales_invoice) r
      WHERE si.id_sales_invoice = $1::bigint`,
    [idInvoice]
  );
  const { total, pagado, reintegrado, saldo, estado } = resumen.rows[0];
  return { pagos: pagos.rows.map(toPaymentDto), resumen: { total, pagado, reintegrado, saldo, estado } };
};

export const listPayments = async (db: Db, idOwnProject: number, idOrder: string) =>
  readPayments(db, await findInvoiceId(db, idOwnProject, idOrder));

export const createPayment = (db: Db, scope: Scope, idOrder: string, input: PaymentBody) =>
  withTransaction(db, async (client) => {
    const idInvoice = await findInvoiceId(client, scope.id_own_project, idOrder);
    await client.query(
      `INSERT INTO sales_invoice_payments
         (id_own_project, id_sales_invoice, fecha, metodo, monto, referencia, created_by_user_id, comprobante_key)
       VALUES ($1, $2::bigint, $3::date, $4, $5, $6, $7, $8::uuid)`,
      [scope.id_own_project, idInvoice, input.fecha, input.metodo, input.monto, input.referencia, scope.id_user, input.comprobanteKey]
    );
    return readPayments(client, idInvoice);
  });

// anulado_en lo fija la BD (now()); anular dos veces lanza FV_PAGO_YA_ANULADO.
export const voidPayment = (db: Db, scope: Scope, idOrder: string, idPago: string, input: VoidPaymentBody) =>
  withTransaction(db, async (client) => {
    const idInvoice = await findInvoiceId(client, scope.id_own_project, idOrder);
    const { rows } = await client.query(
      `UPDATE sales_invoice_payments
          SET anulado_en = now(), anulado_by_user_id = $4, motivo_anulacion = $5, updated_by_user_id = $4
        WHERE id_sales_invoice_payment = $1::bigint AND id_sales_invoice = $2::bigint AND id_own_project = $3
        RETURNING 1 AS ok`,
      [idPago, idInvoice, scope.id_own_project, scope.id_user, input.motivo]
    );
    if (rows.length === 0) throw paymentNotFound();
    return readPayments(client, idInvoice);
  });
