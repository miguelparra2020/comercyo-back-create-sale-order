# API de Pedidos de venta

Base: `/api/v1` · Swagger UI: `/api/v1/doc` · OpenAPI: `/api/v1/openapi.json`

| Entorno    | URL                                                    |
| ---------- | ------------------------------------------------------ |
| Local      | `http://localhost:3007/api/v1`                         |
| Producción | `https://comercyo-back-create-sale-order.vercel.app/api/v1` |

Base de datos: `supabase-tiendas`, migración `20261015031310_create_sales_orders`
(tablas `sales_orders`, `sales_order_lines`, `sales_order_counters`, vista `v_sales_orders`).
Las tablas tienen RLS sin políticas: solo este backend las lee y escribe, por conexión directa.

## Autenticación y alcance

Todas las rutas exigen:

| Header             | Valor                                                       |
| ------------------ | ----------------------------------------------------------- |
| `Authorization`    | `Bearer <access token>` emitido por `comercyo-back-users`   |
| `x-own-project-id` | id del proyecto (entero positivo)                           |

Todo se filtra por el `id_own_project` del header. Un pedido de otro proyecto o borrado responde **404**.
Sin token o con token inválido → 401 `UNAUTHORIZED`. Sin `x-own-project-id` o inválido → 400 `INVALID_OWN_PROJECT`.
Límite: 100 peticiones/minuto por IP → 429 `RATE_LIMITED`.

## Qué hace la base de datos (y la API no envía)

`numero` (PED-0001, consecutivo por proyecto y seguro ante concurrencia), `total`, `subtotal`,
`cliente_nombre` (copia de `customers.nombre`), `producto_nombre` y `referencia` (copia de
`productos.nombre` y `productos.sku`), `precio_unitario` por defecto (`precio_venta_linea` del
producto), `entregado_en`, la máquina de estados, el bloqueo de edición y de borrado, la
validación de cliente y productos (mismo proyecto, cliente activo, producto no eliminado),
el máximo de 50 líneas y el producto no repetido.
La API ignora esos campos si vienen en el body. El estado solo cambia con
`/prepare`, `/ship`, `/deliver` y `/cancel`. **El stock no se descuenta al entregar.**

## Forma de un pedido

```json
{
  "id_sales_order": "123",
  "id_own_project": 1,
  "numero": "PED-0001",
  "id_customer": "5",
  "cliente_nombre": "Laura Gómez",
  "fecha": "2026-10-15",
  "fecha_entrega": "2026-10-18",
  "notas": "",
  "estado": "Pendiente",
  "total": "51000.00",
  "atrasado": false,
  "entregado_en": null,
  "created_at": "2026-10-15T15:00:00.000Z",
  "updated_at": "2026-10-15T15:00:00.000Z",
  "lineas": [
    {
      "id_sales_order_line": "456",
      "id_product": "789",
      "producto_nombre": "Resma carta",
      "referencia": "RES-CARTA",
      "cantidad": 2,
      "precio_unitario": "18000.00",
      "subtotal": "36000.00"
    }
  ]
}
```

- bigint (`id_sales_order`, `id_sales_order_line`, `id_product`, **`id_customer`**) → string.
  `id_customer` va como string igual que en `comercyo-back-create-customers`.
- `id_own_project` → number (igual que en órdenes de compra).
- numeric (`total`, `precio_unitario`, `subtotal`) → string con 2 decimales.
- `fecha`, `fecha_entrega` → `YYYY-MM-DD` sin hora ni zona (no se desplazan un día).
- `entregado_en`, `created_at`, `updated_at` → ISO 8601 en UTC o `null`.
  `updated_at` ya viene con valor en un pedido recién creado: al insertar las líneas la BD
  recalcula el total de la cabecera y eso cuenta como actualización.
- `lineas` en el orden en que se enviaron.
- `cantidad` → number.

### Sobre `atrasado`

`true` si el pedido está en Pendiente, En preparación o En camino y `fecha_entrega < current_date`.
Lo calcula la vista `v_sales_orders` con `current_date` de Postgres, que va en **UTC**:
en Colombia (UTC−5), desde las 7 p. m. un pedido que se entrega hoy ya sale atrasado.
Es solo informativo: **la API no lo usa en ninguna regla de negocio** y el frontend calcula
el suyo con la fecha local (`estaAtrasado` en `pedidoVenta.ts`). El filtro `?atrasado=` usa
el valor de la vista, con el mismo desfase.

## Estados

```
Pendiente ──prepare──▶ En preparación ──ship──▶ En camino ──deliver──▶ Entregado
    │                        │                      │
    └────────cancel──────────┴────────cancel────────┴──▶ Cancelado
```

Entregado y Cancelado son finales. Editar (PUT, cabecera y líneas) solo en Pendiente o
En preparación, y no cambia el estado. Borrar (DELETE) solo en Pendiente.

| Frontend (`TransicionPedido`) | Ruta                          |
| ----------------------------- | ----------------------------- |
| `preparar`                    | `POST /sales-orders/:id/prepare` |
| `despachar`                   | `POST /sales-orders/:id/ship`    |
| `entregar`                    | `POST /sales-orders/:id/deliver` |
| `cancelar`                    | `POST /sales-orders/:id/cancel`  |

---

## GET /sales-orders

Lista paginada desde `v_sales_orders` (sin borrados), cada pedido con sus líneas.
Orden: `fecha DESC`, `numero DESC` (numérico: PED-10000 va antes que PED-9999).
Las líneas de toda la página se traen en **una sola** consulta adicional
(`WHERE id_sales_order = ANY($1)`) y se agrupan en memoria.

| Query          | Tipo                                                             | Default |
| -------------- | ---------------------------------------------------------------- | ------- |
| `search`       | texto en `numero` y `cliente_nombre`, sin distinguir mayúsculas; `%`, `_` y `\` se buscan literalmente | — |
| `estado`       | `Pendiente` \| `En preparación` \| `En camino` \| `Entregado` \| `Cancelado` | — |
| `id_customer`  | entero positivo                                                  | —       |
| `atrasado`     | `true` \| `false`                                                | —       |
| `fecha_desde`  | `YYYY-MM-DD` (incluida)                                          | —       |
| `fecha_hasta`  | `YYYY-MM-DD` (incluida)                                          | —       |
| `page`         | entero ≥ 1                                                       | 1       |
| `limit`        | entero 1–100                                                     | 10      |

```bash
curl -s "http://localhost:3007/api/v1/sales-orders?estado=Pendiente&page=1&limit=100" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-own-project-id: 1"
```

```json
{
  "success": true,
  "data": [ { "id_sales_order": "123", "numero": "PED-0001", "estado": "Pendiente", "lineas": [ ... ], ... } ],
  "pagination": { "page": 1, "limit": 100, "total": 1, "totalPages": 1 }
}
```

## GET /sales-orders/:id

```bash
curl -s http://localhost:3007/api/v1/sales-orders/123 \
  -H "Authorization: Bearer $TOKEN" -H "x-own-project-id: 1"
```

`200 { success: true, data: <pedido> }` · `404 PV_PEDIDO_NO_ENCONTRADO` si no existe, es de otro proyecto o está borrado.

## POST /sales-orders

```bash
curl -s -X POST http://localhost:3007/api/v1/sales-orders \
  -H "Authorization: Bearer $TOKEN" -H "x-own-project-id: 1" \
  -H "Content-Type: application/json" \
  -d '{
    "id_customer": "5",
    "fecha": "2026-10-15",
    "fecha_entrega": "2026-10-18",
    "notas": "Entregar en portería",
    "lineas": [
      { "id_product": 789, "cantidad": 2, "precio_unitario": 18000 },
      { "id_product": "790", "cantidad": 1 }
    ]
  }'
```

| Campo                       | Regla                                                        |
| --------------------------- | ------------------------------------------------------------ |
| `id_customer`               | obligatorio, entero positivo (número o string de dígitos)    |
| `fecha`                     | obligatoria, `YYYY-MM-DD` válida                             |
| `fecha_entrega`             | obligatoria, `YYYY-MM-DD` válida, no anterior a `fecha`      |
| `notas`                     | opcional, texto ≤ 500 (default `""`)                         |
| `lineas`                    | 1 a 50 líneas, sin `id_product` repetidos                    |
| `lineas[].id_product`       | obligatorio, entero positivo (número o string de dígitos)    |
| `lineas[].cantidad`         | obligatoria, entero ≥ 1                                      |
| `lineas[].precio_unitario`  | opcional, número ≥ 0 con máx. 2 decimales; si falta o es `null` se usa el `precio_venta_linea` del producto |

Se ejecuta en **una transacción**: INSERT cabecera (Pendiente, `RETURNING`) → INSERT líneas →
releer el pedido completo. Si algo falla no queda nada (ni se consume el número).
`201 { success: true, data: <pedido> }`.

## PUT /sales-orders/:id

Mismo body que POST. Reemplaza la cabecera y **todas** las líneas, en una transacción:
UPDATE cabecera → DELETE líneas → INSERT líneas → releer. Solo en Pendiente o En preparación
(si no → 409 `PV_PEDIDO_NO_EDITABLE`); el estado no cambia. Como las líneas se vuelven a
insertar, sus nombres, referencias y (si no se envía precio) precios se toman de nuevo del
producto, y sus `id_sales_order_line` cambian.

```bash
curl -s -X PUT http://localhost:3007/api/v1/sales-orders/123 \
  -H "Authorization: Bearer $TOKEN" -H "x-own-project-id: 1" \
  -H "Content-Type: application/json" \
  -d '{ "id_customer": 5, "fecha": "2026-10-15", "fecha_entrega": "2026-10-20", "lineas": [ { "id_product": 789, "cantidad": 3 } ] }'
```

`200 { success: true, data: <pedido> }`.

## POST /sales-orders/:id/prepare · /ship · /deliver · /cancel

Sin body. Devuelven `200 { success: true, data: <pedido completo con líneas> }`.

| Ruta       | Transición                                         |
| ---------- | -------------------------------------------------- |
| `/prepare` | Pendiente → En preparación                         |
| `/ship`    | En preparación → En camino                         |
| `/deliver` | En camino → Entregado (la BD asigna `entregado_en`) |
| `/cancel`  | Pendiente \| En preparación \| En camino → Cancelado |

```bash
curl -s -X POST http://localhost:3007/api/v1/sales-orders/123/prepare \
  -H "Authorization: Bearer $TOKEN" -H "x-own-project-id: 1"
```

Transición no permitida → 409:

```json
{
  "success": false,
  "error": "Conflict",
  "message": "El pedido PED-0001 no puede pasar de Pendiente a Entregado.",
  "code": "PV_TRANSICION_INVALIDA"
}
```

## DELETE /sales-orders/:id

Borrado **lógico** (`deleted_at = now()`, `deleted_by_user_id = usuario`). Solo en Pendiente
(si no → 409 `PV_BORRADO_NO_PERMITIDO`). Devuelve `200` con el pedido; desde entonces
no aparece en GET (404).

```bash
curl -s -X DELETE http://localhost:3007/api/v1/sales-orders/123 \
  -H "Authorization: Bearer $TOKEN" -H "x-own-project-id: 1"
```

## Auditoría

Siempre con el `id_user` del token: `created_by_user_id` en POST, `updated_by_user_id` en PUT y
en las acciones de estado, `deleted_by_user_id` en DELETE.

---

## Errores

```json
{ "success": false, "error": "Bad Request", "message": "<texto en español>", "code": "PV_<CODIGO>" }
```

Nunca se devuelve SQL, nombres de tablas ni stack. Un error no previsto → `500` con
`{ "error": "Internal Server Error", "message": "Ocurrió un error inesperado. Intente de nuevo más tarde.", "code": "INTERNAL_ERROR" }`
(el detalle va solo al log del servidor).

### Códigos de la base de datos (`P0001`, mensaje `PV_<CODIGO>: texto`)

El `message` de la respuesta es el texto de la BD sin el prefijo.

| Código                       | HTTP | Cuándo                                                     |
| ---------------------------- | ---- | ---------------------------------------------------------- |
| `PV_CLIENTE_NO_ENCONTRADO`   | 400  | el cliente no existe                                       |
| `PV_CLIENTE_OTRO_PROYECTO`   | 400  | el cliente es de otro proyecto                             |
| `PV_CLIENTE_INACTIVO`        | 400  | cliente inactivo o eliminado                               |
| `PV_PRODUCTO_NO_ENCONTRADO`  | 400  | un producto no existe                                      |
| `PV_PRODUCTO_OTRO_PROYECTO`  | 400  | un producto es de otro proyecto                            |
| `PV_PRODUCTO_ELIMINADO`      | 400  | un producto está eliminado                                 |
| `PV_PRODUCTO_REPETIDO`       | 400  | producto repetido en el pedido                             |
| `PV_MAX_LINEAS`              | 400  | más de 50 líneas                                           |
| `PV_ESTADO_INICIAL_INVALIDO` | 409  | el pedido no se crea en Pendiente                          |
| `PV_TRANSICION_INVALIDA`     | 409  | cambio de estado no permitido                              |
| `PV_PEDIDO_NO_EDITABLE`      | 409  | editar cabecera o líneas en En camino, Entregado o Cancelado |
| `PV_PEDIDO_ELIMINADO`        | 409  | modificar un pedido borrado                                |
| `PV_BORRADO_NO_PERMITIDO`    | 409  | borrar fuera de Pendiente                                  |
| `PV_CAMPO_INMUTABLE`         | 409  | cambiar número, proyecto o `entregado_en`                  |
| `PV_PEDIDO_NO_ENCONTRADO`    | 404  | el pedido no existe                                        |

### Códigos de la API

| Código                    | HTTP | Cuándo                                                     |
| ------------------------- | ---- | ---------------------------------------------------------- |
| `PV_VALIDACION`           | 400  | body, query o `:id` inválidos (mensaje del primer campo inválido) |
| `PV_PEDIDO_NO_ENCONTRADO` | 404  | no existe, es de otro proyecto o está borrado ("El pedido no existe") |
| `INVALID_OWN_PROJECT`     | 400  | falta `x-own-project-id` o no es válido ("Selecciona un proyecto válido") |
| `UNAUTHORIZED`            | 401  | sin token, o token inválido o vencido                      |
| `RATE_LIMITED`            | 429  | más de 100 peticiones/minuto desde la misma IP             |
| `INTERNAL_ERROR`          | 500  | error no previsto                                          |

Mensajes de validación (iguales a los de `src/saas/utils/pedidoVenta.ts` del frontend).
Los errores dentro de una línea llevan el prefijo `Línea N: `.

| Caso                                   | Mensaje                                                  |
| -------------------------------------- | -------------------------------------------------------- |
| falta `id_customer`                    | Selecciona un cliente                                    |
| falta `fecha`                          | Selecciona la fecha                                      |
| falta `fecha_entrega`                  | Selecciona la fecha de entrega                           |
| `fecha_entrega` < `fecha`              | La entrega no puede ser antes de la fecha del pedido     |
| `lineas` vacía o ausente               | Agrega al menos un producto                              |
| más de 50 líneas                       | Un pedido puede tener máximo 50 productos                |
| `notas` > 500                          | Las notas pueden tener máximo 500 caracteres             |
| falta `id_product`                     | Línea N: Selecciona un producto                          |
| producto repetido                      | Línea N: Este producto ya está en el pedido              |
| `cantidad` no entera o < 1             | Línea N: La cantidad debe ser un número entero mayor que 0 |
| `precio_unitario` < 0                  | Línea N: El precio no puede ser negativo                 |
| `precio_unitario` no numérico          | Línea N: El precio debe ser un número mayor o igual a 0  |

### Respaldo por constraint de Postgres

Por si algo se escapa de los triggers:

| SQLSTATE / constraint                       | HTTP | Código                      |
| ------------------------------------------- | ---- | --------------------------- |
| 23505 `sales_order_lines_producto_uniq`     | 400  | `PV_PRODUCTO_REPETIDO`      |
| 23505 `sales_orders_numero_uniq`            | 500  | `INTERNAL_ERROR` (fallo interno del contador) |
| 23503 `sales_orders_id_customer_fkey`       | 400  | `PV_CLIENTE_NO_ENCONTRADO`  |
| 23503 `sales_order_lines_id_product_fkey`   | 400  | `PV_PRODUCTO_NO_ENCONTRADO` |
| 23514 `sales_orders_fechas_check`           | 400  | `PV_FECHAS_INVALIDAS`       |
| 23514 otro                                  | 400  | `PV_DATOS_INVALIDOS`        |
| 22003 (valor numérico fuera de rango)       | 400  | `PV_VALOR_FUERA_DE_RANGO`   |
| 22P02 (p. ej. estado inválido)              | 400  | `PV_VALIDACION`             |
| cualquier otro / `PV_*` desconocido         | 500  | `INTERNAL_ERROR`            |

El mapa vive en `src/lib/pv-errors.ts`; un test verifica que cubra exactamente
los códigos de la migración (y, si el repo de BD está al lado, los `so_raise()` del archivo).

## Tests

```bash
npm test          # unitarios (vitest, BD simulada con src/test-utils/fake-db.ts)
npm run test:db   # integración contra supabase-tiendas, todo dentro de una transacción con ROLLBACK
```
