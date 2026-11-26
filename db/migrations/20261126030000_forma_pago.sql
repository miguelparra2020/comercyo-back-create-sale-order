-- Contado o crédito (2026-11-25). Se elige al tomar el pedido de venta y la
-- factura lo hereda: Cartera solo muestra las facturas de pedidos a crédito.
-- plazo_dias (solo crédito) propone la fecha de vencimiento al facturar.
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS forma_pago TEXT NOT NULL DEFAULT 'contado';
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS plazo_dias INTEGER;

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_forma_pago_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_forma_pago_check CHECK (
  forma_pago IN ('contado', 'credito')
  AND (plazo_dias IS NULL OR plazo_dias BETWEEN 1 AND 365)
  AND (forma_pago = 'credito' OR plazo_dias IS NULL)
);

-- Lo que ya existe: si su factura vigente aún tiene saldo (abonos y reintegros
-- de devoluciones, como en Pedidos de venta), es a crédito con el plazo que dio
-- la factura; lo demás queda de contado.
UPDATE sales_orders so
   SET forma_pago = 'credito',
       plazo_dias = CASE WHEN si.fecha_vencimiento > si.fecha_emision
                         THEN least(si.fecha_vencimiento - si.fecha_emision, 365) END
  FROM sales_invoices si
 WHERE si.id_sales_order = so.id_sales_order
   AND si.anulada_en IS NULL
   AND si.deleted_at IS NULL
   AND so.forma_pago = 'contado'
   AND si.total - si.abonado
       - (SELECT coalesce(sum(d.monto_reintegro), 0) FROM sales_returns d
           WHERE d.id_sales_invoice = si.id_sales_invoice AND d.resolucion = 'Reintegro') > 0;
