// Built-in scalar aliases and the custom scalars used for ORM fields.
import {
  GraphQLBoolean,
  GraphQLError,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLScalarType,
  GraphQLString,
} from 'graphql'
import { base64ToBytes, bytesToBase64 } from './utils'

function inspect(v: unknown): string {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : String(v)
  } catch {
    return typeof v
  }
}

// ---- built-ins (graphene's `graphene.String`, …) ----------------------------------------------
// Exported as `String`, `Int`, `Float`, `Boolean`, `ID` (aliases, no local bindings so the globals stay
// usable here). Importing `String` shadows the global in that module, like `graphene.String`.
export {
  GraphQLBoolean as Boolean,
  GraphQLFloat as Float,
  GraphQLID as ID,
  GraphQLInt as Int,
  GraphQLString as String,
}

// ---- custom scalars ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const ISO_TIME = /^\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$/
const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i
const DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/

function toDate(value: unknown, name: string): Date {
  const d = value instanceof Date ? value : new Date(value as string | number)
  if (Number.isNaN(d.getTime())) throw new GraphQLError(`${name} cannot represent value: ${inspect(value)}`)
  return d
}

/** ISO-8601 date-time (`2024-05-01T12:00:00.000Z`). Inputs are parsed to `Date`. */
export const DateTime: GraphQLScalarType<Date, string> = new GraphQLScalarType<Date, string>({
  name: 'DateTime',
  description: 'An ISO-8601 encoded date-time string, e.g. `2024-05-01T12:00:00.000Z`.',
  specifiedByURL: 'https://scalars.graphql.org/andimarek/date-time',
  coerceOutputValue(value) {
    if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString()
    return toDate(value, 'DateTime').toISOString()
  },
  coerceInputValue(value) {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
      throw new GraphQLError(`DateTime cannot represent value: ${inspect(value)}`)
    }
    return new Date(value)
  },
})

/** Calendar date (`YYYY-MM-DD`) — what `DateField` stores. Named `Date` in the schema. */
export const DateScalar: GraphQLScalarType<string, string> = new GraphQLScalarType<string, string>({
  name: 'Date',
  description: 'An ISO-8601 calendar date, e.g. `2024-05-01`.',
  coerceOutputValue(value) {
    if (typeof value === 'string' && ISO_DATE.test(value)) return value
    if (typeof value === 'string' && ISO_DATE.test(value.slice(0, 10))) return value.slice(0, 10)
    return toDate(value, 'Date').toISOString().slice(0, 10)
  },
  coerceInputValue(value) {
    if (typeof value !== 'string' || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
      throw new GraphQLError(`Date cannot represent value: ${inspect(value)}`)
    }
    return value
  },
})

/** Time of day (`HH:MM[:SS[.ffffff]]`). */
export const Time: GraphQLScalarType<string, string> = new GraphQLScalarType<string, string>({
  name: 'Time',
  description: 'An ISO-8601 time of day, e.g. `13:45:00`.',
  coerceOutputValue(value) {
    if (typeof value === 'string' && ISO_TIME.test(value)) return value
    if (value instanceof Date) return value.toISOString().slice(11, 19)
    throw new GraphQLError(`Time cannot represent value: ${inspect(value)}`)
  },
  coerceInputValue(value) {
    if (typeof value !== 'string' || !ISO_TIME.test(value)) {
      throw new GraphQLError(`Time cannot represent value: ${inspect(value)}`)
    }
    return value
  },
})

/** Arbitrary-precision decimal, transported as a string (`DecimalField` values). */
export const Decimal: GraphQLScalarType<string, string> = new GraphQLScalarType<string, string>({
  name: 'Decimal',
  description: 'A decimal number transported as a string to keep its precision, e.g. `"12.50"`.',
  coerceOutputValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'bigint') return value.toString()
    if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) return value.trim()
    if (value && typeof value === 'object' && typeof (value as any).toFixed === 'function')
      return String(value)
    throw new GraphQLError(`Decimal cannot represent value: ${inspect(value)}`)
  },
  coerceInputValue(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (typeof value === 'string' && DECIMAL_RE.test(value.trim())) return value.trim()
    throw new GraphQLError(`Decimal cannot represent value: ${inspect(value)}`)
  },
})

/** Any JSON value (graphene's `GenericScalar`). Used for `JSONField`. Named `JSON` in the schema. */
export const JSONScalar: GraphQLScalarType<unknown, unknown> = new GraphQLScalarType<unknown, unknown>({
  name: 'JSON',
  description: 'Any JSON value (object, array, string, number, boolean or null).',
  specifiedByURL: 'https://www.rfc-editor.org/rfc/rfc8259',
  coerceOutputValue(value) {
    if (typeof value === 'bigint')
      return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    return value
  },
  coerceInputValue(value) {
    return value
  },
})

/** RFC 4122 UUID string. */
export const UUID: GraphQLScalarType<string, string> = new GraphQLScalarType<string, string>({
  name: 'UUID',
  description: 'A UUID string, e.g. `"0b6c1f6e-9a4c-4f3e-8a35-1d1f8d1b8c3a"`.',
  coerceOutputValue(value) {
    if (typeof value === 'string' && UUID_RE.test(value)) return value.toLowerCase()
    throw new GraphQLError(`UUID cannot represent value: ${inspect(value)}`)
  },
  coerceInputValue(value) {
    if (typeof value !== 'string' || !UUID_RE.test(value)) {
      throw new GraphQLError(`UUID cannot represent value: ${inspect(value)}`)
    }
    return value.toLowerCase()
  },
})

function bigIntOut(value: unknown, name: string): number | string {
  if (typeof value === 'number' && Number.isInteger(value)) {
    return Number.isSafeInteger(value) ? value : BigInt(value).toString()
  }
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (typeof value === 'string' && /^[+-]?\d+$/.test(value)) {
    const n = Number(value)
    return Number.isSafeInteger(n) ? n : BigInt(value).toString()
  }
  throw new GraphQLError(`${name} cannot represent value: ${inspect(value)}`)
}

/**
 * 64-bit integer (`BigIntegerField`). Serialized as a JSON number when it is a safe integer, otherwise as a
 * string so no precision is lost. Accepts numbers and numeric strings.
 */
export const BigIntScalar: GraphQLScalarType<number | string, number | string> = new GraphQLScalarType<
  number | string,
  number | string
>({
  name: 'BigInt',
  description:
    'A 64-bit integer. Safe integers are numbers; larger values are strings so no precision is lost.',
  coerceOutputValue: (value) => bigIntOut(value, 'BigInt'),
  coerceInputValue: (value) => bigIntOut(value, 'BigInt'),
})

/** Binary data as base64 (`BinaryField`). Inputs become `Uint8Array`. */
export const Base64: GraphQLScalarType<Uint8Array, string> = new GraphQLScalarType<Uint8Array, string>({
  name: 'Base64',
  description: 'Binary data encoded as base64.',
  coerceOutputValue(value) {
    if (value instanceof Uint8Array) return bytesToBase64(value)
    if (value instanceof ArrayBuffer) return bytesToBase64(new Uint8Array(value))
    if (typeof value === 'string') return value
    throw new GraphQLError(`Base64 cannot represent value: ${inspect(value)}`)
  },
  coerceInputValue(value) {
    if (typeof value !== 'string') throw new GraphQLError(`Base64 cannot represent value: ${inspect(value)}`)
    try {
      return base64ToBytes(value)
    } catch {
      throw new GraphQLError(`Base64 cannot represent value: ${inspect(value)}`)
    }
  },
})

/** Alias of `JSONScalar` (graphene's name). */
export const GenericScalar: GraphQLScalarType<unknown, unknown> = JSONScalar

/** Every custom scalar, by schema name. */
export const scalars = {
  DateTime,
  Date: DateScalar,
  Time,
  Decimal,
  JSON: JSONScalar,
  UUID,
  BigInt: BigIntScalar,
  Base64,
} as const
