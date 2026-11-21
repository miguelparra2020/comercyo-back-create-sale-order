-- Medio de pago en los pedidos manuales (2026-11-21).
-- Además de la condición (contra entrega / anticipado), la tienda escoge con
-- cuál de sus medios de pago (store_payment_methods) paga el cliente. Se copia
-- el tipo y el nombre, como en marketplace_orders y dropi_orders, para que el
-- pedido lo siga mostrando aunque la tienda cambie o quite el medio.
-- Se puede correr dos veces.
ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS medio_pago_tipo text,
  ADD COLUMN IF NOT EXISTS medio_pago_nombre text CONSTRAINT sales_orders_medio_pago_check CHECK (medio_pago_nombre IS NULL OR char_length(medio_pago_nombre) <= 80);
