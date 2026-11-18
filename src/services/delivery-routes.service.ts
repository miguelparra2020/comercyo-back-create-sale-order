import type { Pool } from 'pg';

type Db = Pick<Pool, 'query'>;

// Tarea 56: rutas de entrega. Los pedidos "En camino" de la tienda con a dónde
// van, para que el front arme la ruta (de la tienda al más cercano, y así) y
// la abra en Google Maps. Los del marketplace traen el pin que puso el
// cliente; los manuales solo la dirección del cliente (Google la busca).

export type ParadaEntrega = {
  id_sales_order: string;
  numero: string;
  cliente: string;
  telefono: string | null;
  direccion: string | null;
  detalle_direccion: string | null;
  ciudad: string | null;
  ubicacion: { lat: number; lng: number } | null;
  total: number;
  condicion_pago: 'anticipado' | 'contra_entrega' | null;
  fecha_entrega: string | null;
};

export type RutasEntrega = {
  origen: { direccion: string | null; ubicacion: { lat: number; lng: number } | null };
  paradas: ParadaEntrega[];
};

// Más que esto en camino a la vez no cabe en una ruta razonable.
export const MAX_PARADAS = 100;

const fecha = (v: unknown): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
const coords = (lat: unknown, lng: unknown) =>
  lat == null || lng == null ? null : { lat: Number(lat), lng: Number(lng) };

export const getDeliveryRoutes = async (db: Db, idTienda: number): Promise<RutasEntrega> => {
  const [tienda, pedidos] = await Promise.all([
    db.query(`SELECT latitud, longitud, direccion FROM store_info WHERE id_own_project = $1::bigint`, [idTienda]),
    db.query(
      `SELECT so.id_sales_order::text AS id_sales_order, so.numero, so.cliente_nombre,
              coalesce(mo.telefono, c.telefono) AS telefono,
              coalesce(mo.direccion, c.direccion) AS direccion,
              mo.detalle_direccion, ci.city_name AS ciudad,
              mo.latitud, mo.longitud, so.total, so.fecha_entrega,
              coalesce(mo.condicion_pago, so.condicion_pago) AS condicion_pago
         FROM sales_orders so
         JOIN customers c ON c.id_customer = so.id_customer
         LEFT JOIN marketplace_orders mo ON mo.id_sales_order = so.id_sales_order
         LEFT JOIN cities ci ON ci.id_city = mo.id_city
        WHERE so.id_own_project = $1::bigint AND so.estado = 'En camino' AND so.deleted_at IS NULL
        ORDER BY so.fecha_entrega NULLS LAST, so.id_sales_order
        LIMIT ${MAX_PARADAS}`,
      [idTienda]
    ),
  ]);
  const t = tienda.rows[0];
  return {
    origen: { direccion: t?.direccion ?? null, ubicacion: coords(t?.latitud, t?.longitud) },
    paradas: pedidos.rows.map((r) => ({
      id_sales_order: r.id_sales_order,
      numero: r.numero,
      cliente: r.cliente_nombre,
      telefono: r.telefono ?? null,
      direccion: r.direccion ?? null,
      detalle_direccion: r.detalle_direccion ?? null,
      ciudad: r.ciudad ?? null,
      ubicacion: coords(r.latitud, r.longitud),
      total: Number(r.total),
      condicion_pago: r.condicion_pago ?? null,
      fecha_entrega: fecha(r.fecha_entrega),
    })),
  };
};
