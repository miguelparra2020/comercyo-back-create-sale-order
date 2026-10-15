import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { getUsersDb } from '../config/db';
import { errorBody } from '../lib/errors';
import { mapSalesOrderError, VALIDATION_CODE } from '../lib/pv-errors';
import type { AuthVariables } from '../middlewares/auth.middleware';
import type { OwnProjectVariables } from '../middlewares/require-own-project.middleware';
import * as service from '../services/sales-orders.service';
import {
  ESTADOS,
  formatIssue,
  IdParamSchema,
  ListQuerySchema,
  OrderBodySchema,
} from '../validation/sales-orders.validation';

type Vars = AuthVariables & OwnProjectVariables;
type Ctx = Context<{ Variables: Vars }>;

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
    id_product: z.string().openapi({ example: '789' }),
    producto_nombre: z.string().openapi({ example: 'Resma carta' }),
    referencia: z.string().openapi({ example: 'RES-CARTA' }),
    cantidad: z.number().openapi({ example: 2 }),
    precio_unitario: z.string().openapi({ example: '18000.00' }),
    subtotal: z.string().openapi({ example: '36000.00' }),
  })
  .openapi('SalesOrderLine');

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
    total: z.string().openapi({ example: '51000.00' }),
    atrasado: z.boolean().openapi({
      description: 'Calculado por la BD con current_date (UTC). Solo informativo, no se usa en reglas de negocio.',
    }),
    entregado_en: z.string().nullable(),
    created_at: z.string(),
    updated_at: z.string().nullable(),
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

const json = (schema: any) => ({ content: { 'application/json': { schema } } });

const errorResponses = {
  400: { description: 'Datos inválidos o falta x-own-project-id', ...json(ErrorSchema) },
  401: { description: 'No autenticado', ...json(ErrorSchema) },
  404: { description: 'Pedido no encontrado en este proyecto', ...json(ErrorSchema) },
  409: { description: 'El estado del pedido no permite la operación', ...json(ErrorSchema) },
};

const common = {
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

const scopeOf = (c: Ctx): service.Scope => ({
  id_own_project: c.get('id_own_project'),
  id_user: c.get('id_user'),
});

// Known business errors -> 4xx; anything else bubbles up to app.onError,
// which logs it and answers a generic 500.
const respondError = (c: Context, err: unknown) => {
  const mapped = mapSalesOrderError(err);
  if (!mapped) throw err;
  return c.json(mapped.body, mapped.status);
};

// Validates the POST/PUT body. Returns the parsed input or the error response.
const parseOrderBody = async (c: Context) => {
  const parsed = OrderBodySchema.safeParse(await parseJson(c));
  if (!parsed.success) {
    return { response: badRequest(c, formatIssue(parsed.error.issues)) };
  }
  return { input: parsed.data };
};

// --------------------------------------------------------------------------
// Routes
// --------------------------------------------------------------------------

const TRANSITION_SUMMARIES: Record<service.Transicion, string> = {
  prepare: 'Preparar: Pendiente -> En preparación',
  ship: 'Despachar: En preparación -> En camino',
  deliver: 'Entregar: En camino -> Entregado (la BD asigna entregado_en)',
  cancel: 'Cancelar: Pendiente | En preparación | En camino -> Cancelado',
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
    request: { params: IdParamSchema, body: { ...json(OrderBodySchema), required: true } },
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

  apiV1.openapi(createRouteDef, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c);
    if (response) return response;
    try {
      const data = await service.createSalesOrder(getUsersDb(), scopeOf(c), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(updateRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c);
    if (response) return response;
    try {
      const data = await service.updateSalesOrder(getUsersDb(), scopeOf(c), c.req.param('id'), input);
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

  apiV1.openapi(deleteRoute, async (c: Ctx) => {
    try {
      const data = await service.deleteSalesOrder(getUsersDb(), scopeOf(c), c.req.param('id'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });
};
