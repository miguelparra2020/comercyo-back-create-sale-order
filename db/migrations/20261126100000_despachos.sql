-- Despachos (2026-11-26): quién empaca y quién entrega cada pedido de venta.
--
-- 1. sales_order_events guarda quién hizo cada cambio de estado (id_user), así
--    se sabe quién lo empacó, quién lo sacó y quién lo entregó, y a qué hora.
-- 2. sales_orders.empaca_id_user / entrega_id_user: a quién se le asignó.
--    Cada persona del equipo ve en Despachos lo suyo y lo marca desde su celular.
-- 3. Los roles Bodega y Domiciliario reciben el módulo "despachos".

ALTER TABLE sales_order_events ADD COLUMN IF NOT EXISTS id_user bigint;

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS empaca_id_user bigint,
  ADD COLUMN IF NOT EXISTS entrega_id_user bigint;

CREATE INDEX IF NOT EXISTS sales_orders_empaca_idx ON sales_orders (id_own_project, empaca_id_user) WHERE empaca_id_user IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_orders_entrega_idx ON sales_orders (id_own_project, entrega_id_user) WHERE entrega_id_user IS NOT NULL;

CREATE OR REPLACE FUNCTION sales_order_registrar_evento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO sales_order_events (id_sales_order, estado, id_user) VALUES (NEW.id_sales_order, NEW.estado::text, NEW.created_by_user_id);
  ELSIF OLD.estado IS DISTINCT FROM NEW.estado THEN
    INSERT INTO sales_order_events (id_sales_order, estado, id_user) VALUES (NEW.id_sales_order, NEW.estado::text, NEW.updated_by_user_id);
  END IF;
  RETURN NEW;
END $$;

UPDATE proyecto_roles
   SET permisos = permisos || '{"despachos":["ver"]}'::jsonb, updated_at = now()
 WHERE id_own_project IS NULL AND clave IN ('bodega', 'domiciliario') AND NOT permisos ? 'despachos';
UPDATE proyecto_roles
   SET permisos = permisos || '{"despachos":["ver","crear","editar","borrar"]}'::jsonb, updated_at = now()
 WHERE id_own_project IS NULL AND clave = 'administrador' AND NOT permisos ? 'despachos';
UPDATE proyecto_roles
   SET permisos = permisos || '{"despachos":["ver"]}'::jsonb, updated_at = now()
 WHERE id_own_project IS NULL AND clave = 'solo_lectura' AND NOT permisos ? 'despachos';
