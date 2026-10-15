import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireOwnProject, type OwnProjectVariables } from './require-own-project.middleware';

function buildApp() {
  const app = new Hono<{ Variables: OwnProjectVariables }>();
  app.use('*', requireOwnProject());
  app.get('/', (c) => c.json({ id_own_project: c.get('id_own_project') }));
  return app;
}

describe('requireOwnProject', () => {
  it('rejects a request with no x-own-project-id header', async () => {
    const res = await buildApp().request('/');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Bad Request',
      message: 'Selecciona un proyecto válido',
      code: 'INVALID_OWN_PROJECT',
    });
  });

  it('rejects a non-numeric x-own-project-id header', async () => {
    const res = await buildApp().request('/', { headers: { 'x-own-project-id': 'abc' } });
    expect(res.status).toBe(400);
  });

  it('rejects a zero or negative x-own-project-id header', async () => {
    const res = await buildApp().request('/', { headers: { 'x-own-project-id': '0' } });
    expect(res.status).toBe(400);
  });

  it('allows a valid numeric x-own-project-id through and sets id_own_project', async () => {
    const res = await buildApp().request('/', { headers: { 'x-own-project-id': '12' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id_own_project: 12 });
  });
});
