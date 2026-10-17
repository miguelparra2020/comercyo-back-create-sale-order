import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SignJWT } from 'jose';

const query = vi.fn();
vi.mock('./config/db', () => ({
  requiredEnv: (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`Missing required environment variable: ${name}`);
    return value;
  },
  getUsersDb: () => ({ query, connect: async () => ({ query, release: () => {} }) }),
}));

import app from './app';

const SECRET = 'test-secret-at-least-32-characters-long';
const AUDIENCE = 'comercyo-internal';

async function signToken(payload: Record<string, unknown>) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(exp)
    .setAudience(AUDIENCE)
    .sign(new TextEncoder().encode(SECRET));
}

const SALES_ORDER_PATHS = [
  '/sales-orders',
  '/sales-orders/{id}',
  '/sales-orders/{id}/prepare',
  '/sales-orders/{id}/ship',
  '/sales-orders/{id}/deliver',
  '/sales-orders/{id}/cancel',
];

const validBody = (overrides: Record<string, unknown> = {}) => ({
  id_customer: 5,
  fecha: '2026-10-15',
  fecha_entrega: '2026-10-18',
  lineas: [{ id_product: 1, cantidad: 1 }],
  ...overrides,
});

describe('app wiring', () => {
  beforeEach(() => {
    query.mockReset();
    process.env.JWT_SECRET = SECRET;
    process.env.JWT_AUDIENCE = AUDIENCE;
    process.env.TIENDAS_DB_REF = 'test-ref';
  });

  it('serves the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    expect(res.status).toBe(200);
    const doc = await res.json();
    expect(doc.openapi).toBe('3.0.0');
    expect(doc.info.title).toBe('Comercyo Pedidos de venta API');
  });

  it('declares a Bearer security scheme in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(doc.components.securitySchemes.Bearer).toEqual({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  });

  it('declares an OwnProjectId apiKey security scheme for the x-own-project-id header', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(doc.components.securitySchemes.OwnProjectId).toEqual({
      type: 'apiKey',
      in: 'header',
      name: 'x-own-project-id',
    });
  });

  it('exposes only the sales-order routes in the OpenAPI document', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    expect(Object.keys(doc.paths).sort()).toEqual([...SALES_ORDER_PATHS].sort());
  });

  it('requires both Bearer and OwnProjectId together on every sales-order operation', async () => {
    const res = await app.request('/api/v1/openapi.json');
    const doc = await res.json();
    for (const path of SALES_ORDER_PATHS) {
      for (const operation of Object.values(doc.paths[path]) as any[]) {
        expect(operation.security).toEqual([{ Bearer: [], OwnProjectId: [] }]);
      }
    }
  });

  it('returns 404 for unknown routes, including the removed purchase-order routes', async () => {
    for (const path of ['/api/v1/does-not-exist', '/api/v1/purchase-orders']) {
      const res = await app.request(path);
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ success: false, error: 'Not Found', path });
    }
  });

  describe('/sales-orders wiring', () => {
    it('rejects unauthenticated requests with 401 UNAUTHORIZED', async () => {
      expect((await app.request('/api/v1/sales-orders/1')).status).toBe(401);
      expect((await app.request('/api/v1/sales-orders/1/prepare', { method: 'POST' })).status).toBe(401);

      const res = await app.request('/api/v1/sales-orders');
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ success: false, error: 'Unauthorized', code: 'UNAUTHORIZED' });

      const bad = await app.request('/api/v1/sales-orders', { headers: { Authorization: 'Bearer not-a-jwt' } });
      expect(bad.status).toBe(401);
      expect((await bad.json()).code).toBe('UNAUTHORIZED');
      expect(query).not.toHaveBeenCalled();
    });

    it('rejects an authenticated request with no x-own-project-id header (400 INVALID_OWN_PROJECT)', async () => {
      const token = await signToken({ id_user: 7, session_id: 'session-1' });
      for (const headers of [{}, { 'x-own-project-id': 'abc' }, { 'x-own-project-id': '0' }]) {
        const res = await app.request('/api/v1/sales-orders', {
          headers: { Authorization: `Bearer ${token}`, ...headers },
        });
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({
          success: false,
          error: 'Bad Request',
          message: 'Selecciona un proyecto válido',
          code: 'INVALID_OWN_PROJECT',
        });
      }
      expect(query).not.toHaveBeenCalled();
    });

    it('accepts a real token with x-own-project-id and reaches the route handler', async () => {
      const token = await signToken({ id_user: 7, session_id: 'session-1' });
      query.mockImplementation(async (sql: string) =>
        /count\(\*\)/.test(sql) ? { rows: [{ total: 0 }] } : { rows: [] }
      );

      const res = await app.request('/api/v1/sales-orders', {
        headers: { Authorization: `Bearer ${token}`, 'x-own-project-id': '12' },
      });

      expect(res.status).toBe(200);
      const [sql, params] = query.mock.calls[0];
      expect(sql).toMatch(/id_own_project = \$1/);
      expect(params[0]).toBe(12);
    });

    it('stamps created_by_user_id from the verified token on POST', async () => {
      const token = await signToken({ id_user: 7, session_id: 'session-1' });
      query.mockImplementation(async (sql: string) => {
        if (/INSERT INTO sales_orders\b/.test(sql)) return { rows: [{ id_sales_order: '1' }], rowCount: 1 };
        if (/FROM v_sales_orders/.test(sql)) {
          return {
            rows: [{ id_sales_order: '1', id_own_project: '12', id_customer: '5', fecha: '2026-10-15', fecha_entrega: '2026-10-18', total: '0.00', created_at: new Date() }],
            rowCount: 1,
          };
        }
        return { rows: [], rowCount: 1 };
      });

      const res = await app.request('/api/v1/sales-orders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-own-project-id': '12', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody()),
      });

      expect(res.status).toBe(201);
      const insert = query.mock.calls.find(([sql]) => /INSERT INTO sales_orders\b/.test(sql))!;
      expect(insert[1][0]).toBe(12);
      expect(insert[1][5]).toBe(7); // created_by_user_id
    });

    it('returns Spanish validation messages through the OpenAPI validator', async () => {
      const token = await signToken({ id_user: 7, session_id: 'session-1' });
      const res = await app.request('/api/v1/sales-orders', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'x-own-project-id': '12', 'Content-Type': 'application/json' },
        body: JSON.stringify(validBody({ fecha_entrega: '2026-10-14' })),
      });

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        success: false,
        error: 'Bad Request',
        message: 'La entrega no puede ser antes de la fecha del pedido',
        code: 'PV_VALIDACION',
      });
      expect(query).not.toHaveBeenCalled();
    });

    it('answers a generic 500 without leaking the DB error', async () => {
      const token = await signToken({ id_user: 7, session_id: 'session-1' });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      query.mockRejectedValue(new Error('relation "v_sales_orders" does not exist at SELECT ...'));

      const res = await app.request('/api/v1/sales-orders/1', {
        headers: { Authorization: `Bearer ${token}`, 'x-own-project-id': '12' },
      });

      expect(res.status).toBe(500);
      const body = await res.text();
      expect(body).not.toMatch(/relation|SELECT|v_sales_orders/);
      expect(JSON.parse(body)).toEqual({
        success: false,
        error: 'Internal Server Error',
        message: 'Ocurrió un error inesperado. Intente de nuevo más tarde.',
        code: 'INTERNAL_ERROR',
      });
      expect(errorSpy).toHaveBeenCalled();
      errorSpy.mockRestore();
    });

    it('allows the x-own-project-id header in CORS preflight', async () => {
      const res = await app.request('/api/v1/sales-orders', {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://app.comercyo.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization,x-own-project-id,content-type',
        },
      });
      expect(res.headers.get('Access-Control-Allow-Headers')?.toLowerCase()).toContain('x-own-project-id');
    });

    it('rate limits /sales-orders at 100 requests/minute per IP (429 RATE_LIMITED)', async () => {
      const headers = { 'x-forwarded-for': '9.9.9.1' };
      let last: Response | undefined;
      for (let i = 0; i < 101; i++) {
        last = await app.request('/api/v1/sales-orders', { headers });
      }
      expect(last!.status).toBe(429);
      expect((await last!.json()).code).toBe('RATE_LIMITED');
    });
  });
});
