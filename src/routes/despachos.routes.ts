import { createRoute, z } from '@hono/zod-openapi';
import { getUsersDb } from '../config/db';
import { errorBody } from '../lib/errors';
import { VALIDATION_CODE } from '../lib/pv-errors';
import * as despachos from '../services/despachos.service';
import { common, errorResponses, json, respondError, scopeOf, type Ctx } from './sales-orders.routes';

const PersonaSchema = z.object({ id_user: z.string(), nombre: z.string() }).openapi('PersonaDespacho');
const PasoSchema = z.object({ nombre: z.string().nullable(), en: z.string() }).nullable();
const DespachoSchema = z
  .object({
    id_sales_order: z.string(),
    numero: z.string().openapi({ example: 'PED-0042' }),
    cliente: z.string(),
    estado: z.string().openapi({ example: 'En preparación' }),
    fecha_entrega: z.string().nullable(),
    notas: z.string().nullable(),
    total: z.string(),
    empaca: PersonaSchema.nullable(),
    entrega: PersonaSchema.nullable(),
    empacado: PasoSchema.openapi({ description: 'Quién lo dejó listo para despachar y cuándo' }),
    en_camino: PasoSchema,
    entregado: PasoSchema,
  })
  .openapi('Despacho');

const IdParam = z.object({ id: z.string().regex(/^\d+$/) });
const PasoParam = z.object({ id: z.string().regex(/^\d+$/), paso: z.enum(['empacar', 'empacado', 'salir', 'entregar']) });
const AsignarBody = z.object({
  empaca_id_user: z.string().regex(/^\d+$/).nullable(),
  entrega_id_user: z.string().regex(/^\d+$/).nullable(),
});

const tags = { ...common, tags: ['Despachos'] };
const r403 = { 403: { description: 'El paso no está asignado a esta persona', ...json(z.any()) } };

const responder = (c: Ctx, err: unknown) => {
  if (err instanceof despachos.DespachoError) return c.json(errorBody(err.status, err.code, err.message), err.status);
  return respondError(c, err);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- igual que registerSalesOrdersRoutes
export function registerDespachosRoutes(apiV1: any) {
  apiV1.openapi(
    createRoute({
      ...tags,
      method: 'get',
      path: '/despachos',
      summary: 'Pedidos por empacar, listos, en camino y entregados (últimos 2 días). Quien no gestiona ve solo lo suyo.',
      request: { query: z.object({ mios: z.enum(['1', '0']).optional() }) },
      responses: {
        200: { description: 'Despachos', ...json(z.object({ success: z.literal(true), gestiona: z.boolean(), data: z.array(DespachoSchema) })) },
        401: errorResponses[401],
      },
    }),
    async (c: Ctx) => {
      const gestiona = despachos.puedeGestionar(c.get('acceso'));
      const soloMios = !gestiona || c.req.query('mios') === '1';
      const data = await despachos.listarDespachos(getUsersDb(), scopeOf(c), soloMios);
      return c.json({ success: true as const, gestiona, data }, 200);
    }
  );

  apiV1.openapi(
    createRoute({
      ...tags,
      method: 'get',
      path: '/despachos/personas',
      summary: 'Dueño y equipo activo, para asignar (solo nombre)',
      responses: { 200: { description: 'Personas', ...json(z.object({ success: z.literal(true), data: z.array(PersonaSchema) })) }, 401: errorResponses[401] },
    }),
    async (c: Ctx) => c.json({ success: true as const, data: await despachos.listarPersonas(getUsersDb(), c.get('id_own_project')) }, 200)
  );

  apiV1.openapi(
    createRoute({
      ...tags,
      method: 'put',
      path: '/despachos/{id}/asignar',
      summary: 'Asigna quién empaca y quién entrega (null = nadie)',
      request: { params: IdParam, body: { content: { 'application/json': { schema: AsignarBody } } } },
      responses: { 200: { description: 'Asignado', ...json(z.object({ success: z.literal(true) })) }, ...errorResponses },
    }),
    async (c: Ctx) => {
      const parsed = AsignarBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json(errorBody(400, VALIDATION_CODE, 'empaca_id_user y entrega_id_user: un id o null'), 400);
      try {
        await despachos.asignarDespacho(getUsersDb(), scopeOf(c), c.req.param('id'), { empaca_id_user: parsed.data.empaca_id_user ?? null, entrega_id_user: parsed.data.entrega_id_user ?? null });
        return c.json({ success: true as const }, 200);
      } catch (err) {
        return responder(c, err);
      }
    }
  );

  apiV1.openapi(
    createRoute({
      ...tags,
      method: 'post',
      path: '/despachos/{id}/{paso}',
      summary: 'Marca un paso: empacar (En preparación), empacado (Listo para despachar), salir (En camino), entregar (Entregado)',
      request: { params: PasoParam },
      responses: { 200: { description: 'Hecho', ...json(z.object({ success: z.literal(true) })) }, ...errorResponses, ...r403 },
    }),
    async (c: Ctx) => {
      const paso = c.req.param('paso') as keyof typeof despachos.PASOS;
      try {
        await despachos.marcarPaso(getUsersDb(), scopeOf(c), c.get('acceso'), c.req.param('id'), despachos.PASOS[paso]);
        return c.json({ success: true as const }, 200);
      } catch (err) {
        return responder(c, err);
      }
    }
  );
}
