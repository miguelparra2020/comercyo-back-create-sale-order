import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { requireOwnProject, PROJECT_ACCESS_SQL, type OwnProjectVariables } from './require-own-project.middleware';

function buildApp(rows: unknown[] = [{ '?column?': 1 }], id_user = 7) {
  const query = vi.fn().mockResolvedValue({ rows });
  const app = new Hono<{ Variables: OwnProjectVariables & { id_user: number } }>();
  app.use('*', async (c, next) => {
    c.set('id_user', id_user);
    await next();
  });
  app.use('*', requireOwnProject(() => ({ query })));
  app.get('/', (c) => c.json({ id_own_project: c.get('id_own_project') }));
  return { app, query };
}

describe('requireOwnProject', () => {
  it('rejects a request with no x-own-project-id header', async () => {
    const { app, query } = buildApp();
    const res = await app.request('/');
    expect(res.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects a non-numeric x-own-project-id header', async () => {
    const res = await buildApp().app.request('/', { headers: { 'x-own-project-id': 'abc' } });
    expect(res.status).toBe(400);
  });

  it('rejects a zero or negative x-own-project-id header', async () => {
    const res = await buildApp().app.request('/', { headers: { 'x-own-project-id': '0' } });
    expect(res.status).toBe(400);
  });

  it('rejects an id beyond the safe integer range', async () => {
    const res = await buildApp().app.request('/', { headers: { 'x-own-project-id': '99999999999999999999' } });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the user is not the owner of the project', async () => {
    const { app, query } = buildApp([]);
    const res = await app.request('/', { headers: { 'x-own-project-id': '12' } });
    expect(res.status).toBe(404);
    expect(query).toHaveBeenCalledWith(PROJECT_ACCESS_SQL, [12, 7]);
  });

  it('lets the owner through and sets id_own_project', async () => {
    const { app, query } = buildApp();
    const res = await app.request('/', { headers: { 'x-own-project-id': '12' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_own_project: 12 });
    expect(query).toHaveBeenCalledWith(PROJECT_ACCESS_SQL, [12, 7]);
  });
});
