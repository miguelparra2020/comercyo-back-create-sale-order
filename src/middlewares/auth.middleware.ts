import type { Context, Next } from 'hono';
import { errorBody, UNAUTHORIZED } from '../lib/errors';
import { verifyAccessToken } from '../utils/jwt.utils';

export type AuthVariables = {
  id_user: number;
};

export function requireAuth() {
  return async (c: Context<{ Variables: AuthVariables }>, next: Next) => {
    const authHeader = c.req.header('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json(errorBody(401, UNAUTHORIZED, 'Inicia sesión para continuar'), 401);
    }

    const token = authHeader.slice(7).trim();
    const payload = await verifyAccessToken(token);
    if (!payload) {
      return c.json(errorBody(401, UNAUTHORIZED, 'Tu sesión expiró o no es válida. Inicia sesión de nuevo.'), 401);
    }

    c.set('id_user', payload.id_user);
    await next();
  };
}
