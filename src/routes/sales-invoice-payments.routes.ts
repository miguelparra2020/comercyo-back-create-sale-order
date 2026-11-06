import { createRoute, z } from '@hono/zod-openapi';
import { getUsersDb } from '../config/db';
import * as service from '../services/sales-invoice-payments.service';
import {
  IdParamSchema,
  METODOS_PAGO,
  PaymentBodySchema,
  PaymentIdParamSchema,
  VoidPaymentBodySchema,
} from '../validation/sales-orders.validation';
import { common, errorResponses, json, parseOrderBody, respondError, scopeOf, type Ctx } from './sales-orders.routes';

// Abonos del cliente sobre la factura de venta de un pedido facturado.
// Misma forma que los pagos de compra (comercyo-back-create-purchase-order).

const PaymentSchema = z
  .object({
    id_sales_invoice_payment: z.string().openapi({ example: '9' }),
    fecha: z.string().openapi({ example: '2026-11-06' }),
    metodo: z.enum(METODOS_PAGO).openapi({ example: 'Transferencia' }),
    monto: z.string().openapi({ example: '50000.00' }),
    referencia: z.string().openapi({ example: 'Transferencia #88213' }),
    created_at: z.string().openapi({ example: '2026-11-06T15:00:00.000Z' }),
    anulado_en: z.string().nullable().openapi({ description: 'null si el abono está vigente.' }),
    motivo_anulacion: z.string().nullable().openapi({ example: null }),
    comprobante_key: z.string().nullable().openapi({
      example: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      description: 'UUID de la foto del comprobante (backend de comprobantes); null si el abono en efectivo no la tiene.',
    }),
  })
  .openapi('SalesInvoicePayment');

const PaymentsSchema = z
  .object({
    pagos: z.array(PaymentSchema).openapi({ description: 'Por fecha; incluye los anulados.' }),
    resumen: z.object({
      total: z.string().openapi({ example: '62621.00' }),
      pagado: z.string().openapi({ example: '20000.00', description: 'Suma de los abonos vigentes.' }),
      saldo: z.string().openapi({ example: '42621.00' }),
      estado: z.enum(['Pendiente', 'Pago parcial', 'Pagada']),
    }),
  })
  .openapi('SalesInvoicePayments');

const PaymentsResponseSchema = z.object({ success: z.literal(true), data: PaymentsSchema });

const NOT_INVOICED = '409 FV_PEDIDO_NO_FACTURADO si el pedido no está facturado; 404 PV_PEDIDO_NO_ENCONTRADO.';

export const registerSalesInvoicePaymentsRoutes = (apiV1: any) => {
  const listRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/{id}/payments',
    summary: 'Abonos de la factura de venta del pedido, con su resumen',
    description: ['Incluye los abonos anulados; solo los vigentes cuentan en pagado/saldo/estado.', NOT_INVOICED].join('\n'),
    request: { params: IdParamSchema },
    responses: {
      200: { description: 'Abonos y resumen', ...json(PaymentsResponseSchema) },
      ...errorResponses,
    },
  });

  const createPaymentRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/{id}/payments',
    summary: 'Registrar un abono (total o parcial) de la factura de venta',
    description: [
      'Errores: 409 FV_PAGO_EXCEDE_SALDO (monto > saldo), 400 FV_PAGO_FECHA_ANTERIOR (antes de la factura),',
      '400 FV_PAGO_FECHA_FUTURA (después de hoy), 400 FV_PAGO_COMPROBANTE_REQUERIDO (Transferencia sin comprobanteKey),',
      '409 FV_PAGO_COMPROBANTE_EN_USO (la foto ya respalda otro abono), 400 PV_VALIDACION.',
      NOT_INVOICED,
    ].join('\n'),
    request: { params: IdParamSchema, body: { ...json(PaymentBodySchema), required: true } },
    responses: {
      201: { description: 'Abono registrado; abonos y resumen actualizados', ...json(PaymentsResponseSchema) },
      ...errorResponses,
    },
  });

  const voidPaymentRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/{id}/payments/{idPago}/void',
    summary: 'Anular un abono con su motivo',
    description: [
      'El abono no se borra: queda anulado con su motivo y deja de contar en el saldo. No se puede des-anular.',
      'Errores: 400 FV_PAGO_MOTIVO_REQUERIDO, 404 FV_PAGO_NO_ENCONTRADO, 409 FV_PAGO_YA_ANULADO.',
      NOT_INVOICED,
    ].join('\n'),
    request: { params: PaymentIdParamSchema, body: { ...json(VoidPaymentBodySchema), required: true } },
    responses: {
      200: { description: 'Abono anulado; abonos y resumen actualizados', ...json(PaymentsResponseSchema) },
      ...errorResponses,
    },
  });

  apiV1.openapi(listRoute, async (c: Ctx) => {
    try {
      const data = await service.listPayments(getUsersDb(), c.get('id_own_project'), c.req.param('id'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(createPaymentRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, PaymentBodySchema);
    if (response) return response;
    try {
      const data = await service.createPayment(getUsersDb(), scopeOf(c), c.req.param('id'), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(voidPaymentRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, VoidPaymentBodySchema);
    if (response) return response;
    try {
      const data = await service.voidPayment(getUsersDb(), scopeOf(c), c.req.param('id'), c.req.param('idPago'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });
};
