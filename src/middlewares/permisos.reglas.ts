import type { Regla } from '../lib/permisos';

// Qué permiso del equipo pide cada ruta de este backend (ver src/lib/permisos.ts).
// La primera que coincide gana; una ruta sin regla es solo del dueño.
export const REGLAS: readonly Regla[] = [
  { ruta: /\/sales-orders\/quick-sale/, modulo: 'caja_rapida' },
  { ruta: /\/sales-orders\/delivery-routes/, metodos: ['GET'], modulo: 'rutas_entrega' },
  { ruta: /\/sales-orders\/delivery-routes/, modulo: 'rutas_entrega', accion: 'editar' },
  // Despachar y entregar: el domiciliario (rutas de entrega) o quien maneja los pedidos.
  { ruta: /\/sales-orders\/\d+\/(ship|deliver)\/?$/, modulo: ['rutas_entrega', 'pedidos_venta'], accion: 'editar' },
  { ruta: /\/sales-orders\/\d+\/(prepare|ready)\/?$/, modulo: 'pedidos_venta', accion: 'editar' },
  { ruta: /\/sales-orders\/\d+\/returns\/\d+\/resolve\/?$/, modulo: 'pedidos_venta', accion: 'editar' },
  // Registrar un pago: también desde la caja rápida.
  { ruta: /\/sales-orders\/\d+\/payments\/?$/, metodos: ['POST'], modulo: ['pedidos_venta', 'caja_rapida'] },
  { ruta: /\/(sales-orders|sellers)/, metodos: ['GET'], modulo: ['pedidos_venta', 'caja_rapida', 'rutas_entrega'] },
  { ruta: /\/(sales-orders|sellers)/, modulo: 'pedidos_venta' },
];
