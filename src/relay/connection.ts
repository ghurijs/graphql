// Relay connections with offset-based cursors (graphene-django compatible) over QuerySets and arrays.
import type { QuerySet } from '@ghuri/orm'
import { GraphQLError } from 'graphql'
import type { PermissionClassLike } from '../permissions'
import {
  type ArgsInput,
  FieldDef,
  type FieldsInput,
  type Resolver,
  registerType,
  type TypeMeta,
  type TypeRef,
} from '../types/definitions'
import type { FilterFieldsSpec } from '../types/modeltype'
import { base64Decode, base64Encode, isQuerySet } from '../utils'

const PREFIX = 'arrayconnection:'

/** Cursor of the item at `offset` (graphql-relay format). */
export function offsetToCursor(offset: number): string {
  return base64Encode(`${PREFIX}${offset}`)
}

/** Offset encoded in a cursor; throws a `BAD_USER_INPUT` GraphQL error when invalid. */
export function cursorToOffset(cursor: string): number {
  let decoded: string
  try {
    decoded = base64Decode(cursor)
  } catch {
    throw badInput(`Invalid cursor: ${JSON.stringify(cursor)}.`)
  }
  const n = Number(decoded.startsWith(PREFIX) ? decoded.slice(PREFIX.length) : Number.NaN)
  if (!Number.isInteger(n) || n < 0) throw badInput(`Invalid cursor: ${JSON.stringify(cursor)}.`)
  return n
}

function badInput(message: string): GraphQLError {
  return new GraphQLError(message, { extensions: { code: 'BAD_USER_INPUT' } })
}

export interface ConnectionArgs {
  first?: number | null
  after?: string | null
  last?: number | null
  before?: string | null
}

export interface PageInfo {
  hasNextPage: boolean
  hasPreviousPage: boolean
  startCursor: string | null
  endCursor: string | null
}

export interface Edge<T> {
  node: T
  cursor: string
}

/** What connection fields resolve to; the parent of `edges`, `pageInfo`, `totalCount` and custom fields. */
export interface ConnectionResult<T = any> {
  edges: Edge<T>[]
  pageInfo: PageInfo
  /** Total number of items (all pages); computed lazily. */
  totalCount: () => Promise<number>
  /** The full (filtered, ordered) source: a QuerySet or an array. */
  iterable: QuerySet<T> | readonly T[]
  /** Field arguments. */
  args: Record<string, unknown>
}

/**
 * Base class for custom connection types, set with `Meta.connectionClass` on a type or the `connectionClass`
 * option of `ConnectionField`:
 *
 * ```ts
 * class PostConnection extends Connection {
 *   static fields = { publishedCount: Field(Int, { resolve: (conn: ConnectionResult<Post>) => … }) }
 * }
 * ```
 */
export class Connection {
  static readonly __ghuriType: string = 'connection'
  static Meta?: TypeMeta
  static fields?: FieldsInput
}

export interface ConnectionFieldOptions<TParent = any> {
  /** Filters (`filter:` argument). Default: the node type's `Meta.filterFields`. `false` disables. */
  filterFields?: FilterFieldsSpec | false
  /** Fields allowed in `orderBy: ["-createdAt"]` (`'__all__'`: concrete fields). Default: `Meta.orderBy`. */
  orderBy?: readonly string[] | '__all__' | false
  /** Return a QuerySet (or array) to paginate. Default: `Model.objects.all()` through `getQueryset`. */
  resolve?: Resolver<TParent, any, unknown>
  /** Extra arguments passed to `resolve`. */
  args?: ArgsInput
  description?: string
  deprecationReason?: string
  /** Override `RELAY_CONNECTION_MAX_LIMIT` for this field. */
  maxLimit?: number
  /** Custom connection class. */
  connectionClass?: TypeRef
  permissionClasses?: PermissionClassLike[]
}

/**
 * A Relay connection field (graphene-django's `DjangoFilterConnectionField`):
 * `allPosts: ConnectionField(PostType, { orderBy: ['createdAt', 'title'] })` exposes
 * `allPosts(first, after, last, before, filter, orderBy) { edges { node cursor } pageInfo totalCount }`.
 */
export function ConnectionField<TParent = any>(
  type: TypeRef,
  options: ConnectionFieldOptions<TParent> = {},
): FieldDef {
  if (typeof type === 'function' && (type as any).__ghuriType) registerType(type as Function)
  const { args, resolve, description, deprecationReason, permissionClasses, ...conn } = options
  return new FieldDef(
    { __ghuriWrapper: 'connection', node: type, ...conn },
    { args, resolve, description, deprecationReason, permissionClasses, connectionOptions: conn },
  )
}

export interface PaginateOptions {
  maxLimit: number
  /** Connection type name for error messages. */
  name?: string
}

function checkLimit(arg: 'first' | 'last', value: number | null | undefined, opts: PaginateOptions): void {
  if (value === null || value === undefined) return
  if (!Number.isInteger(value) || value < 0) {
    throw badInput(`Argument "${arg}" must be a non-negative integer.`)
  }
  if (value > opts.maxLimit) {
    throw badInput(
      `Requesting ${value} records on the \`${opts.name ?? 'connection'}\` connection exceeds the \`${arg}\` limit of ${opts.maxLimit} records.`,
    )
  }
}

interface Window {
  start: number
  end: number | undefined
  /** `end` came from `first` only (fetch one extra row to know whether there is a next page). */
  probeNext: boolean
  /** `end` is bounded by a `before` cursor (a next page exists by definition). */
  boundedByBefore: boolean
}

async function computeWindow(
  args: ConnectionArgs,
  opts: PaginateOptions,
  count: () => Promise<number>,
): Promise<Window> {
  checkLimit('first', args.first, opts)
  checkLimit('last', args.last, opts)
  let first = args.first ?? undefined
  const last = args.last ?? undefined
  if (first === undefined && last === undefined) first = opts.maxLimit
  let start = args.after ? cursorToOffset(args.after) + 1 : 0
  let end: number | undefined = args.before ? cursorToOffset(args.before) : undefined
  const boundedByBefore = end !== undefined
  if (end !== undefined && end < start) end = start
  let probeNext = false
  if (last !== undefined && end === undefined) end = await count()
  if (first !== undefined) {
    const firstEnd = start + first
    if (end === undefined || firstEnd < end) {
      end = firstEnd
      probeNext = true
    }
  }
  if (last !== undefined && end !== undefined) start = Math.max(start, end - last)
  return { start, end, probeNext, boundedByBefore }
}

function makeResult<T>(
  items: T[],
  win: Window,
  hasMore: boolean | undefined,
  totalCount: () => Promise<number>,
  iterable: QuerySet<T> | readonly T[],
  args: Record<string, unknown>,
): ConnectionResult<T> {
  const edges = items.map((node, i) => ({ node, cursor: offsetToCursor(win.start + i) }))
  return {
    edges,
    pageInfo: {
      hasPreviousPage: win.start > 0,
      hasNextPage: hasMore ?? false,
      startCursor: edges[0]?.cursor ?? null,
      endCursor: edges[edges.length - 1]?.cursor ?? null,
    },
    totalCount,
    iterable,
    args,
  }
}

/** Paginate a QuerySet (`count()` only runs when needed: `last` without `before`, or `totalCount`). */
export async function paginateQuerySet<T>(
  qs: QuerySet<T>,
  args: ConnectionArgs & Record<string, unknown>,
  opts: PaginateOptions,
): Promise<ConnectionResult<T>> {
  let countPromise: Promise<number> | undefined
  const count = () => {
    countPromise ??= qs.count()
    return countPromise
  }
  const win = await computeWindow(args, opts, count)
  let items: T[]
  let hasMore: boolean
  if (win.end === undefined) {
    items = await qs.slice(win.start)
    hasMore = false
  } else if (win.end <= win.start) {
    items = []
    hasMore = win.boundedByBefore || win.start < (await count())
  } else if (win.probeNext) {
    const rows = await qs.slice(win.start, win.end + 1)
    hasMore = rows.length > win.end - win.start
    items = hasMore ? rows.slice(0, win.end - win.start) : rows
  } else {
    items = await qs.slice(win.start, win.end)
    hasMore = win.boundedByBefore || win.end < (await count())
  }
  return makeResult(items, win, hasMore, count, qs, args)
}

/** Paginate an in-memory list. */
export async function paginateArray<T>(
  list: readonly T[],
  args: ConnectionArgs & Record<string, unknown>,
  opts: PaginateOptions,
): Promise<ConnectionResult<T>> {
  const count = async () => list.length
  const win = await computeWindow(args, opts, count)
  const end = Math.min(win.end ?? list.length, list.length)
  const start = Math.min(win.start, list.length)
  const items = list.slice(start, Math.max(start, end))
  const hasMore = end < list.length
  return makeResult(items, { ...win, start }, hasMore, count, list, args)
}

/** Paginate whatever a connection resolver returned. */
export async function paginate<T>(
  source: QuerySet<T> | readonly T[] | Iterable<T> | null | undefined,
  args: ConnectionArgs & Record<string, unknown>,
  opts: PaginateOptions,
): Promise<ConnectionResult<T>> {
  if (isQuerySet(source)) return paginateQuerySet(source as QuerySet<T>, args, opts)
  const list =
    source === null || source === undefined
      ? []
      : Array.isArray(source)
        ? source
        : [...(source as Iterable<T>)]
  return paginateArray(list, args, opts)
}
