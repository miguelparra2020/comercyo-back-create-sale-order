# Scripts para producción (Supabase)

Se corren en orden, cada uno por separado (el 1 tiene que quedar guardado antes del 2).

| # | Archivo | Debe mostrar |
|---|---|---|
| 1 | `1_listo_para_despachar_estado.sql` | sin error |
| 2 | `2_listo_para_despachar_reglas.sql` | `estado = 1`, `reglas = 1`, `vista = 1` |
| 3 | `3_pedido_manual_medio_y_dropshipper.sql` | `medio = 2`, `origen_manual = 1` |
