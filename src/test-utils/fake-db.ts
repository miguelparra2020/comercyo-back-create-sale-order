import { vi } from 'vitest';

type Result = { rows?: any[]; rowCount?: number };
type Responder = Result | ((params: unknown[]) => Result | Promise<Result>);

export type Call = { via: 'pool' | 'client'; sql: string; params: unknown[] };

const TX_STATEMENT = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i;

// In-memory stand-in for a pg Pool. Each statement is answered by the last
// registered handler whose pattern matches it (so tests can override a
// default); an unmatched statement fails the test loudly. BEGIN/COMMIT/
// ROLLBACK succeed unless a handler matches them (e.g. /^COMMIT$/ to emulate
// a deferred constraint failing) and are always recorded, which is what the
// atomicity tests assert on.
export function createFakeDb() {
  const calls: Call[] = [];
  const handlers: { pattern: RegExp; respond: Responder }[] = [];
  const release = vi.fn();

  const run = async (via: Call['via'], sql: string, params: unknown[] = []) => {
    calls.push({ via, sql, params });
    const handler = [...handlers].reverse().find((h) => h.pattern.test(sql));
    if (!handler && TX_STATEMENT.test(sql)) return { rows: [], rowCount: null };
    if (!handler) throw new Error(`fake-db: unexpected SQL:\n${sql}`);

    const out = typeof handler.respond === 'function' ? await handler.respond(params) : handler.respond;
    const rows = out.rows ?? [];
    return { rows, rowCount: out.rowCount ?? rows.length };
  };

  const pool = {
    query: vi.fn((sql: string, params?: unknown[]) => run('pool', sql, params)),
    connect: vi.fn(async () => ({
      query: (sql: string, params?: unknown[]) => run('client', sql, params),
      release,
    })),
  };

  return {
    pool,
    calls,
    release,
    on(pattern: RegExp, respond: Responder) {
      handlers.push({ pattern, respond });
      return this;
    },
    // First keyword(s) of each statement, e.g. ['BEGIN', 'INSERT sales_orders', ...].
    statements() {
      return calls.map(({ sql }) => describeSql(sql));
    },
    find(pattern: RegExp) {
      return calls.find((c) => pattern.test(c.sql));
    },
    reset() {
      calls.length = 0;
      handlers.length = 0;
      release.mockReset();
      pool.query.mockClear();
      pool.connect.mockClear();
    },
  };
}

export type FakeDb = ReturnType<typeof createFakeDb>;

const describeSql = (sql: string) => {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (TX_STATEMENT.test(s)) return s.toUpperCase();
  let m: RegExpExecArray | null;
  if ((m = /^INSERT INTO (\w+)/i.exec(s))) return `INSERT ${m[1]}`;
  if ((m = /^UPDATE (\w+) (?:so )?SET (\w+)/i.exec(s))) return `UPDATE ${m[1]}.${m[2]}`;
  if ((m = /^DELETE FROM (\w+)/i.exec(s))) return `DELETE ${m[1]}`;
  if (/^SELECT count\(\*\)/i.test(s)) return 'COUNT v_sales_orders';
  if ((m = /FROM (\w+)/i.exec(s))) return `SELECT ${m[1]}`;
  return s.slice(0, 40);
};

// An error shaped like the one pg throws for so_raise().
export const pvError = (code: string, text = 'mensaje de prueba') =>
  Object.assign(new Error(`${code}: ${text}`), { code: 'P0001', detail: code });

export const pgError = (code: string, constraint?: string) =>
  Object.assign(new Error(`pg error ${code} with internal SQL details`), { code, constraint });
