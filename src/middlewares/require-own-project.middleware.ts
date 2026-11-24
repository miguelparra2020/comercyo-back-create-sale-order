import type { Context, Next } from 'hono';
import { getUsersDb } from '../config/db';
import { errorBody, INVALID_OWN_PROJECT } from '../lib/errors';

export type OwnProjectVariables = {
  id_own_project: number;
};

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

// "Pertenecer a un proyecto" hoy es ser su dueño (own_projects.created_by_email),
// igual que en comercyo-back-services y comercyo-back-store-verification.
export const PROJECT_ACCESS_SQL = `
  SELECT 1
    FROM own_projects op
    JOIN users u ON u.email = op.created_by_email AND u.deleted_at IS NULL
   WHERE op.id_own_project = $1::bigint
     AND op.deleted_at IS NULL
     AND u.id_user = $2
   LIMIT 1`;

// Valida x-own-project-id y que el usuario autenticado sea dueño del proyecto:
// así nadie ve ni cambia los datos de otra tienda cambiando el header.
// Va después de requireAuth (necesita id_user).
export function requireOwnProject(getDb: () => Queryable = getUsersDb) {
  return async (c: Context<{ Variables: OwnProjectVariables & { id_user: number } }>, next: Next) => {
    const header = c.req.header('x-own-project-id')?.trim();
    const id_own_project = header ? Number(header) : NaN;

    if (!header || !/^\d+$/.test(header) || id_own_project < 1 || !Number.isSafeInteger(id_own_project)) {
      return c.json(errorBody(400, INVALID_OWN_PROJECT, 'Selecciona un proyecto válido'), 400);
    }

    const { rows } = await getDb().query(PROJECT_ACCESS_SQL, [id_own_project, c.get('id_user')]);
    if (rows.length === 0) {
      return c.json(errorBody(404, 'PROJECT_NOT_FOUND', 'El proyecto no existe o no tienes acceso'), 404);
    }

    c.set('id_own_project', id_own_project);
    await next();
  };
}
