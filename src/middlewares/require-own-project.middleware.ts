import type { Context, Next } from 'hono';
import { getUsersDb } from '../config/db';
import { errorBody, INVALID_OWN_PROJECT } from '../lib/errors';
import { ACCESO_SQL, mensajeSinPermiso, permisoFaltante, type Acceso, type Regla } from '../lib/permisos';
import { REGLAS } from './permisos.reglas';

export type OwnProjectVariables = {
  id_own_project: number;
  /** Dueño o permisos del miembro del equipo (permisos_en_proyecto). */
  acceso: Acceso;
};

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

// Solo el dueño, sin el equipo (para saber si una tienda es propia).
// requireOwnProject usa ACCESO_SQL, que también da acceso al equipo.
export const PROJECT_ACCESS_SQL = `
  SELECT 1
    FROM own_projects op
    JOIN users u ON u.email = op.created_by_email AND u.deleted_at IS NULL
   WHERE op.id_own_project = $1::bigint
     AND op.deleted_at IS NULL
     AND u.id_user = $2
   LIMIT 1`;

// Valida x-own-project-id y que el usuario autenticado sea dueño del proyecto o
// miembro de su equipo con permiso para esta ruta (REGLAS):
// así nadie ve ni cambia los datos de otra tienda cambiando el header.
// Va después de requireAuth (necesita id_user).
export function requireOwnProject(getDb: () => Queryable = getUsersDb, reglas: readonly Regla[] = REGLAS) {
  return async (c: Context<{ Variables: OwnProjectVariables & { id_user: number } }>, next: Next) => {
    const header = c.req.header('x-own-project-id')?.trim();
    const id_own_project = header ? Number(header) : NaN;

    if (!header || !/^\d+$/.test(header) || id_own_project < 1 || !Number.isSafeInteger(id_own_project)) {
      return c.json(errorBody(400, INVALID_OWN_PROJECT, 'Selecciona un proyecto válido'), 400);
    }

    const { rows } = await getDb().query(ACCESO_SQL, [id_own_project, c.get('id_user')]);
    const acceso = (rows[0] as { acceso?: Acceso | null } | undefined)?.acceso;
    if (!acceso) {
      return c.json(errorBody(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe o no tienes acceso'), 404);
    }

    // Equipo de la tienda: el dueño puede todo; un miembro, lo que digan sus permisos.
    const falta = permisoFaltante(acceso, reglas, c.req.method, c.req.path);
    if (falta) {
      return c.json(errorBody(403, 'SIN_PERMISO', mensajeSinPermiso(falta)), 403);
    }
    c.set('acceso', acceso);

    c.set('id_own_project', id_own_project);
    await next();
  };
}
