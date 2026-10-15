import { describe, it, expect, vi } from 'vitest';
import { withTransaction } from './transaction';

function fakePool(failOn?: string) {
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn(async (sql: string) => {
      statements.push(sql);
      if (sql === failOn) throw new Error(`${sql} failed`);
      return { rows: [], rowCount: 0 };
    }),
    release,
  };
  return { pool: { connect: vi.fn(async () => client) } as any, statements, release };
}

describe('withTransaction', () => {
  it('hace BEGIN/COMMIT y devuelve el resultado', async () => {
    const { pool, statements, release } = fakePool();
    const result = await withTransaction(pool, async (client) => {
      await client.query('INSERT 1');
      return 'ok';
    });

    expect(result).toBe('ok');
    expect(statements).toEqual(['BEGIN', 'INSERT 1', 'COMMIT']);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('hace ROLLBACK y relanza el error si un paso falla', async () => {
    const { pool, statements, release } = fakePool('INSERT 2');
    await expect(
      withTransaction(pool, async (client) => {
        await client.query('INSERT 1');
        await client.query('INSERT 2');
        await client.query('INSERT 3');
      })
    ).rejects.toThrow('INSERT 2 failed');

    expect(statements).toEqual(['BEGIN', 'INSERT 1', 'INSERT 2', 'ROLLBACK']);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('destruye la conexión si el ROLLBACK también falla', async () => {
    const { pool, release } = fakePool('ROLLBACK');
    await expect(
      withTransaction(pool, async () => {
        throw new Error('paso');
      })
    ).rejects.toThrow('paso');

    expect(release).toHaveBeenCalledWith(expect.any(Error));
  });
});
