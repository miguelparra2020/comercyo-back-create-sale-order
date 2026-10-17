import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { mapSalesOrderError, PV_ERROR_STATUS, parsePvMessage, SalesOrderError } from './pv-errors';
import { pvError, pgError } from '../test-utils/fake-db';

// Every code listed in the header of 20261015031310_create_sales_orders.sql.
const MIGRATION_CODES = [
  'PV_ESTADO_INICIAL_INVALIDO',
  'PV_TRANSICION_INVALIDA',
  'PV_PEDIDO_NO_EDITABLE',
  'PV_PEDIDO_ELIMINADO',
  'PV_PEDIDO_NO_ENCONTRADO',
  'PV_BORRADO_NO_PERMITIDO',
  'PV_CAMPO_INMUTABLE',
  'PV_CLIENTE_NO_ENCONTRADO',
  'PV_CLIENTE_OTRO_PROYECTO',
  'PV_CLIENTE_INACTIVO',
  'PV_PRODUCTO_NO_ENCONTRADO',
  'PV_PRODUCTO_OTRO_PROYECTO',
  'PV_PRODUCTO_ELIMINADO',
  'PV_PRODUCTO_REPETIDO',
  'PV_MAX_LINEAS',
  // 20261017034032_sales_orders_ajustes.sql
  'PV_DESCUENTO_EXCEDE_SUBTOTAL',
];

// CHECK constraints added by 20261017034032_sales_orders_ajustes.sql.
const AJUSTES_CHECKS: [string, string, string][] = [
  ['sales_orders_descuento_tipo_check', 'PV_DESCUENTO_TIPO_INVALIDO', 'El tipo de descuento debe ser porcentaje, valor o null'],
  ['sales_orders_impuesto_tipo_check', 'PV_IMPUESTO_TIPO_INVALIDO', 'El tipo de impuesto debe ser porcentaje, valor o null'],
  ['sales_orders_descuento_valor_check', 'PV_DESCUENTO_NEGATIVO', 'El descuento no puede ser negativo'],
  ['sales_orders_impuesto_valor_check', 'PV_IMPUESTO_NEGATIVO', 'El impuesto no puede ser negativo'],
  ['sales_orders_costo_envio_check', 'PV_COSTO_ENVIO_NEGATIVO', 'El costo de envío no puede ser negativo'],
  ['sales_orders_descuento_sin_tipo_check', 'PV_DESCUENTO_SIN_TIPO', 'El descuento debe ser 0 si no se indica si es porcentaje o valor'],
  ['sales_orders_impuesto_sin_tipo_check', 'PV_IMPUESTO_SIN_TIPO', 'El impuesto debe ser 0 si no se indica si es porcentaje o valor'],
  ['sales_orders_descuento_porcentaje_check', 'PV_DESCUENTO_PORCENTAJE_INVALIDO', 'El descuento no puede ser mayor a 100%'],
  ['sales_orders_impuesto_porcentaje_check', 'PV_IMPUESTO_PORCENTAJE_INVALIDO', 'El impuesto no puede ser mayor a 100%'],
];

// The migrations live in the DB repo next to this backend; when it is checked
// out, also verify the lists above against the real files.
const MIGRATIONS_DIR = resolve(__dirname, '../../../../3 DB/supabase/migrations');
const MIGRATION_FILES = ['20261015031310_create_sales_orders.sql', '20261017034032_sales_orders_ajustes.sql'].map((f) =>
  resolve(MIGRATIONS_DIR, f)
);
const migrationsPresent = MIGRATION_FILES.every((f) => existsSync(f));
const migrationsSql = () => MIGRATION_FILES.map((f) => readFileSync(f, 'utf8')).join('\n');

describe('PV_ERROR_STATUS', () => {
  it('cubre exactamente los códigos de las migraciones', () => {
    expect(Object.keys(PV_ERROR_STATUS).sort()).toEqual([...MIGRATION_CODES].sort());
  });

  it.runIf(migrationsPresent)('la lista coincide con los so_raise() de los archivos de migración', () => {
    const raised = new Set([...migrationsSql().matchAll(/so_raise\('(PV_[A-Z_]+)'/g)].map((m) => m[1]));
    expect([...raised].sort()).toEqual([...MIGRATION_CODES].sort());
  });

  it.runIf(migrationsPresent)('cada CHECK de ajustes mapeado existe en la migración (y no falta ninguno)', () => {
    const sql = readFileSync(MIGRATION_FILES[1], 'utf8');
    const added = new Set([...sql.matchAll(/add constraint (sales_orders_\w+_check)/g)].map((m) => m[1]));
    expect([...added].sort()).toEqual(AJUSTES_CHECKS.map(([name]) => name).sort());
  });

  it('PV_DESCUENTO_EXCEDE_SUBTOTAL -> 400 con mensaje fijo, sin el código ni el número del pedido', () => {
    const err = pvError('PV_DESCUENTO_EXCEDE_SUBTOTAL', 'El descuento no puede ser mayor al subtotal del pedido PED-0042.');
    expect(mapSalesOrderError(err)).toEqual({
      status: 400,
      body: {
        success: false,
        error: 'Bad Request',
        message: 'El descuento no puede ser mayor al subtotal del pedido',
        code: 'PV_DESCUENTO_EXCEDE_SUBTOTAL',
      },
    });
  });

  it.each([
    ['PV_CLIENTE_NO_ENCONTRADO', 400],
    ['PV_CLIENTE_OTRO_PROYECTO', 400],
    ['PV_CLIENTE_INACTIVO', 400],
    ['PV_PRODUCTO_NO_ENCONTRADO', 400],
    ['PV_PRODUCTO_OTRO_PROYECTO', 400],
    ['PV_PRODUCTO_ELIMINADO', 400],
    ['PV_PRODUCTO_REPETIDO', 400],
    ['PV_MAX_LINEAS', 400],
    ['PV_ESTADO_INICIAL_INVALIDO', 409],
    ['PV_TRANSICION_INVALIDA', 409],
    ['PV_PEDIDO_NO_EDITABLE', 409],
    ['PV_PEDIDO_ELIMINADO', 409],
    ['PV_BORRADO_NO_PERMITIDO', 409],
    ['PV_CAMPO_INMUTABLE', 409],
    ['PV_PEDIDO_NO_ENCONTRADO', 404],
  ])('%s -> %i', (code, status) => {
    const mapped = mapSalesOrderError(pvError(code, 'texto'));
    expect(mapped).toEqual({
      status,
      body: { success: false, error: expect.any(String), message: 'texto', code },
    });
  });
});

describe('parsePvMessage', () => {
  it('separa código y texto (el texto puede contener ":" y saltos de línea)', () => {
    expect(parsePvMessage(pvError('PV_MAX_LINEAS', 'El pedido PED-0001: máximo\n50'))).toEqual({
      code: 'PV_MAX_LINEAS',
      message: 'El pedido PED-0001: máximo\n50',
    });
  });

  it('toma el código de err.detail cuando viene', () => {
    const err = Object.assign(new Error('PV_MAX_LINEAS: texto'), { code: 'P0001', detail: 'PV_PRODUCTO_REPETIDO' });
    expect(parsePvMessage(err)).toEqual({ code: 'PV_PRODUCTO_REPETIDO', message: 'texto' });
  });

  it('funciona sin detail (usa el prefijo del mensaje)', () => {
    const err = Object.assign(new Error('PV_MAX_LINEAS: texto'), { code: 'P0001' });
    expect(parsePvMessage(err)).toEqual({ code: 'PV_MAX_LINEAS', message: 'texto' });
  });

  it('ignora errores que no son P0001 o no tienen el prefijo PV_', () => {
    expect(parsePvMessage(Object.assign(new Error('PV_MAX_LINEAS: x'), { code: '23505' }))).toBeNull();
    expect(parsePvMessage(Object.assign(new Error('OC_MAX_LINEAS: x'), { code: 'P0001' }))).toBeNull();
    expect(parsePvMessage(Object.assign(new Error('otra cosa'), { code: 'P0001' }))).toBeNull();
    expect(parsePvMessage(null)).toBeNull();
  });
});

describe('mapSalesOrderError', () => {
  it('traduce los SalesOrderError del API', () => {
    expect(mapSalesOrderError(new SalesOrderError(404, 'PV_PEDIDO_NO_ENCONTRADO', 'El pedido no existe'))).toEqual({
      status: 404,
      body: { success: false, error: 'Not Found', message: 'El pedido no existe', code: 'PV_PEDIDO_NO_ENCONTRADO' },
    });
  });

  it.each([
    [pgError('23505', 'sales_order_lines_producto_uniq'), 'PV_PRODUCTO_REPETIDO', 'Este producto ya está en el pedido'],
    [pgError('23503', 'sales_orders_id_customer_fkey'), 'PV_CLIENTE_NO_ENCONTRADO', 'El cliente no existe'],
    [pgError('23503', 'sales_order_lines_id_product_fkey'), 'PV_PRODUCTO_NO_ENCONTRADO', 'Uno de los productos no existe'],
    [pgError('23514', 'sales_orders_fechas_check'), 'PV_FECHAS_INVALIDAS', 'La entrega no puede ser antes de la fecha del pedido'],
    [pgError('23514', 'sales_order_lines_cantidad_check'), 'PV_DATOS_INVALIDOS', 'Los datos del pedido no son válidos'],
    [pgError('22003'), 'PV_VALOR_FUERA_DE_RANGO', 'Un valor numérico del pedido excede el máximo permitido'],
    [pgError('22P02'), 'PV_VALIDACION', 'Uno de los valores enviados no es válido'],
  ])('respaldo %# -> 400 %s', (err, code, message) => {
    expect(mapSalesOrderError(err)).toEqual({
      status: 400,
      body: { success: false, error: 'Bad Request', message, code },
    });
  });

  it.each(AJUSTES_CHECKS)('CHECK %s -> 400 %s con mensaje en español', (constraint, code, message) => {
    expect(mapSalesOrderError(pgError('23514', constraint))).toEqual({
      status: 400,
      body: { success: false, error: 'Bad Request', message, code },
    });
  });

  it('devuelve null (-> 500 genérico) para lo desconocido o interno', () => {
    expect(mapSalesOrderError(new Error('boom'))).toBeNull();
    expect(mapSalesOrderError(pgError('XX000'))).toBeNull();
    expect(mapSalesOrderError(pvError('PV_DESCONOCIDO'))).toBeNull();
    // número duplicado: fallo interno del contador, no del usuario
    expect(mapSalesOrderError(pgError('23505', 'sales_orders_numero_uniq'))).toBeNull();
    expect(mapSalesOrderError(pgError('23505', 'otro_uniq'))).toBeNull();
    expect(mapSalesOrderError(pgError('23503', 'sales_orders_created_by_user_id_fkey'))).toBeNull();
  });
});
