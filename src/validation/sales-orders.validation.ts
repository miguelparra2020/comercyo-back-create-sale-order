import { z } from '@hono/zod-openapi';

export const ESTADOS = ['Pendiente', 'En preparación', 'En camino', 'Entregado', 'Cancelado'] as const;
export type Estado = (typeof ESTADOS)[number];

export const MAX_LINEAS = 50;
export const NOTAS_MAX = 500;
const CANTIDAD_MAX = 2_147_483_647; // integer
const PRECIO_MAX = 999_999_999_999.99; // numeric(14,2)
const BIGINT_MAX = 9223372036854775807n;

const PAGE_MIN = 1;
const LIMIT_MIN = 1;
const LIMIT_MAX = 100;
const LIMIT_DEFAULT = 10;

// Messages shared with the frontend (src/saas/utils/pedidoVenta.ts) so the
// user reads the same text whether the form or the API catches the problem.
export const MSG = {
  cliente: 'Selecciona un cliente',
  clienteInvalido: 'El cliente seleccionado no es válido',
  fecha: 'Selecciona la fecha',
  fechaInvalida: 'La fecha debe tener el formato YYYY-MM-DD y ser válida',
  fechaEntrega: 'Selecciona la fecha de entrega',
  fechaEntregaInvalida: 'La fecha de entrega debe tener el formato YYYY-MM-DD y ser válida',
  entregaAntes: 'La entrega no puede ser antes de la fecha del pedido',
  notasTexto: 'Las notas deben ser texto',
  notasMax: `Las notas pueden tener máximo ${NOTAS_MAX} caracteres`,
  sinLineas: 'Agrega al menos un producto',
  maxLineas: `Un pedido puede tener máximo ${MAX_LINEAS} productos`,
  lineaObjeto: 'Cada producto del pedido debe ser un objeto',
  producto: 'Selecciona un producto',
  productoInvalido: 'El producto seleccionado no es válido',
  productoRepetido: 'Este producto ya está en el pedido',
  cantidad: 'La cantidad debe ser un número entero mayor que 0',
  cantidadMax: `La cantidad debe ser como máximo ${CANTIDAD_MAX}`,
  precio: 'El precio debe ser un número mayor o igual a 0',
  precioNegativo: 'El precio no puede ser negativo',
  precioMax: `El precio debe ser como máximo ${PRECIO_MAX}`,
  precioDecimales: 'El precio debe tener máximo 2 decimales',
  descuentoExcede: 'El descuento no puede ser mayor al subtotal del pedido',
} as const;

// Order-level adjustments (migration 20261017034032_sales_orders_ajustes).
// Texts follow validarAjustes() in the frontend's pedidoVenta.ts.
export const TIPOS_AJUSTE = ['porcentaje', 'valor'] as const;
export type TipoAjuste = (typeof TIPOS_AJUSTE)[number];

const msgMonto = (nombre: string) => ({
  numero: `${nombre} debe ser un número mayor o igual a 0`,
  negativo: `${nombre} no puede ser negativo`,
  decimales: `${nombre} debe tener máximo 2 decimales`,
  max: `${nombre} debe ser como máximo ${PRECIO_MAX}`,
});

const msgAjuste = (nombre: string, tipo: string) => ({
  ...msgMonto(nombre),
  tipo: `El tipo de ${tipo} debe ser porcentaje, valor o null`,
  sinTipo: `${nombre} debe ser 0 si no se indica si es porcentaje o valor`,
  porcentaje: `${nombre} no puede ser mayor a 100%`,
});

export const MSG_AJUSTE = {
  descuento: msgAjuste('El descuento', 'descuento'),
  impuesto: msgAjuste('El impuesto', 'impuesto'),
  costoEnvio: msgMonto('El costo de envío'),
} as const;

const DATE_REGEX = /^(\d{4})-(\d{2})-(\d{2})$/;

// Real calendar date in YYYY-MM-DD (rejects 2026-02-30, 2026-13-01...).
export const isValidDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const match = DATE_REGEX.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 1) return false;
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

// A bigint id as a JSON number or a digit string ("789" is how the API
// returns ids, so the frontend may send them back that way).
export const isPositiveBigintId = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0;
  if (typeof value === 'string' && /^\d{1,19}$/.test(value)) {
    const n = BigInt(value);
    return n > 0n && n <= BIGINT_MAX;
  }
  return false;
};

// Normalised to a canonical string ("007" -> "7") so duplicates are detected
// regardless of how the client wrote them and pg gets an exact bigint.
const toIdString = (value: unknown) => BigInt(value as string | number).toString();

const bigintId = (requiredMessage: string, invalidMessage: string) =>
  z
    .any()
    .superRefine((value, ctx) => {
      if (value === undefined || value === null || value === '') {
        ctx.addIssue({ code: 'custom', message: requiredMessage });
      } else if (!isPositiveBigintId(value)) {
        ctx.addIssue({ code: 'custom', message: invalidMessage });
      }
    })
    .transform(toIdString)
    .openapi({ type: 'integer', example: 5 });

const dateField = (requiredMessage: string, invalidMessage: string) =>
  z
    .any()
    .superRefine((value, ctx) => {
      if (value === undefined || value === null || value === '') {
        ctx.addIssue({ code: 'custom', message: requiredMessage });
      } else if (!isValidDate(value)) {
        ctx.addIssue({ code: 'custom', message: invalidMessage });
      }
    })
    .transform((value) => value as string)
    .openapi({ type: 'string', format: 'date', example: '2026-10-15' });

// Float-safe "at most 2 decimals" (0.29 * 100 is 28.999999999999996).
const hasAtMostTwoDecimals = (value: number) => Math.abs(Math.round(value * 100) - value * 100) < 1e-6;

const LineaSchema = z.object(
  {
    id_product: bigintId(MSG.producto, MSG.productoInvalido).openapi({ example: 789 }),
    cantidad: z
      .number({ error: MSG.cantidad })
      .int(MSG.cantidad)
      .min(1, MSG.cantidad)
      .max(CANTIDAD_MAX, MSG.cantidadMax)
      .openapi({ example: 2 }),
    precio_unitario: z
      .number({ error: MSG.precio })
      .min(0, MSG.precioNegativo)
      .max(PRECIO_MAX, MSG.precioMax)
      .refine(hasAtMostTwoDecimals, MSG.precioDecimales)
      .nullish()
      .transform((value) => value ?? null)
      .openapi({ example: 18000, description: 'Opcional: si se omite, se usa el precio_venta_linea del producto' }),
  },
  { error: MSG.lineaObjeto }
);

const tipoAjuste = (message: string, description: string) =>
  z.enum(TIPOS_AJUSTE, { error: message }).nullable().openapi({ example: 'porcentaje', description });

const montoAjuste = (msg: ReturnType<typeof msgMonto>, example: number, description: string) =>
  z
    .number({ error: msg.numero })
    .min(0, msg.negativo)
    .max(PRECIO_MAX, msg.max)
    .refine(hasAtMostTwoDecimals, msg.decimales)
    .openapi({ example, description });

const AJUSTES_FIELDS = {
  descuento_tipo: tipoAjuste(MSG_AJUSTE.descuento.tipo, "'porcentaje' | 'valor' | null (sin descuento)"),
  descuento_valor: montoAjuste(
    MSG_AJUSTE.descuento,
    10,
    'Porcentaje (0-100) o valor fijo (<= suma de las líneas). Debe ser 0 si descuento_tipo es null.'
  ),
  impuesto_tipo: tipoAjuste(MSG_AJUSTE.impuesto.tipo, "'porcentaje' | 'valor' | null (sin impuesto). Se aplica sobre subtotal - descuento."),
  impuesto_valor: montoAjuste(MSG_AJUSTE.impuesto, 19, 'Porcentaje (0-100) o valor fijo. Debe ser 0 si impuesto_tipo es null.'),
  costo_envio: montoAjuste(MSG_AJUSTE.costoEnvio, 8000, 'Costo de envío/domicilio. No lleva impuesto.'),
};

export const AJUSTES_COLUMNS = Object.keys(AJUSTES_FIELDS) as (keyof typeof AJUSTES_FIELDS)[];

// POST: an omitted adjustment means "none" (null / 0).
const AJUSTES_CREAR = {
  descuento_tipo: AJUSTES_FIELDS.descuento_tipo.default(null),
  descuento_valor: AJUSTES_FIELDS.descuento_valor.default(0),
  impuesto_tipo: AJUSTES_FIELDS.impuesto_tipo.default(null),
  impuesto_valor: AJUSTES_FIELDS.impuesto_valor.default(0),
  costo_envio: AJUSTES_FIELDS.costo_envio.default(0),
};

// PUT: an omitted adjustment stays undefined and keeps the order's current
// value, so an older client that doesn't know them never wipes them.
const AJUSTES_EDITAR = {
  descuento_tipo: AJUSTES_FIELDS.descuento_tipo.optional(),
  descuento_valor: AJUSTES_FIELDS.descuento_valor.optional(),
  impuesto_tipo: AJUSTES_FIELDS.impuesto_tipo.optional(),
  impuesto_valor: AJUSTES_FIELDS.impuesto_valor.optional(),
  costo_envio: AJUSTES_FIELDS.costo_envio.optional(),
};

// Sum of cantidad x precio_unitario in cents (bigint: no float drift or
// overflow). null when a line has no price: the DB fills it from the product,
// so only the deferred DB check (PV_DESCUENTO_EXCEDE_SUBTOTAL) can compare.
export const subtotalLineasCentavos = (lineas: unknown): bigint | null => {
  if (!Array.isArray(lineas)) return null;
  let total = 0n;
  for (const linea of lineas) {
    const { cantidad, precio_unitario } = (linea ?? {}) as { cantidad?: unknown; precio_unitario?: unknown };
    if (!Number.isSafeInteger(cantidad) || typeof precio_unitario !== 'number') return null;
    total += BigInt(cantidad as number) * BigInt(Math.round(precio_unitario * 100));
  }
  return total;
};

type AjustesInput = {
  descuento_tipo?: TipoAjuste | null;
  descuento_valor?: number;
  impuesto_tipo?: TipoAjuste | null;
  impuesto_valor?: number;
  lineas: unknown;
};

// Same rules as the sales_orders_*_check constraints and trg_so_70_ajustes.
// On PUT a field left out is undefined: the rules that need it are left to the DB.
const refineAjustes = (body: AjustesInput, ctx: z.RefinementCtx) => {
  for (const campo of ['descuento', 'impuesto'] as const) {
    const tipo = body[`${campo}_tipo`];
    const valor = body[`${campo}_valor`];
    if (typeof valor !== 'number') continue;
    const path = [`${campo}_valor`];
    if (tipo === null && valor !== 0) {
      ctx.addIssue({ code: 'custom', path, message: MSG_AJUSTE[campo].sinTipo });
    } else if (tipo === 'porcentaje' && valor > 100) {
      ctx.addIssue({ code: 'custom', path, message: MSG_AJUSTE[campo].porcentaje });
    }
  }
  if (body.descuento_tipo === 'valor' && typeof body.descuento_valor === 'number') {
    const subtotal = subtotalLineasCentavos(body.lineas);
    if (subtotal !== null && BigInt(Math.round(body.descuento_valor * 100)) > subtotal) {
      // Same code the DB raises for this rule, whichever layer catches it.
      ctx.addIssue({
        code: 'custom',
        path: ['descuento_valor'],
        message: MSG.descuentoExcede,
        params: { code: 'PV_DESCUENTO_EXCEDE_SUBTOTAL' },
      });
    }
  }
};

// Unknown and DB-computed fields (numero, total, subtotal, descuento_monto,
// impuesto_monto, estado, cliente_nombre, producto_nombre, ...) are stripped
// by z.object and never reach the DB.
const ORDER_FIELDS = {
  id_customer: bigintId(MSG.cliente, MSG.clienteInvalido),
  fecha: dateField(MSG.fecha, MSG.fechaInvalida),
  fecha_entrega: dateField(MSG.fechaEntrega, MSG.fechaEntregaInvalida).openapi({ example: '2026-10-18' }),
  notas: z
    .string({ error: MSG.notasTexto })
    .trim()
    .max(NOTAS_MAX, MSG.notasMax)
    .nullish()
    .transform((value) => value ?? ''),
  lineas: z
    .array(LineaSchema, { error: MSG.sinLineas })
    .min(1, MSG.sinLineas)
    .max(MAX_LINEAS, MSG.maxLineas),
};

const BODY_NOT_OBJECT = { error: 'El cuerpo de la petición debe ser un objeto JSON' };

type RefineInput = AjustesInput & {
  fecha?: string;
  fecha_entrega?: string;
  lineas: { id_product?: string }[];
};

const refineOrder = (body: RefineInput, ctx: z.RefinementCtx) => {
  // zod may still run this after a field failed; only compare valid values.
  if (isValidDate(body.fecha) && isValidDate(body.fecha_entrega) && body.fecha_entrega < body.fecha) {
    ctx.addIssue({ code: 'custom', path: ['fecha_entrega'], message: MSG.entregaAntes });
  }
  const seen = new Set<string>();
  (Array.isArray(body.lineas) ? body.lineas : []).forEach((linea, index) => {
    if (typeof linea?.id_product !== 'string') return;
    if (seen.has(linea.id_product)) {
      ctx.addIssue({ code: 'custom', path: ['lineas', index, 'id_product'], message: MSG.productoRepetido });
    }
    seen.add(linea.id_product);
  });
  refineAjustes(body, ctx);
};

// POST /sales-orders
export const OrderBodySchema = z.object({ ...ORDER_FIELDS, ...AJUSTES_CREAR }, BODY_NOT_OBJECT).superRefine(refineOrder);
// PUT /sales-orders/:id
export const UpdateOrderBodySchema = z
  .object({ ...ORDER_FIELDS, ...AJUSTES_EDITAR }, BODY_NOT_OBJECT)
  .superRefine(refineOrder);

export type OrderBody = z.output<typeof OrderBodySchema>;
export type UpdateOrderBody = z.output<typeof UpdateOrderBodySchema>;
export type OrderLineInput = OrderBody['lineas'][number];

const optionalDateQuery = (name: string) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => v || undefined)
    .refine((v) => v === undefined || isValidDate(v), `${name} debe tener el formato YYYY-MM-DD y ser válida`);

export const ListQuerySchema = z
  .object({
    // An empty/blank search box means "no filter", not a 400.
    search: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined),
    estado: z
      .enum(ESTADOS, { error: `estado debe ser uno de: ${ESTADOS.join(', ')}` })
      .optional(),
    id_customer: z
      .string()
      .trim()
      .optional()
      .transform((v) => v || undefined)
      .refine((v) => v === undefined || isPositiveBigintId(v), 'id_customer debe ser un entero positivo')
      .transform((v) => (v === undefined ? undefined : toIdString(v))),
    atrasado: z
      .enum(['true', 'false'], { error: 'atrasado debe ser true o false' })
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    origen: z
      .enum(['Manual', 'Marketplace'], { error: 'origen debe ser Manual o Marketplace' })
      .optional(),
    fecha_desde: optionalDateQuery('fecha_desde'),
    fecha_hasta: optionalDateQuery('fecha_hasta'),
    page: z.coerce
      .number({ error: 'page debe ser un número entero' })
      .int('page debe ser un número entero')
      .min(PAGE_MIN, `page debe ser como mínimo ${PAGE_MIN}`)
      .default(PAGE_MIN),
    limit: z.coerce
      .number({ error: 'limit debe ser un número entero' })
      .int('limit debe ser un número entero')
      .min(LIMIT_MIN, `limit debe ser como mínimo ${LIMIT_MIN}`)
      .max(LIMIT_MAX, `limit debe ser como máximo ${LIMIT_MAX}`)
      .default(LIMIT_DEFAULT),
  })
  .refine(
    (q) => !q.fecha_desde || !q.fecha_hasta || q.fecha_desde <= q.fecha_hasta,
    { message: 'fecha_desde no puede ser posterior a fecha_hasta', path: ['fecha_desde'] }
  );

export type ListQuery = z.output<typeof ListQuerySchema>;

// --------------------------------------------------------------------------
// Factura de venta del pedido (POST /sales-orders/:id/invoice) y sus abonos
// (POST /sales-orders/:id/payments, .../payments/:idPago/void). Mismas reglas y
// textos que la factura y los pagos de compra (comercyo-back-create-purchase-order).
// La BD controla el resto: numero FV-0001, cliente y total copiados del pedido
// (sales_invoices), el saldo y el rango de fechas de los abonos
// (FV_PAGO_EXCEDE_SALDO, FV_PAGO_FECHA_*): migraciones
// 20261018173425_create_sales_invoices y 20261106220000_sales_invoice_payments_como_compras.
// --------------------------------------------------------------------------

export const MSG_VENCIMIENTO_ANTERIOR = 'La fecha de vencimiento no puede ser anterior a la fecha de la factura';

export const InvoiceBodySchema = z
  .object(
    {
      fecha_emision: dateField(
        'La fecha de la factura es obligatoria',
        'La fecha de la factura debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-11-06' }),
      fecha_vencimiento: dateField(
        'La fecha de vencimiento es obligatoria',
        'La fecha de vencimiento debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-12-06', description: 'Igual o posterior a fecha_emision' }),
      notas: z
        .string({ error: MSG.notasTexto })
        .trim()
        .max(NOTAS_MAX, MSG.notasMax)
        .nullish()
        .transform((value) => value ?? '')
        .openapi({ example: 'Pago a 30 días' }),
      descuenta_inventario: z
        .boolean({ error: 'descuenta_inventario debe ser verdadero o falso' })
        .nullish()
        .transform((value) => value ?? true)
        .openapi({
          example: true,
          description:
            'Por defecto true: la factura resta del stock las cantidades del pedido (FV_STOCK_INSUFICIENTE si no alcanza; vuelven si se anula). false: no toca el inventario.',
        }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((body, ctx) => {
    if (isValidDate(body.fecha_emision) && isValidDate(body.fecha_vencimiento) && body.fecha_vencimiento < body.fecha_emision) {
      ctx.addIssue({
        code: 'custom',
        path: ['fecha_vencimiento'],
        message: MSG_VENCIMIENTO_ANTERIOR,
        params: { code: 'FV_FACTURA_VENCIMIENTO_ANTERIOR' },
      });
    }
  });

export type InvoiceBody = z.output<typeof InvoiceBodySchema>;

// PUT /sales-orders/:id/invoice: only the dates and notes of the live invoice
// change (total, lines, stock and customer stay). The DB refuses a voided
// invoice (FV_FACTURA_ANULADA) and a date after its first live payment, return
// or cost (FV_FECHA_DESPUES_DE_MOVIMIENTOS).
export const UpdateInvoiceBodySchema = z
  .object(
    {
      fecha_emision: dateField(
        'La fecha de la factura es obligatoria',
        'La fecha de la factura debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-11-06' }),
      fecha_vencimiento: dateField(
        'La fecha de vencimiento es obligatoria',
        'La fecha de vencimiento debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-12-06', description: 'Igual o posterior a fecha_emision' }),
      notas: z
        .string({ error: MSG.notasTexto })
        .trim()
        .max(NOTAS_MAX, MSG.notasMax)
        .nullish()
        .transform((value) => value ?? '')
        .openapi({ example: 'Pago a 30 días' }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((body, ctx) => {
    if (isValidDate(body.fecha_emision) && isValidDate(body.fecha_vencimiento) && body.fecha_vencimiento < body.fecha_emision) {
      ctx.addIssue({
        code: 'custom',
        path: ['fecha_vencimiento'],
        message: MSG_VENCIMIENTO_ANTERIOR,
        params: { code: 'FV_FACTURA_VENCIMIENTO_ANTERIOR' },
      });
    }
  });

export type UpdateInvoiceBody = z.output<typeof UpdateInvoiceBodySchema>;

export const METODOS_PAGO = ['Transferencia', 'Efectivo'] as const;
export type MetodoPago = (typeof METODOS_PAGO)[number];

export const REFERENCIA_PAGO_MAX = 120;
export const MOTIVO_ANULACION_MAX = 500;

export const MSG_PAGO = {
  metodo: 'El método de pago debe ser Transferencia o Efectivo',
  monto: 'El monto debe ser un número mayor que 0',
  montoPositivo: 'El monto debe ser mayor que 0',
  montoDecimales: 'El monto debe tener máximo 2 decimales',
  montoMax: `El monto debe ser como máximo ${PRECIO_MAX}`,
  referencia: `La referencia debe tener máximo ${REFERENCIA_PAGO_MAX} caracteres`,
  motivo: 'Indica el motivo de la anulación',
  motivoMax: `El motivo debe tener máximo ${MOTIVO_ANULACION_MAX} caracteres`,
  comprobante: 'Los abonos por transferencia requieren la foto del comprobante',
  comprobanteInvalido: 'El comprobante debe ser un UUID válido',
  comprobanteEnUso: 'Esta foto ya respalda otro abono',
} as const;

export const PaymentBodySchema = z
  .object(
    {
      fecha: dateField(
        'La fecha del abono es obligatoria',
        'La fecha del abono debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-11-06', description: 'Entre la fecha de la factura y hoy' }),
      metodo: z.enum(METODOS_PAGO, { error: MSG_PAGO.metodo }).openapi({ example: 'Transferencia' }),
      monto: z
        .number({ error: MSG_PAGO.monto })
        .positive(MSG_PAGO.montoPositivo)
        .max(PRECIO_MAX, MSG_PAGO.montoMax)
        .refine(hasAtMostTwoDecimals, MSG_PAGO.montoDecimales)
        .openapi({ example: 50000, description: 'No puede superar el saldo de la factura' }),
      referencia: z
        .string({ error: 'La referencia debe ser texto' })
        .trim()
        .max(REFERENCIA_PAGO_MAX, MSG_PAGO.referencia)
        .nullish()
        .transform((value) => value ?? '')
        .openapi({ example: 'Transferencia #88213' }),
      comprobanteKey: z
        .string({ error: MSG_PAGO.comprobanteInvalido })
        .toLowerCase()
        .pipe(z.uuid(MSG_PAGO.comprobanteInvalido))
        .nullish()
        .transform((value) => value ?? null)
        .openapi({
          example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
          description: 'Key (UUID) de la foto del comprobante; obligatoria si el método es Transferencia',
        }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((pago, ctx) => {
    if (pago.metodo === 'Transferencia' && pago.comprobanteKey === null) {
      ctx.addIssue({
        code: 'custom',
        message: MSG_PAGO.comprobante,
        path: ['comprobanteKey'],
        params: { code: 'FV_PAGO_COMPROBANTE_REQUERIDO' },
      });
    }
  });

export type PaymentBody = z.output<typeof PaymentBodySchema>;

export const VoidPaymentBodySchema = z.object(
  {
    motivo: z
      .any()
      .superRefine((value, ctx) => {
        if (typeof value !== 'string' || value.trim() === '') {
          ctx.addIssue({ code: 'custom', message: MSG_PAGO.motivo, params: { code: 'FV_PAGO_MOTIVO_REQUERIDO' } });
        } else if (value.trim().length > MOTIVO_ANULACION_MAX) {
          ctx.addIssue({ code: 'custom', message: MSG_PAGO.motivoMax });
        }
      })
      .transform((value) => (value as string).trim())
      .openapi({ type: 'string', example: 'Abono duplicado' }),
  },
  BODY_NOT_OBJECT
);

export type VoidPaymentBody = z.output<typeof VoidPaymentBodySchema>;

// Devoluciones del cliente sobre la factura de venta (POST /sales-orders/:id/returns
// y .../returns/:idDev/resolve). Stock, topes de cantidad, fechas y tope del
// reintegro los valida la BD (FV_DEV_*).
export const MOTIVO_DEVOLUCION_MAX = 200;
export const RESOLUCIONES_DEVOLUCION = ['Reposición', 'Reintegro'] as const;
export type ResolucionDevolucion = (typeof RESOLUCIONES_DEVOLUCION)[number];

export const MSG_DEVOLUCION = {
  motivo: 'Indica el motivo de la devolución',
  motivoMax: `El motivo debe tener máximo ${MOTIVO_DEVOLUCION_MAX} caracteres`,
  lineas: 'Indica al menos un producto a devolver',
  cantidad: 'La cantidad a devolver debe ser un número entero mayor o igual a 1',
  resolucion: 'La resolución debe ser Reposición o Reintegro',
  reintegroMetodo: 'El reintegro requiere el método (Transferencia o Efectivo)',
  reintegroMonto: 'El reintegro requiere el monto',
} as const;

const motivoDevolucion = z
  .any()
  .superRefine((value, ctx) => {
    if (typeof value !== 'string' || value.trim() === '') ctx.addIssue({ code: 'custom', message: MSG_DEVOLUCION.motivo });
    else if (value.trim().length > MOTIVO_DEVOLUCION_MAX) ctx.addIssue({ code: 'custom', message: MSG_DEVOLUCION.motivoMax });
  })
  .transform((value) => (value as string).trim())
  .openapi({ type: 'string', example: 'No le quedó' });

const LineaDevolucionSchema = z.object(
  {
    id_product: bigintId('El producto a devolver es obligatorio', 'El id_product debe ser un entero positivo').openapi({ example: 789 }),
    cantidad: z
      .number({ error: MSG_DEVOLUCION.cantidad })
      .int(MSG_DEVOLUCION.cantidad)
      .min(1, MSG_DEVOLUCION.cantidad)
      .max(1_000_000, MSG_DEVOLUCION.cantidad)
      .openapi({ example: 2 }),
  },
  { error: 'Cada línea debe ser un objeto con id_product y cantidad' }
);

export const ReturnBodySchema = z
  .object(
    {
      fecha: dateField(
        'La fecha de la devolución es obligatoria',
        'La fecha de la devolución debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-11-07', description: 'Entre la fecha de la factura y hoy' }),
      motivo: motivoDevolucion,
      lineas: z
        .array(LineaDevolucionSchema, { error: MSG_DEVOLUCION.lineas })
        .min(1, MSG_DEVOLUCION.lineas)
        .max(50, 'Máximo 50 productos por devolución')
        .openapi({ description: 'Productos de la factura y cantidades a devolver' }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((body, ctx) => {
    const vistos = new Set<string>();
    body.lineas.forEach((linea, index) => {
      if (vistos.has(linea.id_product)) {
        ctx.addIssue({ code: 'custom', path: ['lineas', index, 'id_product'], message: `El producto ${linea.id_product} está repetido en la devolución` });
      }
      vistos.add(linea.id_product);
    });
  });

export type ReturnBody = z.output<typeof ReturnBodySchema>;

export const ResolveReturnBodySchema = z
  .object(
    {
      resolucion: z.enum(RESOLUCIONES_DEVOLUCION, { error: MSG_DEVOLUCION.resolucion }).openapi({ example: 'Reintegro' }),
      fecha: dateField(
        'La fecha de la resolución es obligatoria',
        'La fecha de la resolución debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-11-08', description: 'Igual o posterior a la devolución y no después de hoy' }),
      metodo: z.enum(METODOS_PAGO, { error: MSG_PAGO.metodo }).nullish().transform((v) => v ?? null).openapi({ example: 'Transferencia' }),
      monto: z
        .number({ error: MSG_PAGO.monto })
        .positive(MSG_PAGO.montoPositivo)
        .max(PRECIO_MAX, MSG_PAGO.montoMax)
        .refine(hasAtMostTwoDecimals, MSG_PAGO.montoDecimales)
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ example: 40000, description: 'Solo para Reintegro; no puede superar el valor de la devolución' }),
      referencia: z
        .string({ error: 'La referencia debe ser texto' })
        .trim()
        .max(REFERENCIA_PAGO_MAX, MSG_PAGO.referencia)
        .nullish()
        .transform((v) => v ?? '')
        .openapi({ example: 'Transferencia #1234' }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((body, ctx) => {
    if (body.resolucion !== 'Reintegro') return;
    if (body.metodo === null) ctx.addIssue({ code: 'custom', path: ['metodo'], message: MSG_DEVOLUCION.reintegroMetodo });
    if (body.monto === null) ctx.addIssue({ code: 'custom', path: ['monto'], message: MSG_DEVOLUCION.reintegroMonto });
  });

export type ResolveReturnBody = z.output<typeof ResolveReturnBodySchema>;

export const IdParamSchema = z.object({
  id: z
    .string()
    .refine(isPositiveBigintId, 'El id debe ser un entero positivo')
    .openapi({ param: { name: 'id', in: 'path' }, example: '123' }),
});

export const ReturnIdParamSchema = IdParamSchema.extend({
  idDev: z
    .string()
    .refine(isPositiveBigintId, 'El id de la devolución debe ser un entero positivo')
    .openapi({ param: { name: 'idDev', in: 'path' }, example: '4' }),
});

export const PaymentIdParamSchema = IdParamSchema.extend({
  idPago: z
    .string()
    .refine(isPositiveBigintId, 'El id del abono debe ser un entero positivo')
    .openapi({ param: { name: 'idPago', in: 'path' }, example: '9' }),
});

// First zod issue as a Spanish message; issues inside a line are prefixed
// with its 1-based position so the user knows which row to fix.
export const formatIssue = (issues: ReadonlyArray<{ message: string; path: ReadonlyArray<PropertyKey> }> | undefined) => {
  const issue = issues?.[0];
  if (!issue) return 'Cuerpo de la petición inválido';
  const [field, index] = issue.path;
  if (field === 'lineas' && typeof index === 'number') {
    return `Línea ${index + 1}: ${issue.message}`;
  }
  return issue.message;
};

// Error code carried by the first issue (params.code), when a rule has its
// own PV_* code instead of the generic validation one.
export const issueCode = (issues: ReadonlyArray<object> | undefined): string | undefined => {
  const code = (issues?.[0] as { params?: { code?: unknown } } | undefined)?.params?.code;
  return typeof code === 'string' ? code : undefined;
};

// Vendedores del proyecto (GET/POST /sellers, PUT /sellers/:idVendedor) y gastos
// de la factura de venta (GET/POST /sales-orders/:id/expenses, DELETE
// .../expenses/:idGasto). La BD calcula el valor de las comisiones en % y
// valida factura, fechas y vendedor (FV_GASTO_*).
export const NOMBRE_VENDEDOR_MAX = 120;
export const TELEFONO_VENDEDOR_MAX = 30;
export const DESCRIPCION_GASTO_MAX = 200;
export const MODOS_COMISION = ['Ganancia', 'Venta', 'Fijo'] as const;
export type ModoComision = (typeof MODOS_COMISION)[number];
export const TIPOS_GASTO = ['Comisión', 'Preparación', 'Separación', 'Envío', 'Otro'] as const;
export type TipoGasto = (typeof TIPOS_GASTO)[number];

export const MSG_VENDEDOR = {
  nombre: 'El nombre del vendedor es obligatorio',
  nombreMax: `El nombre debe tener máximo ${NOMBRE_VENDEDOR_MAX} caracteres`,
  telefono: `El teléfono debe tener máximo ${TELEFONO_VENDEDOR_MAX} caracteres`,
  modo: 'La comisión debe ser Ganancia (% de la ganancia), Venta (% de la venta) o Fijo',
  valor: 'La comisión debe ser un número mayor o igual a 0',
  porcentajeMax: 'El porcentaje de comisión no puede ser mayor a 100',
  duplicado: 'Ya existe un vendedor con ese nombre',
} as const;

export const MSG_GASTO = {
  tipo: 'El tipo de gasto debe ser Comisión, Preparación, Separación, Envío u Otro',
  descripcion: `La descripción debe tener máximo ${DESCRIPCION_GASTO_MAX} caracteres`,
  vendedor: 'La comisión requiere el vendedor',
  modo: 'La comisión requiere el modo: Ganancia, Venta o Fijo',
  porcentaje: 'El porcentaje debe ser mayor a 0 y máximo 100',
  valor: 'El valor del gasto debe ser mayor a 0',
  comprobante: 'El comprobante debe ser la key (UUID) de la foto subida',
} as const;

const comprobanteGasto = z
  .string({ error: MSG_GASTO.comprobante })
  .toLowerCase()
  .pipe(z.uuid(MSG_GASTO.comprobante));

const valorPesos = (message: string) =>
  z
    .number({ error: message })
    .max(PRECIO_MAX, message)
    .refine(hasAtMostTwoDecimals, 'El valor admite máximo 2 decimales');

export const SellerBodySchema = z
  .object(
    {
      nombre: z
        .string({ error: MSG_VENDEDOR.nombre })
        .trim()
        .min(1, MSG_VENDEDOR.nombre)
        .max(NOMBRE_VENDEDOR_MAX, MSG_VENDEDOR.nombreMax)
        .openapi({ example: 'Ana Gómez' }),
      telefono: z
        .string({ error: MSG_VENDEDOR.telefono })
        .trim()
        .max(TELEFONO_VENDEDOR_MAX, MSG_VENDEDOR.telefono)
        .nullish()
        .transform((v) => v ?? '')
        .openapi({ example: '3001234567' }),
      modo_comision: z.enum(MODOS_COMISION, { error: MSG_VENDEDOR.modo }).default('Ganancia').openapi({ example: 'Ganancia' }),
      valor_comision: valorPesos(MSG_VENDEDOR.valor).min(0, MSG_VENDEDOR.valor).default(0).openapi({
        example: 50,
        description: 'Porcentaje (0-100) en Ganancia y Venta; valor en pesos en Fijo',
      }),
      activo: z.boolean({ error: 'activo debe ser true o false' }).default(true).openapi({ example: true }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((body, ctx) => {
    if (body.modo_comision !== 'Fijo' && body.valor_comision > 100) {
      ctx.addIssue({ code: 'custom', path: ['valor_comision'], message: MSG_VENDEDOR.porcentajeMax });
    }
  });

export type SellerBody = z.output<typeof SellerBodySchema>;

export const SellerIdParamSchema = z.object({
  idVendedor: z
    .string()
    .refine(isPositiveBigintId, 'El id del vendedor debe ser un entero positivo')
    .openapi({ param: { name: 'idVendedor', in: 'path' }, example: '3' }),
});

export const ExpenseBodySchema = z
  .object(
    {
      tipo: z.enum(TIPOS_GASTO, { error: MSG_GASTO.tipo }).openapi({ example: 'Comisión' }),
      descripcion: z
        .string({ error: MSG_GASTO.descripcion })
        .trim()
        .max(DESCRIPCION_GASTO_MAX, MSG_GASTO.descripcion)
        .nullish()
        .transform((v) => v ?? '')
        .openapi({ example: 'Comisión de la venta' }),
      fecha: dateField(
        'La fecha del gasto es obligatoria',
        'La fecha del gasto debe tener el formato YYYY-MM-DD y ser válida'
      ).openapi({ example: '2026-11-07', description: 'Entre la fecha de la factura y hoy' }),
      id_seller: bigintId(MSG_GASTO.vendedor, 'El id_seller debe ser un entero positivo')
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ example: 3, description: 'Solo en Comisión' }),
      modo_comision: z
        .enum(MODOS_COMISION, { error: MSG_GASTO.modo })
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ example: 'Ganancia', description: 'Solo en Comisión' }),
      porcentaje: z
        .number({ error: MSG_GASTO.porcentaje })
        .gt(0, MSG_GASTO.porcentaje)
        .max(100, MSG_GASTO.porcentaje)
        .refine(hasAtMostTwoDecimals, 'El porcentaje admite máximo 2 decimales')
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ example: 50, description: 'Comisión en Ganancia o Venta' }),
      valor: valorPesos(MSG_GASTO.valor)
        .gt(0, MSG_GASTO.valor)
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ example: 15000, description: 'Gastos y comisión Fijo; en % lo calcula la BD' }),
      comprobante_key: comprobanteGasto
        .nullish()
        .transform((v) => v ?? null)
        .openapi({ example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301', description: 'Opcional: key de la foto subida a comercyo-back-payments-purchase-order' }),
    },
    BODY_NOT_OBJECT
  )
  .superRefine((body, ctx) => {
    if (body.tipo === 'Comisión') {
      if (body.id_seller === null) ctx.addIssue({ code: 'custom', path: ['id_seller'], message: MSG_GASTO.vendedor });
      if (body.modo_comision === null) ctx.addIssue({ code: 'custom', path: ['modo_comision'], message: MSG_GASTO.modo });
      else if (body.modo_comision === 'Fijo') {
        if (body.valor === null) ctx.addIssue({ code: 'custom', path: ['valor'], message: MSG_GASTO.valor });
      } else if (body.porcentaje === null) ctx.addIssue({ code: 'custom', path: ['porcentaje'], message: MSG_GASTO.porcentaje });
    } else if (body.valor === null) {
      ctx.addIssue({ code: 'custom', path: ['valor'], message: MSG_GASTO.valor });
    }
  });

export type ExpenseBody = z.output<typeof ExpenseBodySchema>;

export const ExpenseReceiptBodySchema = z.object(
  { comprobante_key: comprobanteGasto.openapi({ example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' }) },
  BODY_NOT_OBJECT
);

export type ExpenseReceiptBody = z.output<typeof ExpenseReceiptBodySchema>;

export const ExpenseIdParamSchema = IdParamSchema.extend({
  idGasto: z
    .string()
    .refine(isPositiveBigintId, 'El id del gasto debe ser un entero positivo')
    .openapi({ param: { name: 'idGasto', in: 'path' }, example: '7' }),
});
