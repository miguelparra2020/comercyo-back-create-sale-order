import { describe, it, expect, beforeEach } from 'vitest';

describe('getUsersDb', () => {
  beforeEach(() => {
    process.env.DATABASE_BASE = 'postgresql://postgres.';
    process.env.DATABASE_PASSWORD = 'secret';
    process.env.DATABASE_HOST = '@aws-0-test.pooler.supabase.com:6543/postgres';
  });

  it('throws when TIENDAS_DB_REF is not set', async () => {
    delete process.env.TIENDAS_DB_REF;
    const { getUsersDb } = await import('./db');
    expect(() => getUsersDb()).toThrow('Missing required environment variable: TIENDAS_DB_REF');
  });

  it('returns the same pool instance on repeated calls', async () => {
    process.env.TIENDAS_DB_REF = 'test-ref';
    const { getUsersDb } = await import('./db');
    const first = getUsersDb();
    const second = getUsersDb();
    expect(first).toBe(second);
  });
});
