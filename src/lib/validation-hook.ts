import type { Context } from 'hono';
import { errorBody } from './errors';
import { VALIDATION_CODE } from './pv-errors';
import { formatIssue, issueCode } from '../validation/sales-orders.validation';

// OpenAPIHono defaultHook: turns a request-validation failure into the same
// { success, error, message, code } 400 shape the route handlers return,
// using the first zod issue's (Spanish) message.
export const validationHook = (result: { success: boolean; error?: any }, c: Context) => {
  if (!result.success) {
    const issues = result.error?.issues;
    return c.json(errorBody(400, issueCode(issues) ?? VALIDATION_CODE, formatIssue(issues)), 400);
  }
};
