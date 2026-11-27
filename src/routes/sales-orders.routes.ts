import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getUsersDb } from '../config/db';
import { errorBody } from '../lib/errors';
import { mapSalesOrderError, VALIDATION_CODE } from '../lib/pv-errors';
import type { AuthVariables } from '../middlewares/auth.middleware';
import type { OwnProjectVariables } from '../middlewares/require-own-project.middleware';
import * as service from '../services/sales-orders.service';
import { createQuickSale } from '../services/quick-sale.service';
import { despacharRuta, getDeliveryRoutes, MAX_PARADAS } from '../services/delivery-routes.service';
import { getHistorialVenta } from '../services/historial.service';
import {
  ESTADOS,
  formatIssue,
  IdParamSchema,
  InvoiceBodySchema,
  UpdateInvoiceBodySchema,
  issueCode,
  ListQuerySchema,
  OrderBodySchema,
  TIPOS_AJUSTE,
  UpdateOrderBodySchema,
  CambiarPagoBodySchema,
  QuickSaleBodySchema,
} from '../validation/sales-orders.validation';

type Vars = AuthVariables & OwnProjectVariables;
export type Ctx = Context<{ Variables: Vars }>;

// --------------------------------------------------------------------------
// OpenAPI response schemas
// --------------------------------------------------------------------------

const ErrorSchema = z
  .object({
    success: z.literal(false),
    error: z.string().openapi({ example: 'Conflict' }),
    message: z.string().openapi({ example: 'El pedido PED-0001 no puede pasar de Pendiente a Entregado.' }),
    code: z.string().openapi({ example: 'PV_TRANSICION_INVALIDA' }),
  })
  .openapi('Error');

const LineaResponseSchema = z
  .object({
    id_sales_order_line: z.string().openapi({ example: '456' }),
    id_product: z.string().nullable().openapi({ example: '789', description: 'null en una línea de servicio (cobro de citas)' }),
    id_service: z.string().nullable().openapi({ example: null, description: 'Servicio cobrado (tarea 12); null en líneas de producto' }),
    producto_nombre: z.string().openapi({ example: 'Resma carta' }),
    referencia: z.string().openapi({ example: 'RES-CARTA' }),
    cantidad: z.number().openapi({ example: 2 }),
    precio_unitario: z.string().openapi({ example: '18000.00' }),
    costo_unitario: z.string().openapi({
      example: '12000.00',
      description: 'Solo lectura: costo del producto cuando se agregó la línea (la BD lo toma de productos.precio_costo; no cambia si después cambia el costo).',
    }),
    subtotal: z.string().openapi({ example: '36000.00' }),
  })
  .openapi('SalesOrderLine');

const FacturaSchema = z
  .object({
    id_sales_invoice: z.string().openapi({ example: '55' }),
    numero: z.string().openapi({ example: 'FV-0001' }),
    fecha_emision: z.string().openapi({ example: '2026-11-06' }),
    fecha_vencimiento: z.string().openapi({ example: '2026-12-06' }),
    total: z.string().openapi({ example: '62621.00', description: 'Copiado del total del pedido al facturar.' }),
    notas: z.string(),
    created_at: z.string(),
    pagado: z.string().openapi({ example: '20000.00', description: 'Suma de los abonos vigentes.' }),
    saldo: z.string().openapi({ example: '42621.00', description: 'max(total - pagado, 0).' }),
    estado: z.enum(['Pendiente', 'Vencida', 'Pagada']).openapi({
      description: 'Calculado con la fecha de Bogotá: Pagada si saldo 0; Vencida si venció con saldo; si no, Pendiente.',
    }),
    dias_vencida: z.number().nullable().openapi({ example: null }),
  })
  .openapi('SalesInvoice');

const SalesOrderSchema = z
  .object({
    id_sales_order: z.string().openapi({ example: '123' }),
    id_own_project: z.number().openapi({ example: 1 }),
    numero: z.string().openapi({ example: 'PED-0001' }),
    id_customer: z.string().openapi({ example: '5' }),
    cliente_nombre: z.string().openapi({ example: 'Laura Gómez' }),
    fecha: z.string().openapi({ example: '2026-10-15' }),
    fecha_entrega: z.string().openapi({ example: '2026-10-18' }),
    notas: z.string(),
    estado: z.enum(ESTADOS),
    descuento_tipo: z.enum(TIPOS_AJUSTE).nullable().openapi({ example: 'porcentaje' }),
    descuento_valor: z.string().openapi({ example: '10.00' }),
    impuesto_tipo: z.enum(TIPOS_AJUSTE).nullable().openapi({ example: 'porcentaje' }),
    impuesto_valor: z.string().openapi({ example: '19.00' }),
    costo_envio: z.string().openapi({ example: '8000.00' }),
    subtotal: z.string().openapi({
      example: '51000.00',
      description: 'Solo lectura (calculado por la BD): SUM(cantidad × precio_unitario) de las líneas.',
    }),
    descuento_monto: z.string().openapi({
      example: '5100.00',
      description: "Solo lectura: 'porcentaje' → ROUND(subtotal × descuento_valor / 100, 2); 'valor' → descuento_valor; null → 0.",
    }),
    impuesto_monto: z.string().openapi({
      example: '8721.00',
      description:
        "Solo lectura: sobre base = subtotal - descuento_monto. 'porcentaje' → ROUND(base × impuesto_valor / 100, 2); 'valor' → impuesto_valor; null → 0.",
    }),
    total: z.string().openapi({
      example: '62621.00',
      description: 'Solo lectura: subtotal - descuento_monto + impuesto_monto + costo_envio (el envío no lleva impuesto).',
    }),
    atrasado: z.boolean().openapi({
      description: 'Calculado por la BD con current_date (UTC). Solo informativo, no se usa en reglas de negocio.',
    }),
    origen: z.enum(['Manual', 'Marketplace']).openapi({
      description: 'Dónde se tomó el pedido: Manual (creado en Pedidos de venta) o Marketplace (lo hizo el cliente desde la tienda pública).',
    }),
    condicion_pago: z.enum(['anticipado', 'contra_entrega']).nullable().openapi({
      description: 'Pago anticipado o contra entrega: en el marketplace lo elige el cliente; en los manuales lo pone la tienda. null si no se definió.',
    }),
    forma_pago: z.enum(['contado', 'credito']).openapi({ description: 'Contado o crédito. Cartera solo muestra las facturas de pedidos a crédito.' }),
    plazo_dias: z.number().nullable().openapi({ description: 'Días de plazo del crédito; null si es de contado.' }),
    entrega: z.enum(['domicilio', 'recoger']).nullable().openapi({
      description: 'Pedidos del marketplace: domicilio o el cliente recoge en la tienda. null en los manuales.',
    }),
    km_cobrados: z.number().nullable().openapi({ description: 'Kilómetros cobrados en el domicilio del marketplace' }),
    franja_entrega: z.enum(['manana', 'tarde']).nullable().openapi({ description: 'Franja de entrega escogida por el cliente (mañana 8–1, tarde 1–9); el día es fecha_entrega' }),
    medio_pago: z
      .object({ tipo: z.string(), nombre: z.string() })
      .nullable()
      .openapi({ description: 'Medio con el que el cliente del marketplace dijo que paga (por ejemplo Nequi o efectivo); null en los manuales' }),
    dropshipper: z
      .object({ id: z.string(), nombre_tienda: z.string(), slug: z.string().nullable() })
      .nullable()
      .openapi({ description: 'Tienda del dropshipper por la que entró el pedido; null si se compró directo o se tomó a mano' }),
    entregado_en: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
    factura: FacturaSchema.nullable().openapi({
      description: 'Factura de venta vigente (no anulada) del pedido, o null si no está facturado.',
    }),
    lineas: z.array(LineaResponseSchema),
  })
  .openapi('SalesOrder');

const SalesOrderResponseSchema = z.object({
  success: z.literal(true),
  data: SalesOrderSchema,
});

const SalesOrderListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(SalesOrderSchema),
  pagination: z.object({
    page: z.number(),
    limit: z.number(),
    total: z.number(),
    totalPages: z.number(),
  }),
});

export const json = (schema: any) => ({ content: { 'application/json': { schema } } });

export const errorResponses = {
  400: { description: 'Datos inválidos o falta x-own-project-id', ...json(ErrorSchema) },
  401: { description: 'No autenticado', ...json(ErrorSchema) },
  404: { description: 'Pedido no encontrado en este proyecto', ...json(ErrorSchema) },
  409: { description: 'El estado del pedido no permite la operación', ...json(ErrorSchema) },
};

export const common = {
  tags: ['Sales orders'],
  security: [{ Bearer: [], OwnProjectId: [] }],
};

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

const parseJson = async (c: Context) => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

const badRequest = (c: Context, message: string) => c.json(errorBody(400, VALIDATION_CODE, message), 400);

export const scopeOf = (c: Ctx): service.Scope => ({
  id_own_project: c.get('id_own_project'),
  id_user: c.get('id_user'),
});

// Known business errors -> 4xx; anything else bubbles up to app.onError,
// which logs it and answers a generic 500.
export const respondError = (c: Context, err: unknown) => {
  const mapped = mapSalesOrderError(err);
  if (!mapped) throw err;
  return c.json(mapped.body, mapped.status);
};

// Validates the POST/PUT body. Returns the parsed input or the error response.
export const parseOrderBody = async <T>(c: Context, schema: { safeParse: (value: unknown) => z.ZodSafeParseResult<T> }) => {
  const parsed = schema.safeParse(await parseJson(c));
  if (!parsed.success) {
    const { issues } = parsed.error;
    return { response: c.json(errorBody(400, issueCode(issues) ?? VALIDATION_CODE, formatIssue(issues)), 400) };
  }
  return { input: parsed.data };
};

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

const AJUSTES_DESCRIPTION = [
  'Ajustes opcionales a nivel de pedido: descuento_tipo/descuento_valor, impuesto_tipo/impuesto_valor y costo_envio.',
  "- tipo: 'porcentaje' | 'valor' | null. Con tipo null el valor debe ser 0 (si no, 400).",
  "- valores: número >= 0 con máximo 2 decimales; con 'porcentaje', <= 100.",
  "- descuento 'valor': <= SUM(cantidad × precio_unitario) de las líneas, si no 400 PV_DESCUENTO_EXCEDE_SUBTOTAL.",
  '- subtotal, descuento_monto, impuesto_monto y total los calcula la BD; si vienen en el body se ignoran.',
  'Cálculo: base = subtotal - descuento_monto; impuesto_monto sobre la base; total = base + impuesto_monto + costo_envio.',
].join('\n');

const TRANSITION_SUMMARIES: Record<service.Transicion, string> = {
  prepare: 'Preparar: Pendiente -> En preparación',
  ready: 'Listo para despachar: En preparación -> Listo para despachar (empacado, espera ruta)',
  ship: 'Despachar: En preparación | Listo para despachar -> En camino',
  deliver: 'Entregar: Listo para despachar (lo recoge el cliente) | En camino -> Entregado (la BD asigna entregado_en)',
  cancel: 'Cancelar: Pendiente | En preparación | Listo para despachar | En camino -> Cancelado',
};

export const registerSalesOrdersRoutes = (apiV1: any) => {
  const listRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders',
    summary: 'Listar pedidos de venta',
    request: { query: ListQuerySchema },
    responses: {
      200: { description: 'Pedidos de venta con sus líneas', ...json(SalesOrderListResponseSchema) },
      400: errorResponses[400],
      401: errorResponses[401],
    },
  });

  const getRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/{id}',
    summary: 'Detalle de un pedido de venta',
    request: { params: IdParamSchema },
    responses: {
      200: { description: 'Pedido de venta', ...json(SalesOrderResponseSchema) },
      400: errorResponses[400],
      401: errorResponses[401],
      404: errorResponses[404],
    },
  });

  const createRouteDef = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders',
    summary: 'Crear un pedido de venta (queda en Pendiente)',
    description: AJUSTES_DESCRIPTION + '\n\nPOST: un ajuste que no venga queda en null / 0.',
    request: { body: { ...json(OrderBodySchema), required: true } },
    responses: {
      201: { description: 'Pedido creado', ...json(SalesOrderResponseSchema) },
      400: errorResponses[400],
      401: errorResponses[401],
      409: errorResponses[409],
    },
  });

  const updateRoute = createRoute({
    ...common,
    method: 'put',
    path: '/sales-orders/{id}',
    summary: 'Reemplazar cabecera y líneas (solo en Pendiente o En preparación)',
    description:
      AJUSTES_DESCRIPTION +
      '\n\nPUT: un ajuste que no venga conserva el valor actual del pedido. Cambiar un ajuste fuera de ' +
      "'Pendiente'/'En preparación' -> 409 PV_PEDIDO_NO_EDITABLE.",
    request: { params: IdParamSchema, body: { ...json(UpdateOrderBodySchema), required: true } },
    responses: {
      200: { description: 'Pedido actualizado', ...json(SalesOrderResponseSchema) },
      ...errorResponses,
    },
  });

  const cambiarPagoRoute = createRoute({
    ...common,
    method: 'patch',
    path: '/sales-orders/{id}/pago',
    summary: 'Cambiar la condición y el medio de pago (en cualquier estado, también del marketplace)',
    request: { params: IdParamSchema, body: { ...json(CambiarPagoBodySchema), required: true } },
    responses: {
      200: { description: 'Pedido actualizado', ...json(SalesOrderResponseSchema) },
      ...errorResponses,
    },
  });

  const transitionRoute = (accion: service.Transicion) =>
    createRoute({
      ...common,
      method: 'post',
      path: `/sales-orders/{id}/${accion}`,
      summary: TRANSITION_SUMMARIES[accion],
      request: { params: IdParamSchema },
      responses: {
        200: { description: 'Pedido actualizado', ...json(SalesOrderResponseSchema) },
        ...errorResponses,
      },
    });

  const invoiceRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/{id}/invoice',
    summary: 'Facturar el pedido: crea su factura de venta (FV-0001...)',
    description: [
      'La BD numera la factura por proyecto y copia el cliente y el total del pedido (con descuento, impuesto y envío).',
      'Desde ese momento el pedido no se puede cancelar, eliminar ni cambiar de cliente, líneas o ajustes',
      '(409 FV_PEDIDO_FACTURADO); sí puede avanzar de estado.',
      'Errores: 409 FV_PEDIDO_CANCELADO, 409 FV_PEDIDO_YA_FACTURADO, 409 FV_PEDIDO_SIN_TOTAL,',
      '400 FV_FACTURA_VENCIMIENTO_ANTERIOR, 404 PV_PEDIDO_NO_ENCONTRADO.',
    ].join('\n'),
    request: { params: IdParamSchema, body: { ...json(InvoiceBodySchema), required: true } },
    responses: {
      200: { description: 'Pedido con su factura', ...json(SalesOrderResponseSchema) },
      ...errorResponses,
    },
  });

  const updateInvoiceRoute = createRoute({
    ...common,
    method: 'put',
    path: '/sales-orders/{id}/invoice',
    summary: 'Editar la factura de venta: fecha de emisión, vencimiento y notas',
    description: [
      'El total, las líneas, el inventario y el cliente no cambian.',
      'Errores: 409 FV_PEDIDO_NO_FACTURADO, 409 FV_FACTURA_ANULADA,',
      '400 FV_FECHA_DESPUES_DE_MOVIMIENTOS (después del primer abono vigente, devolución o gasto),',
      '400 FV_FACTURA_VENCIMIENTO_ANTERIOR.',
    ].join('\n'),
    request: { params: IdParamSchema, body: { ...json(UpdateInvoiceBodySchema), required: true } },
    responses: {
      200: { description: 'Pedido con su factura actualizada', ...json(SalesOrderResponseSchema) },
      ...errorResponses,
    },
  });

  const deleteRoute = createRoute({
    ...common,
    method: 'delete',
    path: '/sales-orders/{id}',
    summary: 'Borrado lógico (solo en Pendiente)',
    request: { params: IdParamSchema },
    responses: {
      200: { description: 'Pedido eliminado', ...json(SalesOrderResponseSchema) },
      ...errorResponses,
    },
  });

  // Tarea 56: antes de /sales-orders/{id} para que "delivery-routes" no se tome como id.
  const Coords = z.object({ lat: z.number(), lng: z.number() }).nullable();
  const deliveryRoutesRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/delivery-routes',
    summary: 'Pedidos Listo para despachar y En camino con su destino, para armar la ruta de entrega',
    description:
      'Origen: la ubicación de la tienda (store_info). Paradas: los pedidos a domicilio Listo para despachar y En camino (máximo 100; los que el cliente recoge no van). Los del marketplace traen el pin del cliente; los manuales, solo la dirección del cliente.',
    responses: {
      200: {
        description: 'Origen y paradas',
        ...json(
          z.object({
            success: z.literal(true),
            data: z.object({
              origen: z.object({ direccion: z.string().nullable(), ubicacion: Coords }),
              paradas: z.array(
                z.object({
                  id_sales_order: z.string(),
                  numero: z.string(),
                  cliente: z.string(),
                  telefono: z.string().nullable(),
                  direccion: z.string().nullable(),
                  detalle_direccion: z.string().nullable(),
                  ciudad: z.string().nullable(),
                  ubicacion: Coords,
                  total: z.number(),
                  condicion_pago: z.enum(['anticipado', 'contra_entrega']).nullable(),
                  fecha_entrega: z.string().nullable(),
                  estado: z.enum(['Listo para despachar', 'En camino']),
                })
              ),
            }),
          })
        ),
      },
      401: errorResponses[401],
    },
  });
  apiV1.openapi(deliveryRoutesRoute, async (c: Ctx) =>
    c.json({ success: true as const, data: await getDeliveryRoutes(getUsersDb(), c.get('id_own_project')) }, 200)
  );

  // 2026-11-21: opciones del pedido manual (antes de /sales-orders/{id}).
  const optionsRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/options',
    summary: 'Medios de pago de la tienda y dropshippers a los que se les puede dar la venta',
    description:
      'medios: los medios de pago activos de la tienda (store_payment_methods). dropshippers: solo en la tienda proveedora de Dropi, sus dropshippers aprobados (sin datos de contacto); en las demás, vacío.',
    responses: {
      200: {
        description: 'Opciones',
        ...json(
          z.object({
            success: z.literal(true),
            data: z.object({
              medios: z.array(
                z.object({ id: z.string(), tipo: z.string(), nombre: z.string(), datos: z.string(), contra_entrega: z.boolean(), anticipado: z.boolean() })
              ),
              dropshippers: z.array(z.object({ id: z.string(), nombre_tienda: z.string(), nombre_completo: z.string() })),
            }),
          })
        ),
      },
      401: errorResponses[401],
    },
  });
  apiV1.openapi(optionsRoute, async (c: Ctx) =>
    c.json({ success: true as const, data: await service.getOrderOptions(getUsersDb(), c.get('id_own_project')) }, 200)
  );

  // Sacar la ruta: los pedidos Listo para despachar de la ruta pasan a En camino.
  const dispatchRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/delivery-routes/dispatch',
    summary: 'Salir a ruta: pasa a En camino los pedidos Listo para despachar escogidos',
    description: 'Solo cambia los de la tienda que siguen en Listo para despachar; los demás se ignoran. Devuelve cuántos salieron.',
    request: {
      body: {
        required: true,
        ...json(
          z.object({
            ids: z
              .array(z.string().regex(/^\d{1,18}$/, 'Pedido no válido'))
              .min(1, 'Escoge al menos un pedido')
              .max(MAX_PARADAS, `Máximo ${MAX_PARADAS} pedidos por ruta`),
          })
        ),
      },
    },
    responses: {
      200: {
        description: 'Pedidos que salieron',
        ...json(z.object({ success: z.literal(true), data: z.object({ despachados: z.array(z.string()) }) })),
      },
      400: errorResponses[400],
      401: errorResponses[401],
    },
  });
  apiV1.openapi(dispatchRoute, async (c: Ctx) => {
    const body = await c.req.json().catch(() => null);
    const parsed = z
      .object({ ids: z.array(z.string().regex(/^\d{1,18}$/)).min(1).max(MAX_PARADAS) })
      .safeParse(body);
    if (!parsed.success) {
      return c.json({ success: false, error: 'Bad Request', code: 'PV_RUTA_INVALIDA', message: 'Escoge entre 1 y 100 pedidos de la ruta' }, 400);
    }
    try {
      const despachados = await despacharRuta(getUsersDb(), scopeOf(c), parsed.data.ids);
      return c.json({ success: true as const, data: { despachados } }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  // Tarea 57: historial del pedido (de lo primero a lo último).
  const HistorialSchema = z.object({
    success: z.literal(true),
    data: z.object({
      pedido: z.object({ id: z.string(), numero: z.string(), tercero: z.string(), estado: z.string(), total: z.number(), origen: z.string().nullable() }),
      eventos: z.array(
        z.object({
          fecha: z.string(),
          tipo: z.enum(['creado', 'estado', 'factura', 'factura_anulada', 'pago', 'pago_anulado', 'devolucion']),
          titulo: z.string(),
          detalle: z.string().nullable(),
        })
      ),
    }),
  });
  const historyRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/{id}/history',
    summary: 'Historial del pedido: creación, estados, factura, pagos y devoluciones, por fecha y hora',
    request: { params: IdParamSchema },
    responses: { 200: { description: 'Historial', ...json(HistorialSchema) }, 400: errorResponses[400], 401: errorResponses[401], 404: errorResponses[404] },
  });
  apiV1.openapi(historyRoute, async (c: Ctx) => {
    try {
      return c.json({ success: true as const, data: await getHistorialVenta(getUsersDb(), c.req.param('id'), { id_own_project: c.get('id_own_project') }) }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(listRoute, async (c: Ctx) => {
    const parsed = ListQuerySchema.safeParse(c.req.query());
    if (!parsed.success) return badRequest(c, formatIssue(parsed.error.issues));
    const result = await service.listSalesOrders(getUsersDb(), c.get('id_own_project'), parsed.data);
    return c.json({ success: true, ...result }, 200);
  });

  apiV1.openapi(getRoute, async (c: Ctx) => {
    try {
      const data = await service.getSalesOrder(getUsersDb(), c.req.param('id'), c.get('id_own_project'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  const quickSaleRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/quick-sale',
    summary: 'Caja rápida: venta de mostrador entregada, facturada y pagada en un solo paso',
    description: [
      'En una transacción: crea el pedido con fecha de hoy, lo lleva a Entregado, emite la factura',
      '(descuenta el inventario) y registra un abono por el total con el método elegido.',
      'Sin id_customer la venta queda a nombre de "Consumidor final" (se crea la primera vez).',
      'Si algo falla (p. ej. 409 FV_STOCK_INSUFICIENTE) no queda nada guardado.',
    ].join('\n'),
    request: { body: { ...json(QuickSaleBodySchema), required: true } },
    responses: {
      201: { description: 'Pedido entregado, facturado y pagado', ...json(SalesOrderResponseSchema) },
      400: errorResponses[400],
      401: errorResponses[401],
      409: errorResponses[409],
    },
  });

  apiV1.openapi(quickSaleRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, QuickSaleBodySchema);
    if (response) return response;
    try {
      const data = await createQuickSale(getUsersDb(), scopeOf(c), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(createRouteDef, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, OrderBodySchema);
    if (response) return response;
    try {
      const data = await service.createSalesOrder(getUsersDb(), scopeOf(c), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(updateRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, UpdateOrderBodySchema);
    if (response) return response;
    try {
      const data = await service.updateSalesOrder(getUsersDb(), scopeOf(c), c.req.param('id'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(cambiarPagoRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, CambiarPagoBodySchema);
    if (response) return response;
    try {
      const data = await service.cambiarPagoPedido(getUsersDb(), scopeOf(c), c.req.param('id'), { condicion_pago: input.condicion_pago ?? null, id_medio_pago: input.id_medio_pago ?? null });
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  for (const accion of Object.keys(service.TRANSICIONES) as service.Transicion[]) {
    apiV1.openapi(transitionRoute(accion), async (c: Ctx) => {
      try {
        const data = await service.transitionSalesOrder(getUsersDb(), scopeOf(c), c.req.param('id'), accion);
        return c.json({ success: true, data }, 200);
      } catch (err) {
        return respondError(c, err);
      }
    });
  }

  apiV1.openapi(invoiceRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, InvoiceBodySchema);
    if (response) return response;
    try {
      const data = await service.invoiceSalesOrder(getUsersDb(), scopeOf(c), c.req.param('id'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(updateInvoiceRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, UpdateInvoiceBodySchema);
    if (response) return response;
    try {
      const data = await service.updateSalesInvoice(getUsersDb(), scopeOf(c), c.req.param('id'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(deleteRoute, async (c: Ctx) => {
    try {
      const data = await service.deleteSalesOrder(getUsersDb(), scopeOf(c), c.req.param('id'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });
};
