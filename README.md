# comercyo-back-create-sale-order

Backend del módulo **Pedidos de venta** de Comercyo (Hono + `@hono/zod-openapi` + `pg`, desplegado en Vercel).

- Endpoints, ejemplos y tabla de códigos `PV_*` → HTTP: [docs/sales-orders-api.md](docs/sales-orders-api.md)
- Swagger UI: `/api/v1/doc`
- Producción: `https://comercyo-back-create-sale-order.vercel.app/api/v1`

## Desarrollo

```bash
cp .env.example .env   # completar JWT_SECRET, DATABASE_PASSWORD, DATABASE_HOST
npm install
npm run dev            # http://localhost:3007/api/v1/doc
npm run type-check
npm test               # unitarios
npm run test:db        # integración contra la BD real (todo se deshace con ROLLBACK)
```

## Estructura

```
src/
  routes/sales-orders.routes.ts          rutas OpenAPI + controladores
  services/sales-orders.service.ts       SQL, transacciones y serialización
  validation/sales-orders.validation.ts  esquemas zod (mensajes en español, alineados con el frontend)
  lib/pv-errors.ts                       mapa PV_* / SQLSTATE -> HTTP
  lib/errors.ts                          forma común de los errores y códigos generales
  lib/transaction.ts                     BEGIN/COMMIT/ROLLBACK sobre pg
```

La base de datos (`supabase-tiendas`, migración `20261015031310_create_sales_orders`)
genera el número, calcula totales, copia los snapshots y valida la máquina de estados.
La API valida la entrada, ejecuta las operaciones de varios pasos en una transacción
y traduce los errores.
