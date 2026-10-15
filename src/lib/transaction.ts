import type { Pool, PoolClient } from 'pg';

export type TransactionPool = Pick<Pool, 'connect'>;

// Runs fn inside BEGIN/COMMIT on a single pooled connection. Any error thrown
// by fn (a DB error or a domain error) rolls everything back and is rethrown,
// so multi-step writes are all-or-nothing.
export const withTransaction = async <T>(
  pool: TransactionPool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> => {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      // The connection is in an unknown state - destroy it instead of
      // returning it to the pool.
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
};
