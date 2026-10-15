import { describe, it, expect } from 'vitest';
import { isUniqueViolation, isForeignKeyViolation, isCheckViolation, constraintName } from './pg-errors';

describe('isUniqueViolation', () => {
  it('returns true for a Postgres unique_violation error (code 23505)', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });
});

describe('isForeignKeyViolation', () => {
  it('returns true for a Postgres foreign_key_violation error (code 23503)', () => {
    expect(isForeignKeyViolation({ code: '23503' })).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isForeignKeyViolation({ code: '23505' })).toBe(false);
    expect(isForeignKeyViolation(new Error('boom'))).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
  });
});

describe('isCheckViolation', () => {
  it('returns true for a Postgres check_violation error (code 23514)', () => {
    expect(isCheckViolation({ code: '23514' })).toBe(true);
  });

  it('returns false for other errors', () => {
    expect(isCheckViolation({ code: '23505' })).toBe(false);
    expect(isCheckViolation(new Error('boom'))).toBe(false);
    expect(isCheckViolation(null)).toBe(false);
  });
});

describe('constraintName', () => {
  it('returns the violated constraint reported by pg', () => {
    expect(constraintName({ code: '23505', constraint: 'sales_order_lines_producto_uniq' })).toBe('sales_order_lines_producto_uniq');
  });

  it('returns undefined when the error carries no constraint', () => {
    expect(constraintName(new Error('boom'))).toBeUndefined();
    expect(constraintName(null)).toBeUndefined();
  });
});
