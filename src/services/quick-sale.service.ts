import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '../lib/transaction';
import type { QuickSaleBody } from '../validation/sales-orders.validation';
import { getSalesOrder, type Scope } from './sales-orders.service';

// Caja rápida (tarea 35): a counter sale in ONE transaction. The order is
// created, walked through the state machine to 'Entregado' (the customer
// takes it), invoiced (which discounts the stock) and paid in full with the
// chosen method. If any step fails (no stock, a product from another store...)
// nothing is kept. Every rule stays in the DB triggers, as with the
// step-by-step routes.

type Db = Pick<Pool, 'query' | 'connect'>;
type Queryable = Pick<Pool | PoolClient, 'query'>;

// The store's walk-in customer, for buyers who don't give their details.
// customers requires email/phone/address, so it gets placeholder ones; the
// email carries the project id so it never clashes between stores.
export const CLIENTE_MOSTRADOR = {
  nombre: 'Cliente de mostrador',
  telefono: '0000000',
  direccion: 'Venta en mostrador',
  email: (idOwnProject: number) => `mostrador+${idOwnProject}@comercyo.com`,
};

// Finds the walk-in customer, creating it on the store's first counter sale
// (or bringing it back if someone deleted it).
export const clienteMostrador = async (q: Queryable, scope: Scope): Promise<string> => {
  const email = CLIENTE_MOSTRADOR.email(scope.id_own_project);
  const buscar = () =>
    q.query(
      `SELECT id_customer::text AS id_customer FROM customers
        WHERE id_own_project = $1 AND email = $2 AND deleted_at IS NULL
        ORDER BY id_customer LIMIT 1`,
      [scope.id_own_project, email]
    );
  let { rows } = await buscar();
  if (rows[0]) return rows[0].id_customer;

  ({ rows } = await q.query(
    `INSERT INTO customers (id_own_project, nombre, email, telefono, direccion, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT DO NOTHING
     RETURNING id_customer::text AS id_customer`,
    [scope.id_own_project, CLIENTE_MOSTRADOR.nombre, email, CLIENTE_MOSTRADOR.telefono, CLIENTE_MOSTRADOR.direccion, scope.id_user]
  ));
  if (rows[0]) return rows[0].id_customer;

  // The email is taken: a deleted walk-in customer (bring it back) or a sale
  // that created it at the same moment.
  ({ rows } = await q.query(
    `UPDATE customers SET deleted_at = NULL, updated_by_user_id = $3
      WHERE id_own_project = $1 AND email = $2
      RETURNING id_customer::text AS id_customer`,
    [scope.id_own_project, email, scope.id_user]
  ));
  if (rows[0]) return rows[0].id_customer;
  ({ rows } = await buscar());
  return rows[0].id_customer;
};

const HOY_BOGOTA = `(now() AT TIME ZONE 'America/Bogota')::date`;

export const createQuickSale = async (db: Db, scope: Scope, input: QuickSaleBody) => {
  const id = await withTransaction(db, async (client) => {
    const idCustomer = input.id_customer ?? (await clienteMostrador(client, scope));

    const { rows } = await client.query(
      `INSERT INTO sales_orders
         (id_own_project, id_customer, fecha, fecha_entrega, notas, created_by_user_id, descuento_tipo, descuento_valor)
       VALUES ($1, $2::bigint, ${HOY_BOGOTA}, ${HOY_BOGOTA}, $3, $4, $5, $6::numeric)
       RETURNING id_sales_order::text AS id_sales_order`,
      [scope.id_own_project, idCustomer, input.notas, scope.id_user, input.descuento_tipo, input.descuento_valor]
    );
    const idOrder = rows[0].id_sales_order as string;

    await client.query(
      `INSERT INTO sales_order_lines (id_sales_order, id_product, cantidad, precio_unitario)
       SELECT $1::bigint, l.id_product, l.cantidad, l.precio_unitario
       FROM unnest($2::bigint[], $3::int[], $4::numeric[]) WITH ORDINALITY AS l(id_product, cantidad, precio_unitario, ord)
       ORDER BY l.ord`,
      [idOrder, input.lineas.map((l) => l.id_product), input.lineas.map((l) => l.cantidad), input.lineas.map((l) => l.precio_unitario)]
    );

    // Same path as the buttons: Pendiente -> En preparación -> En camino -> Entregado.
    for (const estado of ['En preparación', 'En camino', 'Entregado']) {
      await client.query(
        `UPDATE sales_orders SET estado = $1::sales_order_status, updated_by_user_id = $2 WHERE id_sales_order = $3`,
        [estado, scope.id_user, idOrder]
      );
    }

    // Invoice due today; descuenta_inventario takes the products out of stock
    // (FV_STOCK_INSUFICIENTE rolls the whole sale back).
    const factura = await client.query(
      `INSERT INTO sales_invoices
         (id_own_project, id_sales_order, fecha_emision, fecha_vencimiento, notas, descuenta_inventario, created_by_user_id)
       VALUES ($1, $2::bigint, ${HOY_BOGOTA}, ${HOY_BOGOTA}, $3, true, $4)
       RETURNING id_sales_invoice::text AS id_sales_invoice, total::text AS total`,
      [scope.id_own_project, idOrder, 'Venta en Caja rápida', scope.id_user]
    );
    const { id_sales_invoice, total } = factura.rows[0];

    await client.query(
      `INSERT INTO sales_invoice_payments
         (id_own_project, id_sales_invoice, fecha, metodo, monto, referencia, created_by_user_id)
       VALUES ($1, $2::bigint, ${HOY_BOGOTA}, $3, $4::numeric, $5, $6)`,
      [scope.id_own_project, id_sales_invoice, input.metodo, total, input.referencia, scope.id_user]
    );
    return idOrder;
  });
  return getSalesOrder(db, id, scope.id_own_project);
};
