const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const CHECK_VIOLATION = '23514';
const NUMERIC_VALUE_OUT_OF_RANGE = '22003';
// e.g. a value that is not a member of the sales_order_status enum.
const INVALID_TEXT_REPRESENTATION = '22P02';
// plpgsql RAISE EXCEPTION without an explicit errcode (and so_raise's errcode).
const RAISE_EXCEPTION = 'P0001';

export const errorCode = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'code' in err ? (err as { code?: unknown }).code as string : undefined;

export const isUniqueViolation = (err: unknown): boolean => errorCode(err) === UNIQUE_VIOLATION;

export const isForeignKeyViolation = (err: unknown): boolean => errorCode(err) === FOREIGN_KEY_VIOLATION;

export const isCheckViolation = (err: unknown): boolean => errorCode(err) === CHECK_VIOLATION;

export const isNumericOutOfRange = (err: unknown): boolean => errorCode(err) === NUMERIC_VALUE_OUT_OF_RANGE;

export const isInvalidTextRepresentation = (err: unknown): boolean => errorCode(err) === INVALID_TEXT_REPRESENTATION;

export const isRaiseException = (err: unknown): boolean => errorCode(err) === RAISE_EXCEPTION;

export const constraintName = (err: unknown): string | undefined =>
  typeof err === 'object' && err !== null && 'constraint' in err
    ? (err as { constraint?: unknown }).constraint as string
    : undefined;
