import { errorBody, type ErrorBody } from './errors';
import {
  constraintName,
  isCheckViolation,
  isForeignKeyViolation,
  isInvalidTextRepresentation,
  isNumericOutOfRange,
  isRaiseException,
  isUniqueViolation,
} from './pg-errors';
import { MSG, MSG_AJUSTE } from '../validation/sales-orders.validation';

export type PvErrorStatus = 400 | 404 | 409;

// Errors raised by the API itself (not by the DB) that still carry a PV_* code.
export class SalesOrderError extends Error {
  constructor(
    public readonly status: PvErrorStatus,
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'SalesOrderError';
  }
}

export const VALIDATION_CODE = 'PV_VALIDACION';
export const NOT_FOUND_CODE = 'PV_PEDIDO_NO_ENCONTRADO';

// Same text the frontend mock (pedidosVentaApi.ts) shows.
export const NOT_FOUND_MESSAGE = 'El pedido no existe';

export const orderNotFound = () => new SalesOrderError(404, NOT_FOUND_CODE, NOT_FOUND_MESSAGE);

// Every code raised by so_raise() in migrations 20261015031310_create_sales_orders
// and 20261017034032_sales_orders_ajustes. Keep in sync with their headers.
export const PV_ERROR_STATUS: Record<string, PvErrorStatus> = {
  // Ajustes (constraint trigger diferido: llega en el COMMIT)
  PV_DESCUENTO_EXCEDE_SUBTOTAL: 400,
  // Validación (datos enviados)
  PV_CLIENTE_NO_ENCONTRADO: 400,
  PV_CLIENTE_OTRO_PROYECTO: 400,
  PV_CLIENTE_INACTIVO: 400,
  PV_PRODUCTO_NO_ENCONTRADO: 400,
  PV_PRODUCTO_OTRO_PROYECTO: 400,
  PV_PRODUCTO_ELIMINADO: 400,
  PV_PRODUCTO_REPETIDO: 400,
  PV_MAX_LINEAS: 400,
  // Estado del pedido
  PV_ESTADO_INICIAL_INVALIDO: 409,
  PV_TRANSICION_INVALIDA: 409,
  PV_PEDIDO_NO_EDITABLE: 409,
  PV_PEDIDO_ELIMINADO: 409,
  PV_BORRADO_NO_PERMITIDO: 409,
  PV_CAMPO_INMUTABLE: 409,
  // No encontrado
  PV_PEDIDO_NO_ENCONTRADO: 404,
};

const PV_MESSAGE_REGEX = /^(PV_[A-Z_]+):\s*([\s\S]*)$/;

// so_raise() builds the message as '<CODIGO>: <texto en español>' and also
// puts the code in DETAIL. The code is taken from DETAIL when present and the
// text is the message without the prefix.
export const parsePvMessage = (err: unknown): { code: string; message: string } | null => {
  if (!isRaiseException(err)) return null;
  const raw = (err as { message?: unknown }).message;
  if (typeof raw !== 'string') return null;
  const match = PV_MESSAGE_REGEX.exec(raw);
  if (!match) return null;
  const detail = (err as { detail?: unknown }).detail;
  const code = typeof detail === 'string' && /^PV_[A-Z_]+$/.test(detail) ? detail : match[1];
  return { code, message: match[2].trim() };
};

// Codes whose DB text is replaced by a fixed one: the DB message for the
// discount names the order ("... del pedido PED-0001."), the frontend shows
// the same sentence as its own form validation.
const PV_FIXED_MESSAGE: Record<string, string> = {
  PV_DESCUENTO_EXCEDE_SUBTOTAL: MSG.descuentoExcede,
};

// One entry per CHECK constraint the user can trip. zod rejects all of
// these first; this is the safety net if a request slips past it.
const CHECK_BY_CONSTRAINT: Record<string, { code: string; message: string }> = {
  sales_orders_fechas_check: { code: 'PV_FECHAS_INVALIDAS', message: MSG.entregaAntes },
  sales_orders_descuento_tipo_check: { code: 'PV_DESCUENTO_TIPO_INVALIDO', message: MSG_AJUSTE.descuento.tipo },
  sales_orders_impuesto_tipo_check: { code: 'PV_IMPUESTO_TIPO_INVALIDO', message: MSG_AJUSTE.impuesto.tipo },
  sales_orders_descuento_valor_check: { code: 'PV_DESCUENTO_NEGATIVO', message: MSG_AJUSTE.descuento.negativo },
  sales_orders_impuesto_valor_check: { code: 'PV_IMPUESTO_NEGATIVO', message: MSG_AJUSTE.impuesto.negativo },
  sales_orders_costo_envio_check: { code: 'PV_COSTO_ENVIO_NEGATIVO', message: MSG_AJUSTE.costoEnvio.negativo },
  sales_orders_descuento_sin_tipo_check: { code: 'PV_DESCUENTO_SIN_TIPO', message: MSG_AJUSTE.descuento.sinTipo },
  sales_orders_impuesto_sin_tipo_check: { code: 'PV_IMPUESTO_SIN_TIPO', message: MSG_AJUSTE.impuesto.sinTipo },
  sales_orders_descuento_porcentaje_check: {
    code: 'PV_DESCUENTO_PORCENTAJE_INVALIDO',
    message: MSG_AJUSTE.descuento.porcentaje,
  },
  sales_orders_impuesto_porcentaje_check: {
    code: 'PV_IMPUESTO_PORCENTAJE_INVALIDO',
    message: MSG_AJUSTE.impuesto.porcentaje,
  },
};

// sales_orders_numero_uniq is deliberately absent: a duplicated number is an
// internal failure of the counter, not something the user can fix -> 500.
const UNIQUE_BY_CONSTRAINT: Record<string, { code: string; message: string }> = {
  sales_order_lines_producto_uniq: {
    code: 'PV_PRODUCTO_REPETIDO',
    message: 'Este producto ya está en el pedido',
  },
};

const FK_BY_CONSTRAINT: Record<string, { code: string; message: string }> = {
  sales_orders_id_customer_fkey: {
    code: 'PV_CLIENTE_NO_ENCONTRADO',
    message: 'El cliente no existe',
  },
  sales_order_lines_id_product_fkey: {
    code: 'PV_PRODUCTO_NO_ENCONTRADO',
    message: 'Uno de los productos no existe',
  },
};

type Mapped = { status: PvErrorStatus; body: ErrorBody };

const known = (status: PvErrorStatus, code: string, message: string): Mapped => ({
  status,
  body: errorBody(status, code, message),
});

// Translates any error a sales-order operation can legitimately hit into an
// HTTP status + body. Returns null for everything else so the caller lets it
// bubble to the global 500 handler (which logs it and hides the details).
export const mapSalesOrderError = (err: unknown): Mapped | null => {
  if (err instanceof SalesOrderError) return known(err.status, err.code, err.message);

  const pv = parsePvMessage(err);
  if (pv) {
    const status = PV_ERROR_STATUS[pv.code];
    return status ? known(status, pv.code, PV_FIXED_MESSAGE[pv.code] ?? pv.message) : null;
  }

  if (isCheckViolation(err)) {
    const hit = CHECK_BY_CONSTRAINT[constraintName(err) ?? ''];
    return hit
      ? known(400, hit.code, hit.message)
      : known(400, 'PV_DATOS_INVALIDOS', 'Los datos del pedido no son válidos');
  }

  if (isUniqueViolation(err)) {
    const hit = UNIQUE_BY_CONSTRAINT[constraintName(err) ?? ''];
    return hit ? known(400, hit.code, hit.message) : null;
  }

  if (isForeignKeyViolation(err)) {
    const hit = FK_BY_CONSTRAINT[constraintName(err) ?? ''];
    return hit ? known(400, hit.code, hit.message) : null;
  }

  if (isNumericOutOfRange(err)) {
    return known(400, 'PV_VALOR_FUERA_DE_RANGO', 'Un valor numérico del pedido excede el máximo permitido');
  }

  if (isInvalidTextRepresentation(err)) {
    return known(400, VALIDATION_CODE, 'Uno de los valores enviados no es válido');
  }

  return null;
};
