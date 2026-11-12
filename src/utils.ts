// Internal helpers.

export type MaybePromise<T> = T | Promise<T>

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s
}

export function lowerFirst(s: string): string {
  return s ? s[0].toLowerCase() + s.slice(1) : s
}

/** `author__username` → `authorUsername`, `created_at` → `createdAt`. */
export function camelize(s: string): string {
  return s.replace(/_+([a-zA-Z0-9])/g, (_m, c: string) => c.toUpperCase())
}

export function isPlainObject(v: unknown): v is Record<string, any> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

export function isPromiseLike(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function'
}

/** Is `v` an ORM QuerySet (structural check, no import)? */
export function isQuerySet(v: unknown): v is import('@ghuri/orm').QuerySet<any> {
  return !!v && typeof v === 'object' && (v as any)._isQuerySet === true
}

/** Is `v` a Manager / related manager (has `getQueryset()` and `all()`)? */
export function isManager(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as any).getQueryset === 'function' &&
    typeof (v as any).all === 'function' &&
    !isQuerySet(v)
  )
}

/** Is `v` a model instance? */
export function isModelInstance(v: unknown): boolean {
  return (
    !!v &&
    typeof v === 'object' &&
    '_state' in (v as object) &&
    typeof (v as any).constructor?._meta === 'object'
  )
}

/** Is `sub` the class `base` or a subclass of it? */
export function isSubclassOf(sub: unknown, base: Function): boolean {
  if (typeof sub !== 'function') return false
  let c: any = sub
  while (c) {
    if (c === base) return true
    c = Object.getPrototypeOf(c)
  }
  return false
}

function utf8ToBinary(s: string): string {
  const bytes = new TextEncoder().encode(s)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return out
}

function binaryToUtf8(s: string): string {
  const bytes = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** UTF-8 safe base64 (standard alphabet, padded — what graphql-relay / graphene use). */
export function base64Encode(s: string): string {
  return btoa(utf8ToBinary(s))
}

/** Inverse of `base64Encode`; throws on invalid input. */
export function base64Decode(s: string): string {
  return binaryToUtf8(atob(s))
}

export function bytesToBase64(bytes: Uint8Array): string {
  let out = ''
  for (const b of bytes) out += String.fromCharCode(b)
  return btoa(out)
}

export function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** String key for ids coming from different drivers (number / bigint / string). */
export function idKey(v: unknown): string {
  return v === null || v === undefined ? '' : String(v)
}

/** Stable JSON for cache keys (sorted object keys). */
export function stableStringify(v: unknown): string {
  if (v === undefined) return 'undefined'
  if (v === null || typeof v !== 'object') return typeof v === 'bigint' ? `${v}n` : JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v as object).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as any)[k])}`).join(',')}}`
}
