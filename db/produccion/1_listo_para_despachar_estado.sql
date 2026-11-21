-- Estado "Listo para despachar" (2026-11-21), parte 1: el valor nuevo del enum.
-- Va solo porque Postgres no deja usar un valor recién agregado en la misma
-- transacción (la parte 2 lo usa en la vista y los triggers).
ALTER TYPE sales_order_status ADD VALUE IF NOT EXISTS 'Listo para despachar' BEFORE 'En camino';
