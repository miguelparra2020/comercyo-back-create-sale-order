-- Estado "Listo para despachar" (2026-11-21), parte 2. Queda entre
-- En preparación y En camino: el pedido ya está empacado y espera ruta.
--   Pendiente            -> En preparación | Cancelado
--   En preparación       -> Listo para despachar | En camino | Cancelado
--   Listo para despachar -> En camino | Entregado (el cliente lo recoge) | Cancelado
--   En camino            -> Entregado | Cancelado
-- Como En camino, ya no se edita (solo Pendiente y En preparación).

CREATE OR REPLACE FUNCTION public.sales_orders_check_estado()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
begin
  if tg_op = 'INSERT' then
    if new.estado <> 'Pendiente' then
      perform public.so_raise('PV_ESTADO_INICIAL_INVALIDO',
        format('Un pedido de venta debe crearse en estado Pendiente (se recibió %s).', new.estado));
    end if;
    new.entregado_en := null;
    return new;
  end if;

  if new.estado is distinct from old.estado then
    if old.deleted_at is not null then
      perform public.so_raise('PV_PEDIDO_ELIMINADO',
        format('El pedido %s está eliminado y no puede cambiar de estado.', old.numero));
    end if;

    if not (
         (old.estado = 'Pendiente'            and new.estado in ('En preparación', 'Cancelado'))
      or (old.estado = 'En preparación'       and new.estado in ('Listo para despachar', 'En camino', 'Cancelado'))
      or (old.estado = 'Listo para despachar' and new.estado in ('En camino', 'Entregado', 'Cancelado'))
      or (old.estado = 'En camino'            and new.estado in ('Entregado', 'Cancelado'))
    ) then
      perform public.so_raise('PV_TRANSICION_INVALIDA',
        format('El pedido %s no puede pasar de %s a %s.', old.numero, old.estado, new.estado));
    end if;

    if new.estado = 'Entregado' then
      new.entregado_en := coalesce(new.entregado_en, now());
    end if;
  elsif new.entregado_en is distinct from old.entregado_en then
    -- entregado_en solo se asigna en la transición a 'Entregado'.
    perform public.so_raise('PV_CAMPO_INMUTABLE',
      format('La fecha de entrega real del pedido %s no se puede modificar.', old.numero));
  end if;

  return new;
end;
$function$;

CREATE OR REPLACE VIEW v_sales_orders AS
 SELECT id_sales_order, id_own_project, numero, id_customer, cliente_nombre, fecha, fecha_entrega, notas, estado, total,
    entregado_en, created_at, updated_at, deleted_at, created_by_user_id, updated_by_user_id, deleted_by_user_id,
    descuento_tipo, descuento_valor, impuesto_tipo, impuesto_valor, costo_envio, subtotal, descuento_monto, impuesto_monto,
    (estado = ANY (ARRAY['Pendiente'::sales_order_status, 'En preparación'::sales_order_status,
                         'Listo para despachar'::sales_order_status, 'En camino'::sales_order_status]))
      AND fecha_entrega < fecha_bogota() AS atrasado
   FROM sales_orders so
  WHERE deleted_at IS NULL;

-- Aviso al cliente del marketplace: "listo para recoger" si lo recoge en la tienda.
CREATE OR REPLACE FUNCTION public.notif_so_estado()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  mo record;
  v_tienda TEXT;
  v_estado TEXT := NEW.estado::text;
BEGIN
  IF NEW.estado::text IS NOT DISTINCT FROM OLD.estado::text THEN
    RETURN NULL;
  END IF;
  SELECT id_user, nombre, entrega INTO mo FROM marketplace_orders WHERE id_sales_order = NEW.id_sales_order;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF v_estado = 'Cancelado' AND NEW.updated_by_user_id IS NOT DISTINCT FROM mo.id_user THEN
    PERFORM notif_crear(
      notif_dueno(NEW.id_own_project), NEW.id_own_project, 'pedido_cancelado_cliente',
      'Pedido ' || NEW.numero || ' cancelado por el cliente',
      coalesce(mo.nombre, 'El cliente') || ' canceló su pedido.',
      '/saas/project/' || NEW.id_own_project || '/orders', NULL);
    RETURN NULL;
  END IF;
  v_tienda := notif_nombre_tienda(NEW.id_own_project);
  PERFORM notif_crear(
    mo.id_user, NULL, 'pedido_estado',
    CASE v_estado
      WHEN 'En preparación' THEN 'Tu pedido ' || NEW.numero || ' está en preparación'
      WHEN 'Listo para despachar' THEN
        CASE WHEN mo.entrega = 'recoger' THEN 'Tu pedido ' || NEW.numero || ' está listo para recoger'
             ELSE 'Tu pedido ' || NEW.numero || ' está listo y pronto sale' END
      WHEN 'En camino' THEN 'Tu pedido ' || NEW.numero || ' va en camino'
      WHEN 'Entregado' THEN 'Tu pedido ' || NEW.numero || ' fue entregado'
      WHEN 'Cancelado' THEN 'Tu pedido ' || NEW.numero || ' fue cancelado'
      ELSE 'Tu pedido ' || NEW.numero || ': ' || v_estado
    END,
    CASE v_estado
      WHEN 'Cancelado' THEN v_tienda || ' canceló el pedido. Escríbele si tienes dudas.'
      WHEN 'Entregado' THEN '¡Gracias por comprar en ' || v_tienda || '!'
      WHEN 'Listo para despachar' THEN
        CASE WHEN mo.entrega = 'recoger' THEN 'Ya puedes pasar por él a ' || v_tienda || '.'
             ELSE v_tienda || ' ya empacó tu pedido.' END
      ELSE v_tienda || ' actualizó tu pedido.'
    END,
    '/orders', NULL);
  RETURN NULL;
END;
$function$;

INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20261121030000', 'listo_para_despachar_1_estado'), ('20261121030100', 'listo_para_despachar_2_reglas') ON CONFLICT (version) DO NOTHING;

SELECT (SELECT count(*) FROM pg_enum WHERE enumlabel = 'Listo para despachar') AS estado, (SELECT count(*) FROM pg_proc WHERE proname = 'sales_orders_check_estado' AND prosrc LIKE '%Listo para despachar%') AS reglas, (SELECT count(*) FROM pg_views WHERE viewname = 'v_sales_orders' AND definition LIKE '%Listo para despachar%') AS vista;
