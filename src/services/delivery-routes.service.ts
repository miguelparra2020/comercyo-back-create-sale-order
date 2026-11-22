import type { Pool } from 'pg';

type Db = Pick<Pool, 'query'>;

// Tarea 56: rutas de entrega. Los pedidos a domicilio "Listo para despachar"
// (empacados, esperando ruta) y "En camino" de la tienda con a dónde
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
  estado: 'Listo para despachar' | 'En camino';
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
              coalesce(mo.condicion_pago, so.condicion_pago) AS condicion_pago, so.estado::text AS estado
         FROM sales_orders so
         JOIN customers c ON c.id_customer = so.id_customer
         LEFT JOIN marketplace_orders mo ON mo.id_sales_order = so.id_sales_order
         LEFT JOIN dropi_orders dro ON dro.id_sales_order = so.id_sales_order
         LEFT JOIN cities ci ON ci.id_city = mo.id_city
        WHERE so.id_own_project = $1::bigint AND so.estado IN ('Listo para despachar', 'En camino') AND so.deleted_at IS NULL
          AND coalesce(mo.entrega, dro.entrega, 'domicilio') <> 'recoger'
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
      estado: r.estado === 'En camino' ? 'En camino' : 'Listo para despachar',
    })),
  };
};

// Salir a ruta: los escogidos que siguen Listo para despachar pasan a En camino
// (el trigger de estados y los avisos al cliente corren por cada uno).
export const despacharRuta = async (db: Db, scope: { id_own_project: number; id_user: number }, ids: string[]): Promise<string[]> => {
  const { rows } = await db.query(
    `UPDATE sales_orders SET estado = 'En camino', updated_by_user_id = $2
      WHERE id_own_project = $1::bigint AND id_sales_order = ANY($3::bigint[])
        AND estado = 'Listo para despachar' AND deleted_at IS NULL
      RETURNING id_sales_order::text AS id`,
    [scope.id_own_project, scope.id_user, ids]
  );
  return rows.map((r) => r.id);
};
