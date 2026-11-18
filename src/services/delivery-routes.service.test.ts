import { describe, it, expect, vi } from 'vitest';
import { getDeliveryRoutes } from './delivery-routes.service';

const fakeDb = (tienda: object[], pedidos: object[]) => {
  const query = vi.fn(async (sql: string) => ({ rows: sql.includes('FROM store_info') ? tienda : pedidos }));
  return { db: { query } as any, query };
};

describe('getDeliveryRoutes (tarea 56)', () => {
  it('trae la tienda como origen y los pedidos En camino con su destino', async () => {
    const { db, query } = fakeDb(
      [{ latitud: '4.813330', longitud: '-75.696110', direccion: 'Cra 7 # 20-10' }],
      [
        { id_sales_order: '5', numero: 'PED-0005', cliente_nombre: 'Ana', telefono: '3001112233', direccion: 'Calle 1', detalle_direccion: 'Apto 2', ciudad: 'Pereira', latitud: '4.800000', longitud: '-75.690000', total: '52000.00', fecha_entrega: new Date('2026-11-17T00:00:00Z'), condicion_pago: 'contra_entrega' },
        { id_sales_order: '6', numero: 'PED-0006', cliente_nombre: 'Luis', telefono: null, direccion: 'Mz 3 casa 4, Dosquebradas', detalle_direccion: null, ciudad: null, latitud: null, longitud: null, total: '10000', fecha_entrega: null, condicion_pago: null },
      ]
    );
    const r = await getDeliveryRoutes(db, 9);
    expect(r.origen).toEqual({ direccion: 'Cra 7 # 20-10', ubicacion: { lat: 4.81333, lng: -75.69611 } });
    expect(r.paradas).toEqual([
      { id_sales_order: '5', numero: 'PED-0005', cliente: 'Ana', telefono: '3001112233', direccion: 'Calle 1', detalle_direccion: 'Apto 2', ciudad: 'Pereira', ubicacion: { lat: 4.8, lng: -75.69 }, total: 52000, condicion_pago: 'contra_entrega', fecha_entrega: '2026-11-17' },
      { id_sales_order: '6', numero: 'PED-0006', cliente: 'Luis', telefono: null, direccion: 'Mz 3 casa 4, Dosquebradas', detalle_direccion: null, ciudad: null, ubicacion: null, total: 10000, condicion_pago: null, fecha_entrega: null },
    ]);
    const sql = query.mock.calls.map((c) => c[0]).find((s) => s.includes('FROM sales_orders'))!;
    expect(sql).toContain("so.estado = 'En camino'");
    expect(sql).toContain('so.deleted_at IS NULL');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('so.id_own_project = $1::bigint'), [9]);
  });

  it('sin ubicación de la tienda el origen queda vacío', async () => {
    const { db } = fakeDb([], []);
    expect(await getDeliveryRoutes(db, 9)).toEqual({ origen: { direccion: null, ubicacion: null }, paradas: [] });
  });
});
