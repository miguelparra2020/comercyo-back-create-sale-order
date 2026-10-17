# API de Pedidos de venta

Base: `/api/v1` · Swagger UI: `/api/v1/doc` · OpenAPI: `/api/v1/openapi.json`

| Entorno    | URL                                                    |
| ---------- | ------------------------------------------------------ |
| Local      | `http://localhost:3007/api/v1`                         |
| Producción | `https://comercyo-back-create-sale-order.vercel.app/api/v1` |

Base de datos: `supabase-tiendas`, migraciones `20261015031310_create_sales_orders`
(tablas `sales_orders`, `sales_order_lines`, `sales_order_counters`, vista `v_sales_orders`)
y `20261017034032_sales_orders_ajustes` (descuento, impuesto y envío a nivel de pedido).
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

`numero` (PED-0001, consecutivo por proyecto y seguro ante concurrencia), `total`, `subtotal`
(de la línea y del pedido), `descuento_monto`, `impuesto_monto`,
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
  "descuento_tipo": "porcentaje",
  "descuento_valor": "10.00",
  "impuesto_tipo": "porcentaje",
  "impuesto_valor": "19.00",
  "costo_envio": "8000.00",
  "subtotal": "36000.00",
  "descuento_monto": "3600.00",
  "impuesto_monto": "6156.00",
  "total": "46556.00",
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
- numeric (`descuento_valor`, `impuesto_valor`, `costo_envio`, `subtotal`, `descuento_monto`,
  `impuesto_monto`, `total`, `precio_unitario`, `subtotal` de la línea) → string con 2 decimales.
- `descuento_tipo`, `impuesto_tipo` → `"porcentaje"`, `"valor"` o `null`.
- `fecha`, `fecha_entrega` → `YYYY-MM-DD` sin hora ni zona (no se desplazan un día).
- `entregado_en`, `created_at`, `updated_at` → ISO 8601 en UTC o `null`.
  `updated_at` ya viene con valor en un pedido recién creado: al insertar las líneas la BD
  recalcula el total de la cabecera y eso cuenta como actualización.
- `lineas` en el orden en que se enviaron.
- `cantidad` → number.

### Ajustes: descuento, impuesto y envío

Tres ajustes opcionales a nivel de pedido. Los 9 campos vienen en **todas** las respuestas que
devuelven un pedido (listado, detalle, POST, PUT, DELETE y `/prepare`, `/ship`, `/deliver`, `/cancel`).

| Campo             | Quién lo escribe | Valores                                   |
| ----------------- | ---------------- | ----------------------------------------- |
| `descuento_tipo`  | API              | `"porcentaje"` \| `"valor"` \| `null`     |
| `descuento_valor` | API              | ≥ 0, 2 decimales (default 0)              |
| `impuesto_tipo`   | API              | `"porcentaje"` \| `"valor"` \| `null`     |
| `impuesto_valor`  | API              | ≥ 0, 2 decimales (default 0)              |
| `costo_envio`     | API              | ≥ 0, 2 decimales (default 0)              |
| `subtotal`        | BD, solo lectura | suma de las líneas                        |
| `descuento_monto` | BD, solo lectura |                                           |
| `impuesto_monto`  | BD, solo lectura |                                           |
| `total`           | BD, solo lectura |                                           |

Cálculo (trigger `sales_orders_sync_total`, todo a 2 decimales):

```
subtotal        = SUM(cantidad × precio_unitario) de las líneas
descuento_monto = 'porcentaje' → ROUND(subtotal × descuento_valor / 100, 2) | 'valor' → descuento_valor | null → 0
base            = subtotal − descuento_monto
impuesto_monto  = sobre la BASE ya descontada: 'porcentaje' → ROUND(base × impuesto_valor / 100, 2) | 'valor' → impuesto_valor | null → 0
total           = base + impuesto_monto + costo_envio      (el envío no lleva impuesto)
```

Ejemplo: líneas 2×2000 + 3×900, 10 % de descuento, 19 % de impuesto y 8000 de envío →
`subtotal` 6700, `descuento_monto` 670, `impuesto_monto` 1145.70, `total` 15175.70.

Un pedido sin ajustes tiene tipos `null`, valores y montos en `"0.00"` y `subtotal` = `total`.
Los ajustes son parte de la cabecera: solo se cambian en Pendiente o En preparación
(si no → 409 `PV_PEDIDO_NO_EDITABLE`).

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
    ],
    "descuento_tipo": "porcentaje",
    "descuento_valor": 10,
    "impuesto_tipo": null,
    "impuesto_valor": 0,
    "costo_envio": 8000
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
| `descuento_tipo`            | opcional: `"porcentaje"` \| `"valor"` \| `null` (default `null`) |
| `descuento_valor`           | opcional, número ≥ 0 con máx. 2 decimales (default 0)         |
| `impuesto_tipo`             | opcional: `"porcentaje"` \| `"valor"` \| `null` (default `null`) |
| `impuesto_valor`            | opcional, número ≥ 0 con máx. 2 decimales (default 0)         |
| `costo_envio`               | opcional, número ≥ 0 con máx. 2 decimales (default 0)         |

Reglas cruzadas de los ajustes:

- tipo `null` (o ausente en POST) → el valor tiene que ser `0`. Si no, 400; **no** se pasa a 0 en silencio.
- tipo `"porcentaje"` → valor ≤ 100 (descuento e impuesto).
- `descuento_tipo = "valor"` → `descuento_valor` ≤ SUM(`cantidad` × `precio_unitario`) de las líneas
  del body; si no → 400 `PV_DESCUENTO_EXCEDE_SUBTOTAL`. Si alguna línea no trae precio (lo pone la
  BD desde el producto), la API no puede sumar y la regla la aplica la BD al confirmar la
  transacción, con el mismo código y mensaje.
- El impuesto en `"valor"` no tiene tope.
- `subtotal`, `descuento_monto`, `impuesto_monto` y `total` se ignoran si vienen en el body; nunca se escriben.

El frontend siempre envía los 5 campos; sin tipo manda `"descuento_tipo": null, "descuento_valor": 0`
(igual para el impuesto).

Se ejecuta en **una transacción**: INSERT cabecera (Pendiente, con los ajustes, `RETURNING`) →
INSERT líneas → releer el pedido completo. Si algo falla no queda nada (ni se consume el número).
`201 { success: true, data: <pedido> }`.

La cabecera se inserta antes que las líneas (subtotal 0 en ese momento), por eso el tope del
descuento fijo lo valida un constraint trigger **diferido** (`trg_so_70_ajustes`): el error sale
en el `COMMIT`, `withTransaction` lo relanza y se responde 400 `PV_DESCUENTO_EXCEDE_SUBTOTAL`.

## PUT /sales-orders/:id

Mismo body y mismas reglas que POST. Reemplaza la cabecera y **todas** las líneas, en una transacción:
UPDATE cabecera (con los ajustes) → DELETE líneas → INSERT líneas → releer. Solo en Pendiente o
En preparación (si no → 409 `PV_PEDIDO_NO_EDITABLE`, también si solo cambia un ajuste); el estado
no cambia. Como las líneas se vuelven a insertar, sus nombres, referencias y (si no se envía
precio) precios se toman de nuevo del producto, y sus `id_sales_order_line` cambian.

**Ajustes en PUT:** un campo de ajuste que **no venga** en el body conserva el valor actual del
pedido (no entra en el `SET`), para que un cliente que no los conoce no los borre. Para quitar un
ajuste hay que enviarlo explícito: `"descuento_tipo": null, "descuento_valor": 0`. Si solo viene el
valor sin su tipo, la regla que depende del tipo guardado la aplica la BD (CHECK → 400).

Durante el reemplazo de líneas el subtotal es 0 por un momento; el tope del descuento fijo se
valida al `COMMIT` con el estado final, así que editar un pedido con descuento fijo cambiando sus
líneas en el mismo PUT funciona.

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

El `message` de la respuesta es el texto de la BD sin el prefijo (salvo
`PV_DESCUENTO_EXCEDE_SUBTOTAL`, que usa un texto fijo sin el número del pedido).

| Código                       | HTTP | Cuándo                                                     |
| ---------------------------- | ---- | ---------------------------------------------------------- |
| `PV_DESCUENTO_EXCEDE_SUBTOTAL` | 400 | el descuento fijo es mayor que el subtotal; sale en el `COMMIT` (trigger diferido). Mensaje: "El descuento no puede ser mayor al subtotal del pedido" |
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
| `PV_DESCUENTO_EXCEDE_SUBTOTAL` | 400 | la validación de la API detecta el descuento fijo mayor que las líneas (mismo código que la BD) |
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
| `descuento_tipo` inválido              | El tipo de descuento debe ser porcentaje, valor o null   |
| `impuesto_tipo` inválido               | El tipo de impuesto debe ser porcentaje, valor o null    |
| `descuento_valor` no numérico          | El descuento debe ser un número mayor o igual a 0        |
| `descuento_valor` < 0                  | El descuento no puede ser negativo                       |
| `descuento_valor` con > 2 decimales    | El descuento debe tener máximo 2 decimales               |
| descuento sin tipo con valor ≠ 0       | El descuento debe ser 0 si no se indica si es porcentaje o valor |
| descuento `porcentaje` > 100           | El descuento no puede ser mayor a 100%                   |
| descuento `valor` > suma de líneas     | El descuento no puede ser mayor al subtotal del pedido (código `PV_DESCUENTO_EXCEDE_SUBTOTAL`) |
| `impuesto_valor` (mismas reglas)       | El impuesto no puede ser negativo / … máximo 2 decimales / … mayor a 100% / … debe ser 0 si no se indica si es porcentaje o valor |
| `costo_envio` no numérico, < 0 o > 2 decimales | El costo de envío debe ser un número mayor o igual a 0 / no puede ser negativo / debe tener máximo 2 decimales |

### Respaldo por constraint de Postgres

Por si algo se escapa de los triggers:

| SQLSTATE / constraint                       | HTTP | Código                      |
| ------------------------------------------- | ---- | --------------------------- |
| 23505 `sales_order_lines_producto_uniq`     | 400  | `PV_PRODUCTO_REPETIDO`      |
| 23505 `sales_orders_numero_uniq`            | 500  | `INTERNAL_ERROR` (fallo interno del contador) |
| 23503 `sales_orders_id_customer_fkey`       | 400  | `PV_CLIENTE_NO_ENCONTRADO`  |
| 23503 `sales_order_lines_id_product_fkey`   | 400  | `PV_PRODUCTO_NO_ENCONTRADO` |
| 23514 `sales_orders_fechas_check`           | 400  | `PV_FECHAS_INVALIDAS`       |
| 23514 `sales_orders_descuento_tipo_check`   | 400  | `PV_DESCUENTO_TIPO_INVALIDO` |
| 23514 `sales_orders_impuesto_tipo_check`    | 400  | `PV_IMPUESTO_TIPO_INVALIDO` |
| 23514 `sales_orders_descuento_valor_check`  | 400  | `PV_DESCUENTO_NEGATIVO`     |
| 23514 `sales_orders_impuesto_valor_check`   | 400  | `PV_IMPUESTO_NEGATIVO`      |
| 23514 `sales_orders_costo_envio_check`      | 400  | `PV_COSTO_ENVIO_NEGATIVO`   |
| 23514 `sales_orders_descuento_sin_tipo_check` | 400 | `PV_DESCUENTO_SIN_TIPO`    |
| 23514 `sales_orders_impuesto_sin_tipo_check`  | 400 | `PV_IMPUESTO_SIN_TIPO`     |
| 23514 `sales_orders_descuento_porcentaje_check` | 400 | `PV_DESCUENTO_PORCENTAJE_INVALIDO` |
| 23514 `sales_orders_impuesto_porcentaje_check`  | 400 | `PV_IMPUESTO_PORCENTAJE_INVALIDO`  |
| 23514 otro                                  | 400  | `PV_DATOS_INVALIDOS`        |

Los CHECK de ajustes responden con el mismo mensaje en español que la validación de la API
para esa regla (la tabla de mensajes de arriba).
| 22003 (valor numérico fuera de rango)       | 400  | `PV_VALOR_FUERA_DE_RANGO`   |
| 22P02 (p. ej. estado inválido)              | 400  | `PV_VALIDACION`             |
| cualquier otro / `PV_*` desconocido         | 500  | `INTERNAL_ERROR`            |

El mapa vive en `src/lib/pv-errors.ts`; un test verifica que cubra exactamente
los códigos de las migraciones (y, si el repo de BD está al lado, los `so_raise()` y los CHECK
de ajustes de los archivos).

## Tests

```bash
npm test          # unitarios (vitest, BD simulada con src/test-utils/fake-db.ts)
npm run test:db   # integración contra supabase-tiendas, todo dentro de una transacción con ROLLBACK
```

En `test:db` el `COMMIT` del servicio se emula con `SET CONSTRAINTS ALL IMMEDIATE` + `RELEASE SAVEPOINT`,
para que el trigger diferido de ajustes falle en el mismo punto que en producción.
