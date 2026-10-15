// Every error the API sends has the shape { success: false, error, message, code }:
// `error` is the HTTP reason phrase, `message` is Spanish and safe to show to
// the user, `code` is for the frontend.
export type ErrorStatus = 400 | 401 | 404 | 409 | 429 | 500;

export type ErrorBody = {
  success: false;
  error: string;
  message: string;
  code: string;
};

const STATUS_TEXT: Record<ErrorStatus, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

export const errorBody = (status: ErrorStatus, code: string, message: string): ErrorBody => ({
  success: false,
  error: STATUS_TEXT[status],
  message,
  code,
});

// Same codes as the other Comercyo backends (comercyo-back-create-customers).
export const UNAUTHORIZED = 'UNAUTHORIZED';
export const INVALID_OWN_PROJECT = 'INVALID_OWN_PROJECT';
export const RATE_LIMITED = 'RATE_LIMITED';
export const INTERNAL_ERROR = 'INTERNAL_ERROR';

export const INTERNAL_ERROR_MESSAGE = 'Ocurrió un error inesperado. Intente de nuevo más tarde.';
