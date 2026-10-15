import { Pool } from 'pg';

export const requiredEnv = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
};

// Cache de pools por ref (multi-tenant)
const dbPoolByRef = new Map<string, Pool>();

// Construye:
// postgresql://postgres.<ref>:<password>@aws-xxx.pooler.supabase.com:6543/postgres
const buildDatabaseUrlFromRef = (ref: string) => {
  const base = requiredEnv('DATABASE_BASE');       // postgresql://postgres.
  const password = requiredEnv('DATABASE_PASSWORD'); // ********
  const host = requiredEnv('DATABASE_HOST');       // @aws-xxx.pooler.supabase.com:6543/postgres

  return `${base}${ref}:${password}${host}`;
};

export const getDb = (ref: string) => {
  const normalized = ref.trim();

  if (!normalized) {
    throw new Error('Database ref is required');
  }

  const cached = dbPoolByRef.get(normalized);
  if (cached) {
    return cached;
  }

  const connectionString = buildDatabaseUrlFromRef(normalized);

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  dbPoolByRef.set(normalized, pool);
  return pool;
};

export const getUsersDb = () => getDb(requiredEnv('TIENDAS_DB_REF'));
