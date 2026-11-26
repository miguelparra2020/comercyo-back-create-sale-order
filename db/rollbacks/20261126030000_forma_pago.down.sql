ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_forma_pago_check;
ALTER TABLE sales_orders DROP COLUMN IF EXISTS plazo_dias;
ALTER TABLE sales_orders DROP COLUMN IF EXISTS forma_pago;
