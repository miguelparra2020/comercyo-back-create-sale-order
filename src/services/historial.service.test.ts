import { describe, it, expect, vi } from 'vitest';
import { getHistorialVenta } from './historial.service';

const respuestas = (r: Record<string, object[]>) => {
  const query = vi.fn(async (sql: string) => {
    const k = Object.keys(r).find((k) => sql.includes(k));
    return { rows: k ? r[k] : [] };
  });
  return { db: { query } as any, query };
};
const T = (h: string) => new Date(`2026-11-17T${h}:00Z`);

describe('getHistorialVenta (tarea 57)', () => {
  const datos = {
    'FROM sales_orders so': [{ id: '5', numero: 'PED-0005', cliente_nombre: 'Ana', estado: 'Entregado', total: '52000', created_at: T('14:00'), marketplace: true }],
    'FROM sales_order_events': [
      { estado: 'Pendiente', created_at: T('14:00') },
      { estado: 'En preparación', created_at: T('14:10') },
      { estado: 'En camino', created_at: T('15:00') },
      { estado: 'Entregado', created_at: T('16:00') },
    ],
    'FROM sales_invoices': [{ numero: 'FV-0007', total: '52000', created_at: T('16:01'), anulada_en: null }],
    'FROM sales_invoice_payments': [
      { factura: 'FV-0007', metodo: 'Transferencia', monto: '30000', referencia: 'Nequi 1', created_at: T('16:05'), anulado_en: T('16:20'), motivo_anulacion: 'Duplicado' },
      { factura: 'FV-0007', metodo: 'Efectivo', monto: '52000', referencia: null, created_at: T('16:30'), anulado_en: null, motivo_anulacion: null },
    ],
    'FROM sales_returns': [{ numero: 'DEV-0001', motivo: 'Llegó roto', valor: '10000', resolucion: 'Reintegro', monto_reintegro: '10000', metodo: 'Efectivo', created_at: T('18:00') }],
  };

  it('arma todo en orden, de lo primero a lo último', async () => {
    const { db } = respuestas(datos);
    const h = await getHistorialVenta(db, '5', { id_own_project: 9 });
    expect(h.pedido).toEqual({ id: '5', numero: 'PED-0005', tercero: 'Ana', estado: 'Entregado', total: 52000, origen: 'Marketplace' });
    expect(h.eventos.map((e) => e.titulo)).toEqual([
      'Ana hizo el pedido en el marketplace',
      'Quedó en Pendiente',
      'Pasó a En preparación (empacando)',
      'Salió: En camino',
      'Entregado al cliente',
      'Se generó la factura FV-0007',
      'Pago de $30.000 en transferencia',
      'Se anuló el pago de $30.000',
      'Pago de $52.000 en efectivo',
      'Devolución DEV-0001 por $10.000',
    ]);
    expect(h.eventos[6]).toMatchObject({ fecha: '2026-11-17T16:05:00.000Z', detalle: 'Factura FV-0007 · Ref. Nequi 1' });
    expect(h.eventos[7].detalle).toBe('Duplicado');
    expect(h.eventos[9].detalle).toBe('Llegó roto · Reintegro de $10.000 en efectivo');
  });

  it('la tienda solo ve sus pedidos y el comprador solo los suyos del marketplace', async () => {
    const { db, query } = respuestas(datos);
    await getHistorialVenta(db, '5', { id_own_project: 9 });
    expect(query.mock.calls[0][0]).toContain('so.id_own_project = $2::bigint');
    expect(query.mock.calls[0][1]).toEqual(['5', 9]);
    query.mockClear();
    await getHistorialVenta(db, '5', { id_user: 44 });
    expect(query.mock.calls[0][0]).toContain('mo.id_user = $2::bigint');
    const vacio = respuestas({});
    await expect(getHistorialVenta(vacio.db, '5', { id_user: 1 })).rejects.toMatchObject({ status: 404 });
  });
});
