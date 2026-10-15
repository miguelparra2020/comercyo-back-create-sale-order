import type { Context } from 'hono';
import { errorBody } from './errors';
import { VALIDATION_CODE } from './pv-errors';
import { formatIssue } from '../validation/sales-orders.validation';

// OpenAPIHono defaultHook: turns a request-validation failure into the same
// { success, error, message, code } 400 shape the route handlers return,
// using the first zod issue's (Spanish) message.
export const validationHook = (result: { success: boolean; error?: any }, c: Context) => {
  if (!result.success) {
    return c.json(errorBody(400, VALIDATION_CODE, formatIssue(result.error?.issues)), 400);
  }
};
