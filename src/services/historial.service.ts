import type { Pool } from 'pg';
import { orderNotFound } from '../lib/pv-errors';

type Db = Pick<Pool, 'query'>;

// Tarea 57: historial de un pedido de venta, de lo primero a lo último: cuándo
// se tomó y para quién, cada cambio de estado (sales_order_events, tarea 36),
// la factura, los pagos y las devoluciones, con sus anulaciones.

export type TipoEvento = 'creado' | 'estado' | 'factura' | 'factura_anulada' | 'pago' | 'pago_anulado' | 'devolucion';

export type EventoHistorial = {
  fecha: string; // ISO con hora
  tipo: TipoEvento;
  titulo: string;
  detalle: string | null;
};

export type HistorialPedido = {
  pedido: { id: string; numero: string; tercero: string; estado: string; total: number; origen: string | null };
  eventos: EventoHistorial[];
};

const pesos = (v: unknown) => `$${Math.round(Number(v)).toLocaleString('es-CO')}`;
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const TEXTO_ESTADO: Record<string, string> = {
  Pendiente: 'Quedó en Pendiente',
  'En preparación': 'Pasó a En preparación (empacando)',
  'En camino': 'Salió: En camino',
  Entregado: 'Entregado al cliente',
  Cancelado: 'Pedido cancelado',
};

// Orden dentro del mismo instante: primero se crea, luego el estado, la factura y los pagos.
const PRIORIDAD: Record<TipoEvento, number> = { creado: 0, estado: 1, factura: 2, pago: 3, devolucion: 4, pago_anulado: 5, factura_anulada: 6 };

/**
 * `acceso`: la tienda (`{ id_own_project }`) o el comprador del marketplace
 * (`{ id_user }`). Si el pedido no es suyo, 404.
 */
export const getHistorialVenta = async (
  db: Db,
  id: string,
  acceso: { id_own_project: number } | { id_user: number }
): Promise<HistorialPedido> => {
  const porTienda = 'id_own_project' in acceso;
  const { rows: p } = await db.query(
    `SELECT so.id_sales_order::text AS id, so.numero, so.cliente_nombre, so.estado::text AS estado, so.total, so.created_at,
            (mo.id_sales_order IS NOT NULL) AS marketplace
       FROM sales_orders so
       LEFT JOIN marketplace_orders mo ON mo.id_sales_order = so.id_sales_order
      WHERE so.id_sales_order = $1::bigint AND so.deleted_at IS NULL
        AND ${porTienda ? 'so.id_own_project = $2::bigint' : 'mo.id_user = $2::bigint'}`,
    [id, porTienda ? acceso.id_own_project : acceso.id_user]
  );
  if (!p.length) throw orderNotFound();
  const pedido = p[0];

  const [estados, facturas, pagos, devoluciones] = await Promise.all([
    db.query(`SELECT estado, created_at FROM sales_order_events WHERE id_sales_order = $1::bigint ORDER BY created_at, id_sales_order_event`, [id]),
    db.query(
      `SELECT numero, total, created_at, anulada_en FROM sales_invoices
        WHERE id_sales_order = $1::bigint AND deleted_at IS NULL ORDER BY created_at`,
      [id]
    ),
    db.query(
      `SELECT si.numero AS factura, p.metodo::text AS metodo, p.monto, p.referencia, p.created_at, p.anulado_en, p.motivo_anulacion
         FROM sales_invoice_payments p JOIN sales_invoices si ON si.id_sales_invoice = p.id_sales_invoice
        WHERE si.id_sales_order = $1::bigint AND si.deleted_at IS NULL ORDER BY p.created_at`,
      [id]
    ),
    db.query(
      `SELECT r.numero, r.motivo, r.valor, r.resolucion, r.monto_reintegro, r.metodo::text AS metodo, r.created_at
         FROM sales_returns r JOIN sales_invoices si ON si.id_sales_invoice = r.id_sales_invoice
        WHERE si.id_sales_order = $1::bigint ORDER BY r.created_at`,
      [id]
    ),
  ]);

  const eventos: EventoHistorial[] = [
    {
      fecha: iso(pedido.created_at),
      tipo: 'creado',
      titulo: pedido.marketplace ? `${pedido.cliente_nombre} hizo el pedido en el marketplace` : `Se tomó el pedido de ${pedido.cliente_nombre}`,
      detalle: `Pedido ${pedido.numero}`,
    },
    ...estados.rows.map((e) => ({
      fecha: iso(e.created_at),
      tipo: 'estado' as const,
      titulo: TEXTO_ESTADO[e.estado] ?? `Estado: ${e.estado}`,
      detalle: null,
    })),
    ...facturas.rows.flatMap((f) => [
      { fecha: iso(f.created_at), tipo: 'factura' as const, titulo: `Se generó la factura ${f.numero}`, detalle: `Total ${pesos(f.total)}` },
      ...(f.anulada_en ? [{ fecha: iso(f.anulada_en), tipo: 'factura_anulada' as const, titulo: `Se anuló la factura ${f.numero}`, detalle: null }] : []),
    ]),
    ...pagos.rows.flatMap((x) => [
      {
        fecha: iso(x.created_at),
        tipo: 'pago' as const,
        titulo: `Pago de ${pesos(x.monto)} en ${String(x.metodo).toLowerCase()}`,
        detalle: [`Factura ${x.factura}`, x.referencia ? `Ref. ${x.referencia}` : null].filter(Boolean).join(' · '),
      },
      ...(x.anulado_en
        ? [{ fecha: iso(x.anulado_en), tipo: 'pago_anulado' as const, titulo: `Se anuló el pago de ${pesos(x.monto)}`, detalle: x.motivo_anulacion ?? null }]
        : []),
    ]),
    ...devoluciones.rows.map((d) => ({
      fecha: iso(d.created_at),
      tipo: 'devolucion' as const,
      titulo: `Devolución ${d.numero} por ${pesos(d.valor)}`,
      detalle: [
        d.motivo,
        d.resolucion === 'Reintegro' && d.monto_reintegro != null
          ? `Reintegro de ${pesos(d.monto_reintegro)}${d.metodo ? ` en ${String(d.metodo).toLowerCase()}` : ''}`
          : d.resolucion
            ? `Resolución: ${d.resolucion}`
            : 'Pendiente de resolver',
      ]
        .filter(Boolean)
        .join(' · '),
    })),
  ].sort((a, b) => a.fecha.localeCompare(b.fecha) || PRIORIDAD[a.tipo] - PRIORIDAD[b.tipo]);

  return {
    pedido: {
      id: pedido.id,
      numero: pedido.numero,
      tercero: pedido.cliente_nombre,
      estado: pedido.estado,
      total: Number(pedido.total),
      origen: pedido.marketplace ? 'Marketplace' : 'Manual',
    },
    eventos,
  };
};
