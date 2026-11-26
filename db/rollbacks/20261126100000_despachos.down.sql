UPDATE proyecto_roles SET permisos = permisos - 'despachos', updated_at = now() WHERE id_own_project IS NULL;

CREATE OR REPLACE FUNCTION sales_order_registrar_evento() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.estado IS DISTINCT FROM NEW.estado THEN
    INSERT INTO sales_order_events (id_sales_order, estado) VALUES (NEW.id_sales_order, NEW.estado::text);
  END IF;
  RETURN NEW;
END $$;

DROP INDEX IF EXISTS sales_orders_entrega_idx;
DROP INDEX IF EXISTS sales_orders_empaca_idx;
ALTER TABLE sales_orders DROP COLUMN IF EXISTS entrega_id_user, DROP COLUMN IF EXISTS empaca_id_user;
ALTER TABLE sales_order_events DROP COLUMN IF EXISTS id_user;
