import type { Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorBody, INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE } from './errors';
import { VALIDATION_CODE } from './pv-errors';

// Global app.onError. Logs the real error but never sends SQL, stack or
// driver messages to the client.
export const errorHandler = (err: Error, c: Context) => {
  if (err instanceof HTTPException && err.status === 400) {
    // Hono's JSON validator throws this for a malformed body.
    return c.json(errorBody(400, VALIDATION_CODE, 'El cuerpo de la petición debe ser un JSON válido'), 400);
  }
  if (err instanceof HTTPException && err.status < 500) {
    return err.getResponse();
  }

  console.error('Unhandled error:', err);
  return c.json(errorBody(500, INTERNAL_ERROR, INTERNAL_ERROR_MESSAGE), 500);
};
