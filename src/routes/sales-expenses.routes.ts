import { createRoute, z } from '@hono/zod-openapi';
import { getUsersDb } from '../config/db';
import * as service from '../services/sales-expenses.service';
import {
  ExpenseBodySchema,
  ExpenseIdParamSchema,
  ExpenseReceiptBodySchema,
  IdParamSchema,
  MODOS_COMISION,
  SellerBodySchema,
  SellerIdParamSchema,
  TIPOS_GASTO,
} from '../validation/sales-orders.validation';
import { common, errorResponses, json, parseOrderBody, respondError, scopeOf, type Ctx } from './sales-orders.routes';

// Vendedores del proyecto y gastos (comisiones, preparación, envío...) de la
// factura de venta de un pedido facturado.

const SellerSchema = z
  .object({
    id_seller: z.string().openapi({ example: '3' }),
    nombre: z.string().openapi({ example: 'Ana Gómez' }),
    telefono: z.string().openapi({ example: '3001234567' }),
    modo_comision: z.enum(MODOS_COMISION).openapi({ description: 'Ganancia: % de la ganancia; Venta: % de la venta; Fijo: valor' }),
    valor_comision: z.string().openapi({ example: '50.00', description: 'Porcentaje o valor por defecto' }),
    activo: z.boolean(),
    comisiones: z.string().openapi({ example: '120000.00', description: 'Comisiones en facturas vigentes' }),
    ventas: z.number().int().openapi({ example: 4, description: 'Facturas vigentes con comisión del vendedor' }),
  })
  .openapi('Seller');

const ExpenseSchema = z
  .object({
    id_sales_invoice_expense: z.string().openapi({ example: '7' }),
    tipo: z.enum(TIPOS_GASTO),
    descripcion: z.string().openapi({ example: '' }),
    fecha: z.string().openapi({ example: '2026-11-07' }),
    id_seller: z.string().nullable(),
    vendedor_nombre: z.string().nullable(),
    modo_comision: z.enum(MODOS_COMISION).nullable(),
    porcentaje: z.string().nullable().openapi({ example: '50.00' }),
    valor: z.string().openapi({ example: '6000', description: 'En comisiones en % lo calcula la BD' }),
    comprobante_key: z.string().nullable().openapi({ description: 'Foto del comprobante (opcional)' }),
    created_at: z.string(),
  })
  .openapi('SalesInvoiceExpense');

const ExpensesSchema = z
  .object({
    gastos: z.array(ExpenseSchema).openapi({ description: 'Por fecha.' }),
    resumen: z.object({
      venta: z.string().openapi({ description: 'subtotal - descuento' }),
      costo: z.string(),
      ganancia_bruta: z.string().openapi({ description: 'venta - costo' }),
      comisiones: z.string(),
      otros_gastos: z.string(),
      gastos: z.string(),
      ganancia_neta: z.string().openapi({ description: 'ganancia_bruta - gastos' }),
    }),
  })
  .openapi('SalesInvoiceExpenses');

const ok = (data: any) => z.object({ success: z.literal(true), data });
const NOT_INVOICED = '409 FV_PEDIDO_NO_FACTURADO si la orden no está facturada; 404 PV_PEDIDO_NO_ENCONTRADO.';
const sellersCommon = { ...common, tags: ['Sellers'] };

export const registerSalesExpensesRoutes = (apiV1: any) => {
  const listSellersRoute = createRoute({
    ...sellersCommon,
    method: 'get',
    path: '/sellers',
    summary: 'Vendedores del proyecto (activos primero) con sus comisiones',
    responses: { 200: { description: 'Vendedores', ...json(ok(z.array(SellerSchema))) }, ...errorResponses },
  });

  const createSellerRoute = createRoute({
    ...sellersCommon,
    method: 'post',
    path: '/sellers',
    summary: 'Crear un vendedor',
    description: 'Errores: 409 PV_VENDEDOR_DUPLICADO (mismo nombre), 400 PV_VALIDACION.',
    request: { body: { ...json(SellerBodySchema), required: true } },
    responses: { 201: { description: 'Vendedor creado', ...json(ok(SellerSchema)) }, ...errorResponses },
  });

  const updateSellerRoute = createRoute({
    ...sellersCommon,
    method: 'put',
    path: '/sellers/{idVendedor}',
    summary: 'Actualizar un vendedor (activo=false lo desactiva; no se borran)',
    description: 'Errores: 404 PV_VENDEDOR_NO_ENCONTRADO, 409 PV_VENDEDOR_DUPLICADO, 400 PV_VALIDACION.',
    request: { params: SellerIdParamSchema, body: { ...json(SellerBodySchema), required: true } },
    responses: { 200: { description: 'Vendedor actualizado', ...json(ok(SellerSchema)) }, ...errorResponses },
  });

  const listExpensesRoute = createRoute({
    ...common,
    method: 'get',
    path: '/sales-orders/{id}/expenses',
    summary: 'Gastos de la factura de venta del pedido y su ganancia neta',
    description: NOT_INVOICED,
    request: { params: IdParamSchema },
    responses: { 200: { description: 'Gastos y resumen', ...json(ok(ExpensesSchema)) }, ...errorResponses },
  });

  const createExpenseRoute = createRoute({
    ...common,
    method: 'post',
    path: '/sales-orders/{id}/expenses',
    summary: 'Registrar un gasto de la factura (comisión de vendedor, preparación, separación, envío u otro)',
    description: [
      'Comisión: id_seller y modo_comision; en Ganancia/Venta va porcentaje y la BD calcula el valor',
      '(sobre la ganancia: venta - costo - otros gastos, recalculado cuando cambian); en Fijo va valor.',
      'Errores: 409 FV_GASTO_VENDEDOR_REPETIDO, 400 FV_GASTO_VENDEDOR_NO_ENCONTRADO / FV_GASTO_VENDEDOR_INACTIVO,',
      '400 FV_GASTO_FECHA_INVALIDA, 409 FV_FACTURA_ANULADA, 409 FV_GASTO_COMPROBANTE_EN_USO, 400 PV_VALIDACION.',
      'comprobante_key (opcional): key de la foto subida a comercyo-back-payments-purchase-order.',
      NOT_INVOICED,
    ].join('\n'),
    request: { params: IdParamSchema, body: { ...json(ExpenseBodySchema), required: true } },
    responses: { 201: { description: 'Gasto registrado', ...json(ok(ExpensesSchema)) }, ...errorResponses },
  });

  const deleteExpenseRoute = createRoute({
    ...common,
    method: 'delete',
    path: '/sales-orders/{id}/expenses/{idGasto}',
    summary: 'Borrar un gasto de la factura (los gastos no se editan)',
    description: ['Errores: 404 FV_GASTO_NO_ENCONTRADO, 409 FV_FACTURA_ANULADA.', NOT_INVOICED].join('\n'),
    request: { params: ExpenseIdParamSchema },
    responses: { 200: { description: 'Gasto borrado', ...json(ok(ExpensesSchema)) }, ...errorResponses },
  });

  const attachReceiptRoute = createRoute({
    ...common,
    method: 'put',
    path: '/sales-orders/{id}/expenses/{idGasto}/receipt',
    summary: 'Adjuntar el comprobante de pago a un gasto que no tiene (una sola vez)',
    description: [
      'Errores: 409 FV_GASTO_CON_COMPROBANTE, 409 FV_GASTO_COMPROBANTE_EN_USO, 404 FV_GASTO_NO_ENCONTRADO, 409 FV_FACTURA_ANULADA.',
      NOT_INVOICED,
    ].join('\n'),
    request: { params: ExpenseIdParamSchema, body: { ...json(ExpenseReceiptBodySchema), required: true } },
    responses: { 200: { description: 'Comprobante adjuntado', ...json(ok(ExpensesSchema)) }, ...errorResponses },
  });

  apiV1.openapi(attachReceiptRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, ExpenseReceiptBodySchema);
    if (response) return response;
    try {
      const data = await service.attachExpenseReceipt(getUsersDb(), scopeOf(c), c.req.param('id'), c.req.param('idGasto'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(listSellersRoute, async (c: Ctx) => {
    try {
      const data = await service.listSellers(getUsersDb(), c.get('id_own_project'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(createSellerRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, SellerBodySchema);
    if (response) return response;
    try {
      const data = await service.createSeller(getUsersDb(), scopeOf(c), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(updateSellerRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, SellerBodySchema);
    if (response) return response;
    try {
      const data = await service.updateSeller(getUsersDb(), scopeOf(c), c.req.param('idVendedor'), input);
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(listExpensesRoute, async (c: Ctx) => {
    try {
      const data = await service.listExpenses(getUsersDb(), c.get('id_own_project'), c.req.param('id'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(createExpenseRoute, async (c: Ctx) => {
    const { input, response } = await parseOrderBody(c, ExpenseBodySchema);
    if (response) return response;
    try {
      const data = await service.createExpense(getUsersDb(), scopeOf(c), c.req.param('id'), input);
      return c.json({ success: true, data }, 201);
    } catch (err) {
      return respondError(c, err);
    }
  });

  apiV1.openapi(deleteExpenseRoute, async (c: Ctx) => {
    try {
      const data = await service.deleteExpense(getUsersDb(), scopeOf(c), c.req.param('id'), c.req.param('idGasto'));
      return c.json({ success: true, data }, 200);
    } catch (err) {
      return respondError(c, err);
    }
  });
};
