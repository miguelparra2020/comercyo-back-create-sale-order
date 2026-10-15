import { describe, it, expect } from 'vitest';
import { toDateOnly, toLineDto, toOrderDto, TRANSICIONES } from './sales-orders.service';

describe('toDateOnly', () => {
  it('deja intacto el texto YYYY-MM-DD que devuelve to_char', () => {
    expect(toDateOnly('2026-10-15')).toBe('2026-10-15');
  });

  it('un Date de pg (medianoche local) no se desplaza un día, sea cual sea la zona horaria', () => {
    // node-postgres parses `date` as new Date(y, m, d) in local time.
    expect(toDateOnly(new Date(2026, 9, 15))).toBe('2026-10-15');
    expect(toDateOnly(new Date(2026, 0, 1))).toBe('2026-01-01');
  });
});

describe('TRANSICIONES', () => {
  it('cada acción lleva al estado de la máquina de estados (preparar/despachar/entregar/cancelar)', () => {
    expect(TRANSICIONES).toEqual({
      prepare: 'En preparación',
      ship: 'En camino',
      deliver: 'Entregado',
      cancel: 'Cancelado',
    });
  });
});

describe('toOrderDto', () => {
  it('convierte tipos según el contrato del API', () => {
    const dto = toOrderDto(
      {
        id_sales_order: '9007199254740993',
        id_own_project: '1',
        numero: 'PED-0001',
        id_customer: '5',
        cliente_nombre: 'Laura Gómez',
        fecha: '2026-10-15',
        fecha_entrega: '2026-10-18',
        notas: '',
        estado: 'Entregado',
        total: '51000.00',
        atrasado: false,
        entregado_en: new Date('2026-10-17T20:30:00.000Z'),
        created_at: new Date('2026-10-15T15:00:00.000Z'),
        updated_at: null,
      },
      [
        toLineDto({
          id_sales_order_line: '456',
          id_product: '789',
          producto_nombre: 'Resma carta',
          referencia: 'RES-CARTA',
          cantidad: '2',
          precio_unitario: '18000.00',
          subtotal: '36000.00',
        }),
      ]
    );

    expect(dto).toEqual({
      id_sales_order: '9007199254740993',
      id_own_project: 1,
      numero: 'PED-0001',
      id_customer: '5',
      cliente_nombre: 'Laura Gómez',
      fecha: '2026-10-15',
      fecha_entrega: '2026-10-18',
      notas: '',
      estado: 'Entregado',
      total: '51000.00',
      atrasado: false,
      entregado_en: '2026-10-17T20:30:00.000Z',
      created_at: '2026-10-15T15:00:00.000Z',
      updated_at: null,
      lineas: [
        {
          id_sales_order_line: '456',
          id_product: '789',
          producto_nombre: 'Resma carta',
          referencia: 'RES-CARTA',
          cantidad: 2,
          precio_unitario: '18000.00',
          subtotal: '36000.00',
        },
      ],
    });
  });

  it('atrasado solo es true si la BD devolvió exactamente true', () => {
    expect(toOrderDto({ atrasado: null }, []).atrasado).toBe(false);
    expect(toOrderDto({ atrasado: 't' }, []).atrasado).toBe(false);
    expect(toOrderDto({ atrasado: true }, []).atrasado).toBe(true);
  });
});
