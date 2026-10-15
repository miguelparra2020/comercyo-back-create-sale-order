import { describe, it, expect } from 'vitest';
import {
  formatIssue,
  IdParamSchema,
  isPositiveBigintId,
  isValidDate,
  ListQuerySchema,
  OrderBodySchema,
} from './sales-orders.validation';

const body = (overrides: Record<string, unknown> = {}) => ({
  id_customer: 5,
  fecha: '2026-10-15',
  fecha_entrega: '2026-10-18',
  lineas: [{ id_product: 789, cantidad: 2, precio_unitario: 18000 }],
  ...overrides,
});

const firstMessage = (input: unknown) => {
  const parsed = OrderBodySchema.safeParse(input);
  return parsed.success ? null : formatIssue(parsed.error.issues);
};

describe('isValidDate', () => {
  it.each(['2026-10-15', '2024-02-29', '2000-02-29'])('acepta %s', (v) => expect(isValidDate(v)).toBe(true));
  it.each(['2026-02-30', '2025-02-29', '2026-13-01', '15/10/2026', '2026-10-15T00:00:00Z', '', 20261015, null])(
    'rechaza %s',
    (v) => expect(isValidDate(v)).toBe(false)
  );
});

describe('isPositiveBigintId', () => {
  it.each([1, '1', '007', '9223372036854775807'])('acepta %s', (v) => expect(isPositiveBigintId(v)).toBe(true));
  it.each([0, -1, 1.5, '0', 'abc', '9223372036854775808', '1e3', null, undefined, Number.MAX_SAFE_INTEGER + 2])(
    'rechaza %s',
    (v) => expect(isPositiveBigintId(v)).toBe(false)
  );
});

describe('OrderBodySchema', () => {
  it('normaliza ids a string canónico, notas por defecto y precio opcional -> null', () => {
    const parsed = OrderBodySchema.parse(
      body({ id_customer: '005', lineas: [{ id_product: '0789', cantidad: 1 }, { id_product: 790, cantidad: 3, precio_unitario: 0 }] })
    );
    expect(parsed).toEqual({
      id_customer: '5',
      fecha: '2026-10-15',
      fecha_entrega: '2026-10-18',
      notas: '',
      lineas: [
        { id_product: '789', cantidad: 1, precio_unitario: null },
        { id_product: '790', cantidad: 3, precio_unitario: 0 },
      ],
    });
  });

  it('descarta campos calculados o desconocidos', () => {
    const parsed = OrderBodySchema.parse(
      body({ numero: 'PED-9999', total: '1', estado: 'Entregado', cliente_nombre: 'x', id_own_project: 99 })
    ) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['fecha', 'fecha_entrega', 'id_customer', 'lineas', 'notas']);
  });

  it('acepta entrega igual a la fecha y precios con 2 decimales no exactos en binario', () => {
    expect(firstMessage(body({ fecha_entrega: '2026-10-15' }))).toBeNull();
    expect(firstMessage(body({ lineas: [{ id_product: 1, cantidad: 1, precio_unitario: 0.29 }] }))).toBeNull();
  });

  it('acepta 50 líneas', () => {
    const lineas = Array.from({ length: 50 }, (_, i) => ({ id_product: i + 1, cantidad: 1 }));
    expect(firstMessage(body({ lineas }))).toBeNull();
  });

  // Mensajes alineados con src/saas/utils/pedidoVenta.ts del frontend.
  it.each([
    ['sin cliente', { id_customer: undefined }, 'Selecciona un cliente'],
    ['cliente vacío', { id_customer: '' }, 'Selecciona un cliente'],
    ['cliente inválido', { id_customer: 'abc' }, 'El cliente seleccionado no es válido'],
    ['sin fecha', { fecha: undefined }, 'Selecciona la fecha'],
    ['fecha inválida', { fecha: '2026-02-30' }, 'La fecha debe tener el formato YYYY-MM-DD y ser válida'],
    ['sin fecha de entrega', { fecha_entrega: '' }, 'Selecciona la fecha de entrega'],
    ['entrega inválida', { fecha_entrega: '18/10/2026' }, 'La fecha de entrega debe tener el formato YYYY-MM-DD y ser válida'],
    ['entrega antes de la fecha', { fecha_entrega: '2026-10-14' }, 'La entrega no puede ser antes de la fecha del pedido'],
    ['notas largas', { notas: 'a'.repeat(501) }, 'Las notas pueden tener máximo 500 caracteres'],
    ['notas no texto', { notas: 5 }, 'Las notas deben ser texto'],
    ['sin líneas', { lineas: [] }, 'Agrega al menos un producto'],
    ['líneas ausentes', { lineas: undefined }, 'Agrega al menos un producto'],
    ['51 líneas', { lineas: Array.from({ length: 51 }, (_, i) => ({ id_product: i + 1, cantidad: 1 })) }, 'Un pedido puede tener máximo 50 productos'],
    ['línea no objeto', { lineas: [5] }, 'Línea 1: Cada producto del pedido debe ser un objeto'],
    ['sin producto', { lineas: [{ cantidad: 1 }] }, 'Línea 1: Selecciona un producto'],
    ['producto inválido', { lineas: [{ id_product: -2, cantidad: 1 }] }, 'Línea 1: El producto seleccionado no es válido'],
    ['producto repetido', { lineas: [{ id_product: 7, cantidad: 1 }, { id_product: '07', cantidad: 2 }] }, 'Línea 2: Este producto ya está en el pedido'],
    ['cantidad 0', { lineas: [{ id_product: 1, cantidad: 0 }] }, 'Línea 1: La cantidad debe ser un número entero mayor que 0'],
    ['cantidad decimal', { lineas: [{ id_product: 1, cantidad: 1.5 }] }, 'Línea 1: La cantidad debe ser un número entero mayor que 0'],
    ['cantidad texto', { lineas: [{ id_product: 1, cantidad: '2' }] }, 'Línea 1: La cantidad debe ser un número entero mayor que 0'],
    ['precio negativo', { lineas: [{ id_product: 1, cantidad: 1, precio_unitario: -1 }] }, 'Línea 1: El precio no puede ser negativo'],
    ['precio texto', { lineas: [{ id_product: 1, cantidad: 1, precio_unitario: 'mil' }] }, 'Línea 1: El precio debe ser un número mayor o igual a 0'],
    ['precio con 3 decimales', { lineas: [{ id_product: 1, cantidad: 1, precio_unitario: 1.234 }] }, 'Línea 1: El precio debe tener máximo 2 decimales'],
    ['precio fuera de numeric(14,2)', { lineas: [{ id_product: 1, cantidad: 1, precio_unitario: 1e13 }] }, 'Línea 1: El precio debe ser como máximo 999999999999.99'],
  ])('%s', (_label, overrides, message) => {
    expect(firstMessage(body(overrides))).toBe(message);
  });

  it('rechaza un body que no es objeto', () => {
    expect(firstMessage(null)).toBe('El cuerpo de la petición debe ser un objeto JSON');
    expect(firstMessage([])).toBe('El cuerpo de la petición debe ser un objeto JSON');
  });
});

describe('ListQuerySchema', () => {
  it('aplica los valores por defecto', () => {
    expect(ListQuerySchema.parse({})).toEqual({ page: 1, limit: 10 });
  });

  it('convierte los filtros', () => {
    expect(
      ListQuerySchema.parse({
        search: '  ped-00 ',
        estado: 'En preparación',
        id_customer: '05',
        atrasado: 'true',
        fecha_desde: '2026-10-01',
        fecha_hasta: '2026-10-31',
        page: '2',
        limit: '100',
      })
    ).toEqual({
      search: 'ped-00',
      estado: 'En preparación',
      id_customer: '5',
      atrasado: true,
      fecha_desde: '2026-10-01',
      fecha_hasta: '2026-10-31',
      page: 2,
      limit: 100,
    });
    expect(ListQuerySchema.parse({ search: '   ', atrasado: 'false' })).toMatchObject({ search: undefined, atrasado: false });
  });

  it.each([
    [{ estado: 'Enviada' }, 'estado debe ser uno de: Pendiente, En preparación, En camino, Entregado, Cancelado'],
    [{ id_customer: 'x' }, 'id_customer debe ser un entero positivo'],
    [{ atrasado: 'si' }, 'atrasado debe ser true o false'],
    [{ fecha_desde: '2026-02-30' }, 'fecha_desde debe tener el formato YYYY-MM-DD y ser válida'],
    [{ fecha_desde: '2026-10-10', fecha_hasta: '2026-10-01' }, 'fecha_desde no puede ser posterior a fecha_hasta'],
    [{ page: '0' }, 'page debe ser como mínimo 1'],
    [{ limit: '101' }, 'limit debe ser como máximo 100'],
    [{ limit: 'diez' }, 'limit debe ser un número entero'],
  ])('%o', (query, message) => {
    const parsed = ListQuerySchema.safeParse(query);
    expect(parsed.success).toBe(false);
    expect(formatIssue(parsed.error!.issues)).toBe(message);
  });
});

describe('IdParamSchema', () => {
  it.each(['1', '9007199254740993'])('acepta %s', (id) => expect(IdParamSchema.safeParse({ id }).success).toBe(true));
  it.each(['0', 'abc', '-1', '1.5'])('rechaza %s', (id) => {
    const parsed = IdParamSchema.safeParse({ id });
    expect(parsed.success).toBe(false);
    expect(formatIssue(parsed.error!.issues)).toBe('El id debe ser un entero positivo');
  });
});
