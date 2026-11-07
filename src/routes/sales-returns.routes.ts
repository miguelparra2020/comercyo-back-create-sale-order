import { createRoute, z } from '@hono/zod-openapi';
import { getUsersDb } from '../config/db';
import * as service from '../services/sales-returns.service';
import {
  IdParamSchema,
  METODOS_PAGO,
  RESOLUCIONES_DEVOLUCION,
  ResolveReturnBodySchema,
  ReturnBodySchema,
  ReturnIdParamSchema,
} from '../validation/sales-orders.validation';
import { common, errorResponses, json, parseOrderBody, respondError, scopeOf, type Ctx } from './sales-orders.routes';

// Devoluciones del cliente sobre la factura de venta de un pedido facturado.

const ReturnLineSchema = z.object({
  id_product: z.string().openapi({ example: '789' }),
  producto_nombre: z.string().openapi({ example: 'Bolso de cuero' }),
  cantidad: z.number().int().openapi({ example: 2 }),
  precio_unitario: z.string().openapi({ example: '12000.00' }),
  subtotal: z.string().openapi({ example: '24000.00' }),
});

const ReturnSchema = z
  .object({
    id_sales_return: z.string().openapi({ example: '4' }),
    numero: z.string().openapi({ example: 'DV-0001' }),
    fecha: z.string().openapi({ example: '2026-11-07' }),
    motivo: z.string().openapi({ example: 'No le quedó' }),
    mueve_inventario: z.boolean().openapi({ description: 'false si la factura no descontó inventario: la devolución tampoco lo mueve.' }),
    valor: z.string().openapi({ example: '24000.00', description: 'Σ cantidad × precio del pedido' }),
    resolucion: z.enum(RESOLUCIONES_DEVOLUCION).nullable().openapi({ description: 'null mientras espera reposición o reintegro.' }),
    resuelta_fecha: z.string().nullable().openapi({ example: '2026-11-08' }),
    metodo: z.enum(METODOS_PAGO).nullable().openapi({ description: 'Solo en Reintegro.' }),
    monto_reintegro: z.string().nullable().openapi({ example: '24000.00' }),
    referencia: z.string().openapi({ example: '' }),
    created_at: z.string().openapi({ example: '2026-11-07T15:00:00.000Z' }),
    lineas: z.array(ReturnLineSchema),
  })
  .openapi('SalesReturn');

const ReturnsSchema = z
  .object({
    devoluciones: z.array(ReturnSchema).openapi({ description: 'Por fecha.' }),
    resumen: z.object({
      devuelto: z.string().openapi({ example: '24000.00' }),
      reintegrado: z.string().openapi({ example: '0.00', description: 'Dinero reintegrado: baja el saldo de la factura.' }),
      por_resolver: z.string().openapi({ example: '24000.00' }),
    }),
  })
  .openapi('SalesReturns');

const ReturnsResponseSchema = z.object({ success: z.literal(true), data: ReturnsSchema });

const NOT_INVOICED = '409 FV_PEDIDO_NO_FACTURADO si la orden no está facturada; 404 PV_PEDIDO_NO_ENCONTRADO.';

export const registerSalesReturnsRoutes = (apiV1: any) => {
  const listRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/{id}/returns',
    summary: 'Devoluciones del cliente de la factura de venta del pedido',
    description: NOT_INVOICED,
    request: { params: IdParamSchema },
    responses: { 200: { description: 'Devoluciones y resumen', ...json(ReturnsResponseSchema) }, ...errorResponses },
  });

  const createReturnRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/{id}/returns',
    summary: 'Registrar una devolución del cliente (la mercancía vuelve al inventario)',
    description: [
      'Suma al stock lo devuelto si la factura descontó inventario.',
      'Errores: 409 FV_DEV_CANTIDAD_EXCEDE (más de lo facturado menos lo ya devuelto), 409 FV_FACTURA_ANULADA,',
      '400 FV_DEV_PRODUCTO_NO_FACTURADO, 400 FV_DEV_FECHA_INVALIDA (antes de la factura o después de hoy), 400 PV_VALIDACION.',
      NOT_INVOICED,
    ].join('\n'),
    request: { params: IdParamSchema, body: { ...json(ReturnBodySchema), required: true } },
    responses: { 201: { description: 'Devolución registrada', ...json(ReturnsResponseSchema) }, ...errorResponses },
  });

  const resolveRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/{id}/returns/{idDev}/resolve',
    summary: 'Resolver una devolución: reposición de la mercancía o reintegro de dinero',
    description: [
      'Reposición: se le vuelve a entregar al cliente y sale del inventario (409 FV_DEV_STOCK_INSUFICIENTE si no alcanza).',
      'Reintegro: dinero devuelto (metodo y monto <= valor); baja el saldo de la factura.',
      'Una sola vez. Errores: 409 FV_DEV_YA_RESUELTA, 409 FV_DEV_REINTEGRO_EXCEDE, 400 FV_DEV_FECHA_INVALIDA, 404 FV_DEV_NO_ENCONTRADA.',
      NOT_INVOICED,
    ].join('\n'),
    request: { params: ReturnIdParamSchema, body: { ...json(ResolveReturnBodySchema), required: true } },
    responses: { 200: { description: 'Devolución resuelta', ...json(ReturnsResponseSchema) }, ...errorResponses },
  });

  apiV1.openapi(listRoute, async (c: Ctx) => {
    try {
      const data = await service.listReturns(getUsersDb(), c.get('id_own_project'), c.req.param('id'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(createReturnRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, ReturnBodySchema);
    if (response) return response;
    try {
      const data = await service.createReturn(getUsersDb(), scopeOf(c), c.req.param('id'), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(resolveRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, ResolveReturnBodySchema);
    if (response) return response;
    try {
      const data = await service.resolveReturn(getUsersDb(), scopeOf(c), c.req.param('id'), c.req.param('idDev'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });
};
