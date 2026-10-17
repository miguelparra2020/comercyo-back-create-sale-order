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

export const IdParamSchema = z.object({
  id: z
    .string()
    .refine(isPositiveBigintId, 'El id debe ser un entero positivo')
    .openapi({ param: { name: 'id', in: 'path' }, example: '123' }),
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
