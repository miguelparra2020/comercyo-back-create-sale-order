-- Producción 2026-11-21: pedido manual con medio de pago y dropshipper.
-- Junta create-sale-order 20261121060000_medio_pago_pedido_manual y dropi 20261121060000_dropi_pedido_manual.
-- Se puede correr dos veces. Debe mostrar: medio = 2, origen_manual = 1.

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS medio_pago_tipo text,
  ADD COLUMN IF NOT EXISTS medio_pago_nombre text CONSTRAINT sales_orders_medio_pago_check CHECK (medio_pago_nombre IS NULL OR char_length(medio_pago_nombre) <= 80);

ALTER TABLE dropi_orders DROP CONSTRAINT IF EXISTS dropi_orders_origen_check;
ALTER TABLE dropi_orders ADD CONSTRAINT dropi_orders_origen_check CHECK (origen IN ('panel', 'tienda', 'carrito', 'manual'));

CREATE OR REPLACE FUNCTION dropi_orders_before_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_estado text;
  v_project bigint;
BEGIN
  SELECT estado INTO v_estado FROM dropshippers WHERE id_dropshipper = NEW.id_dropshipper FOR SHARE;
  IF v_estado IS DISTINCT FROM 'aprobado' THEN
    PERFORM dr_raise('DR_DROPSHIPPER_NO_APROBADO', 'La cuenta del dropshipper no está aprobada');
  END IF;
  SELECT id_own_project INTO v_project FROM sales_orders WHERE id_sales_order = NEW.id_sales_order;
  IF v_project IS DISTINCT FROM dropi_proveedor() THEN
    PERFORM dr_raise('DR_PEDIDO_NO_ES_DEL_PROVEEDOR', 'El pedido no es del proyecto proveedor de Dropi');
  END IF;
  -- Desde el carrito y en los pedidos manuales manda la tienda.
  IF NEW.origen NOT IN ('carrito', 'manual') AND NOT EXISTS (SELECT 1 FROM dropi_cities WHERE id_city = NEW.id_city AND activo) THEN
    PERFORM dr_raise('DR_CIUDAD_SIN_ENTREGA', 'Todavía no hacemos entregas en esa ciudad');
  END IF;
  NEW.created_at := now();
  RETURN NEW;
END $$;

SELECT (SELECT count(*) FROM information_schema.columns WHERE table_name = 'sales_orders' AND column_name IN ('medio_pago_tipo', 'medio_pago_nombre')) AS medio,
       (SELECT count(*) FROM pg_constraint WHERE conname = 'dropi_orders_origen_check' AND pg_get_constraintdef(oid) LIKE '%manual%') AS origen_manual;
