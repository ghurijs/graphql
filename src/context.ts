import { anonymousUser, type RequestUser } from '@ghuri/core'
import DataLoader from 'dataloader'
import type { Context } from 'hono'
import { PermissionRequest } from './permissions'

/**
 * Per-request DataLoaders, memoized by key. Relation fields use it automatically; custom resolvers can too:
 *
 * ```ts
 * const loader = info.context.loaders.get('authorsById', async (ids) => …)
 * ```
 */
export class LoaderRegistry {
  private readonly loaders = new Map<string, DataLoader<any, any, any>>()

  get<K, V, C = K>(
    key: string,
    batch: DataLoader.BatchLoadFn<K, V>,
    options?: DataLoader.Options<K, V, C>,
  ): DataLoader<K, V, C> {
    let loader = this.loaders.get(key)
    if (!loader) {
      loader = new DataLoader<K, V, C>(batch, options)
      this.loaders.set(key, loader)
    }
    return loader as DataLoader<K, V, C>
  }

  has(key: string): boolean {
    return this.loaders.has(key)
  }

  /** Drop every loader (e.g. after a mutation changed data). */
  clear(): void {
    this.loaders.clear()
  }
}

/** `info.context` of every resolver. */
export interface GraphQLContext {
  /** The Hono context (undefined when executing outside HTTP, e.g. `schema.execute()` in a script). */
  c?: Context
  /** The authenticated user (`AnonymousUser` when nobody is logged in). */
  user: RequestUser
  /** What the successful authentication class returned as credentials (token, JWT payload…). */
  auth?: unknown
  /** Per-request DataLoaders. */
  loaders: LoaderRegistry
  /** Request object handed to REST permission classes (`request.user`, `request.method`). */
  request: PermissionRequest
  /** Free-form per-request storage. */
  state: Map<unknown, unknown>
  [key: string]: unknown
}

export interface CreateContextOptions {
  c?: Context
  user?: RequestUser
  auth?: unknown
  /** Extra keys merged into the context. */
  extra?: Record<string, unknown>
}

/** Build a GraphQL context (done by `GraphQLView` and `schema.execute()` for you). */
export function createGraphQLContext(opts: CreateContextOptions = {}): GraphQLContext {
  const user = opts.user ?? anonymousUser
  const ctx: GraphQLContext = {
    c: opts.c,
    user,
    auth: opts.auth,
    loaders: new LoaderRegistry(),
    request: new PermissionRequest({ c: opts.c, user, auth: opts.auth, method: 'GET' }),
    state: new Map(),
    ...(opts.extra ?? {}),
  }
  return ctx
}

/** Is `v` a context created by `createGraphQLContext`? */
export function isGraphQLContext(v: unknown): v is GraphQLContext {
  return !!v && typeof v === 'object' && (v as any).loaders instanceof LoaderRegistry
}
