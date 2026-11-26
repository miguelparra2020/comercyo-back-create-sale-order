import type { Pool } from 'pg';
import { puede, type Acceso } from '../lib/permisos';
import { orderNotFound } from '../lib/pv-errors';
import { transitionSalesOrder, type Scope, type Transicion } from './sales-orders.service';

type Db = Pick<Pool, 'query' | 'connect'>;

// Despachos: el tablero de pedidos por empacar, listos, en camino y entregados.
// Quien maneja los pedidos (dueño, pedidos_venta o despachos con "editar")
// ve todo y asigna; los demás del equipo ven y marcan solo lo que tienen asignado.

export type Persona = { id_user: string; nombre: string };
export type Paso = { nombre: string | null; en: string } | null;

export type Despacho = {
  id_sales_order: string;
  numero: string;
  cliente: string;
  estado: string;
  fecha_entrega: string | null;
  notas: string | null;
  total: string;
  empaca: Persona | null;
  entrega: Persona | null;
  empacado: Paso;
  en_camino: Paso;
  entregado: Paso;
};

export const PASOS: Record<string, Transicion> = { empacar: 'prepare', empacado: 'ready', salir: 'ship', entregar: 'deliver' };
const PASO_ENTREGA = new Set<Transicion>(['ship', 'deliver']);

export const puedeGestionar = (acceso: Acceso) =>
  puede(acceso, 'despachos', 'editar') || puede(acceso, 'pedidos_venta', 'editar');

export class DespachoError extends Error {
  constructor(readonly status: 400 | 403, readonly code: string, message: string) {
    super(message);
  }
}
const sinPermiso = (msg: string) => new DespachoError(403, 'DESPACHO_NO_ASIGNADO', msg);

// Nombre visible: el de la cuenta; si no tiene, "Sin nombre". Nunca el correo.
const NOMBRE = (alias: string) => `coalesce(nullif(trim(${alias}.name), ''), 'Sin nombre')`;

const iso = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const paso = (nombre: unknown, en: unknown): Paso => (en == null ? null : { nombre: (nombre as string | null) ?? null, en: iso(en)! });
const persona = (id: unknown, nombre: unknown): Persona | null => (id == null ? null : { id_user: String(id), nombre: String(nombre ?? 'Sin nombre') });

// Último evento de cada estado, con quién lo marcó.
const ultimo = (estado: string, col: string) => `
  LEFT JOIN LATERAL (
    SELECT e.created_at, ${NOMBRE('u')} AS nombre
      FROM sales_order_events e LEFT JOIN users u ON u.id_user = e.id_user
     WHERE e.id_sales_order = so.id_sales_order AND e.estado = '${estado}'
     ORDER BY e.created_at DESC, e.id_sales_order_event DESC LIMIT 1
  ) ${col} ON true`;

/**
 * Pedidos activos (sin cancelados) y los entregados en los últimos `dias`.
 * `soloMios`: solo los que la persona empaca o entrega.
 */
export const listarDespachos = async (db: Pick<Pool, 'query'>, scope: Scope, soloMios: boolean, dias = 2): Promise<Despacho[]> => {
  const { rows } = await db.query(
    `SELECT so.id_sales_order::text AS id, so.numero, so.cliente_nombre, so.estado::text AS estado, so.fecha_entrega,
            so.notas, so.total, so.empaca_id_user, ${NOMBRE('ue')} AS empaca_nombre,
            so.entrega_id_user, ${NOMBRE('ur')} AS entrega_nombre,
            pk.created_at AS empacado_en, pk.nombre AS empacado_por,
            ec.created_at AS en_camino_en, ec.nombre AS en_camino_por,
            et.created_at AS entregado_en, et.nombre AS entregado_por
       FROM sales_orders so
       LEFT JOIN users ue ON ue.id_user = so.empaca_id_user
       LEFT JOIN users ur ON ur.id_user = so.entrega_id_user
       ${ultimo('Listo para despachar', 'pk')}
       ${ultimo('En camino', 'ec')}
       ${ultimo('Entregado', 'et')}
      WHERE so.id_own_project = $1 AND so.deleted_at IS NULL AND so.estado::text <> 'Cancelado'
        AND (so.estado::text <> 'Entregado' OR so.entregado_en >= now() - make_interval(days => $3::int))
        AND (NOT $2::boolean OR so.empaca_id_user = $4 OR so.entrega_id_user = $4)
      ORDER BY so.fecha_entrega NULLS LAST, so.id_sales_order`,
    [scope.id_own_project, soloMios, dias, scope.id_user]
  );
  return rows.map((r) => ({
    id_sales_order: r.id,
    numero: r.numero,
    cliente: r.cliente_nombre ?? '',
    estado: r.estado,
    fecha_entrega: r.fecha_entrega == null ? null : iso(r.fecha_entrega)!.slice(0, 10),
    notas: r.notas ?? null,
    total: String(r.total),
    empaca: persona(r.empaca_id_user, r.empaca_nombre),
    entrega: persona(r.entrega_id_user, r.entrega_nombre),
    empacado: paso(r.empacado_por, r.empacado_en),
    en_camino: paso(r.en_camino_por, r.en_camino_en),
    entregado: paso(r.entregado_por, r.entregado_en),
  }));
};

/** El dueño y las personas activas del equipo, con su nombre (sin correo). */
export const listarPersonas = async (db: Pick<Pool, 'query'>, idProyecto: number): Promise<Persona[]> => {
  const { rows } = await db.query(
    `SELECT u.id_user::text AS id_user, ${NOMBRE('u')} AS nombre
       FROM users u
      WHERE u.deleted_at IS NULL AND u.id_user IN (
              SELECT d.id_user FROM own_projects op JOIN users d ON d.email = op.created_by_email AND d.deleted_at IS NULL
               WHERE op.id_own_project = $1
              UNION SELECT m.id_user FROM proyecto_miembros m WHERE m.id_own_project = $1 AND m.estado = 'activo' AND m.id_user IS NOT NULL)
      ORDER BY 2`,
    [idProyecto]
  );
  return rows.map((r) => ({ id_user: r.id_user, nombre: r.nombre }));
};

export const asignarDespacho = async (
  db: Pick<Pool, 'query'>,
  scope: Scope,
  id: string,
  input: { empaca_id_user: string | null; entrega_id_user: string | null }
) => {
  const personas = new Set((await listarPersonas(db, scope.id_own_project)).map((p) => p.id_user));
  for (const v of [input.empaca_id_user, input.entrega_id_user]) {
    if (v != null && !personas.has(v)) throw new DespachoError(400, 'DESPACHO_PERSONA_INVALIDA', 'Esa persona no es del equipo de la tienda.');
  }
  const r = await db.query(
    `UPDATE sales_orders SET empaca_id_user = $1::bigint, entrega_id_user = $2::bigint, updated_by_user_id = $3
      WHERE id_sales_order = $4::bigint AND id_own_project = $5 AND deleted_at IS NULL`,
    [input.empaca_id_user, input.entrega_id_user, scope.id_user, id, scope.id_own_project]
  );
  if (!r.rowCount) throw orderNotFound();
};

/** Marca un paso. Si no gestiona, debe tener asignado ese paso. */
export const marcarPaso = async (db: Db, scope: Scope, acceso: Acceso, id: string, accion: Transicion) => {
  if (!puedeGestionar(acceso)) {
    const { rows } = await db.query(
      `SELECT empaca_id_user::text AS empaca, entrega_id_user::text AS entrega FROM sales_orders
        WHERE id_sales_order = $1::bigint AND id_own_project = $2 AND deleted_at IS NULL`,
      [id, scope.id_own_project]
    );
    if (!rows.length) throw orderNotFound();
    const yo = String(scope.id_user);
    const asignado = PASO_ENTREGA.has(accion) ? rows[0].entrega : rows[0].empaca;
    if (asignado !== yo) {
      throw sinPermiso(PASO_ENTREGA.has(accion) ? 'Este pedido no está asignado a ti para entregar.' : 'Este pedido no está asignado a ti para empacar.');
    }
  }
  await transitionSalesOrder(db as Pool, scope, id, accion);
};
