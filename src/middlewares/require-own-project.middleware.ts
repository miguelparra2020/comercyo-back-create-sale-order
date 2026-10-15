import type { Context, Next } from 'hono';
import { errorBody, INVALID_OWN_PROJECT } from '../lib/errors';

export type OwnProjectVariables = {
  id_own_project: number;
};

export function requireOwnProject() {
  return async (c: Context<{ Variables: OwnProjectVariables }>, next: Next) => {
    const header = c.req.header('x-own-project-id')?.trim();
    const id_own_project = header ? Number(header) : NaN;

    if (!header || !/^\d+$/.test(header) || id_own_project < 1) {
      return c.json(errorBody(400, INVALID_OWN_PROJECT, 'Selecciona un proyecto válido'), 400);
    }

    c.set('id_own_project', id_own_project);
    await next();
  };
}
