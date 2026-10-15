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

// Unknown and DB-computed fields (numero, total, estado, cliente_nombre,
// subtotal, producto_nombre, ...) are stripped by z.object and never reach the DB.
export const OrderBodySchema = z
  .object(
    {
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
    },
    { error: 'El cuerpo de la petición debe ser un objeto JSON' }
  )
  .superRefine((body, ctx) => {
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
  });

export type OrderBody = z.output<typeof OrderBodySchema>;
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
