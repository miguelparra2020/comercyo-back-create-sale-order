-- Aviso al asignar un despacho (2026-11-26): quien queda para empacar o para
-- entregar un pedido recibe una notificación (campana y push) con enlace a
-- Despachos. No se avisa a quien se asigna a sí mismo.
CREATE OR REPLACE FUNCTION sales_order_avisar_despacho() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_url text := '/saas/project/' || NEW.id_own_project || '/dispatches';
BEGIN
  IF NEW.empaca_id_user IS NOT NULL AND NEW.empaca_id_user IS DISTINCT FROM OLD.empaca_id_user
     AND NEW.empaca_id_user IS DISTINCT FROM NEW.updated_by_user_id THEN
    PERFORM notif_crear(NEW.empaca_id_user, NEW.id_own_project, 'despacho_empacar',
      'Pedido para empacar: ' || NEW.numero,
      coalesce(NEW.cliente_nombre, '') || coalesce(' · entrega ' || to_char(NEW.fecha_entrega, 'DD/MM'), ''),
      v_url, NULL);
  END IF;
  IF NEW.entrega_id_user IS NOT NULL AND NEW.entrega_id_user IS DISTINCT FROM OLD.entrega_id_user
     AND NEW.entrega_id_user IS DISTINCT FROM NEW.updated_by_user_id THEN
    PERFORM notif_crear(NEW.entrega_id_user, NEW.id_own_project, 'despacho_entregar',
      'Pedido para entregar: ' || NEW.numero,
      coalesce(NEW.cliente_nombre, '') || coalesce(' · entrega ' || to_char(NEW.fecha_entrega, 'DD/MM'), ''),
      v_url, NULL);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sales_order_avisar_despacho ON sales_orders;
CREATE TRIGGER trg_sales_order_avisar_despacho
  AFTER UPDATE OF empaca_id_user, entrega_id_user ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION sales_order_avisar_despacho();
