import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { requireOwnProject, type OwnProjectVariables } from './require-own-project.middleware';
import { ACCESO_SQL, type Regla } from '../lib/permisos';

const REGLAS: Regla[] = [{ ruta: /\/cosas/, modulo: 'clientes' }];

function buildApp(acceso: unknown = { duenio: true }, id_user = 7) {
  const query = vi.fn().mockResolvedValue({ rows: [{ acceso }] });
  const app = new Hono<{ Variables: OwnProjectVariables & { id_user: number } }>();
  app.use('*', async (c, next) => {
    c.set('id_user', id_user);
    await next();
  });
  app.use('*', requireOwnProject(() => ({ query }), REGLAS));
  app.all('*', (c) => c.json({ id_own_project: c.get('id_own_project'), acceso: c.get('acceso') }));
  return { app, query };
}

const pedir = (app: Hono<any>, path = '/cosas', method = 'GET') => app.request(path, { method, headers: { 'x-own-project-id': '12' } });

describe('requireOwnProject', () => {
  it('rejects a request with no x-own-project-id header', async () => {
    const { app, query } = buildApp();
    const res = await app.request('/cosas');
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it.each(['abc', '0', '-3', '99999999999999999999'])('rejects x-own-project-id %s', async (header) => {
    const res = await buildApp().app.request('/cosas', { headers: { 'x-own-project-id': header } });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user has no access to the project', async () => {
    const { app, query } = buildApp(null);
    const res = await pedir(app);
    expect(res.status).toBe(404);
    expect(query).toHaveBeenCalledWith(ACCESO_SQL, [12, 7]);
  });

  it('lets the owner through on any route and sets id_own_project and acceso', async () => {
    const { app } = buildApp({ duenio: true });
    const res = await pedir(app, '/sin-regla', 'DELETE');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_own_project: 12, acceso: { duenio: true } });
  });

  it('lets a team member through with the permission the route needs', async () => {
    const acceso = { duenio: false, rol: 'Vendedor', permisos: { clientes: ['ver', 'crear'] } };
    const { app } = buildApp(acceso);
    expect((await pedir(app, '/cosas', 'GET')).status).toBe(200);
    expect((await pedir(app, '/cosas', 'POST')).status).toBe(200);
  });

  it('answers 403 when the team member lacks the permission', async () => {
    const { app } = buildApp({ duenio: false, rol: 'Contador', permisos: { clientes: ['ver'] } });
    const res = await pedir(app, '/cosas/3', 'DELETE');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toContain('No tienes permiso para borrar o anular en clientes');
  });

  it('a route without a rule is only for the owner', async () => {
    const { app } = buildApp({ duenio: false, permisos: { clientes: ['ver', 'crear', 'editar', 'borrar'] } });
    const res = await pedir(app, '/ajustes', 'GET');
    expect(res.status).toBe(403);
    expect((await res.json()).message).toBe('Solo el dueño de la tienda puede hacer esto');
  });
});
