// Permission plumbing shared with @ghuri/rest (structural: no import of rest) and resolver decorators.
import { PermissionDenied, type RequestUser } from '@ghuri/core'
import type { Context } from 'hono'
import { DEFAULT_PERMISSION_MESSAGE, NotAuthenticated } from './errors'
import type { ResolveInfo } from './types/definitions'
import type { MaybePromise } from './utils'

/** A REST permission class (`IsAuthenticated`, `ModelPermissions`, your own `BasePermission` subclass…). */
export type PermissionClassLike = new () => {
  hasPermission?(request: any, view: any): MaybePromise<boolean>
  hasObjectPermission?(request: any, view: any, obj: any): MaybePromise<boolean>
  message?: string | Record<string, unknown>
  code?: string
}

export interface PermissionRequestInit {
  c?: Context
  user: RequestUser
  auth?: unknown
  method: string
  data?: unknown
}

/**
 * The `request` REST permission classes receive when used from GraphQL. It quacks like `APIRequest` where
 * permission classes look: `user`, `auth`, `method` (`GET` for queries, `POST` for create mutations,
 * `PATCH` for updates, `DELETE` for deletes), `data` (mutation input), `query`, `header()`.
 */
export class PermissionRequest {
  readonly c?: Context
  readonly user: RequestUser
  readonly auth: unknown
  readonly method: string
  readonly data: unknown
  /** Marker for permission classes that want to special-case GraphQL. */
  readonly isGraphQL = true

  constructor(init: PermissionRequestInit) {
    this.c = init.c
    this.user = init.user
    this.auth = init.auth
    this.method = init.method.toUpperCase()
    this.data = init.data ?? {}
  }

  /** Same request with another method / data. */
  withMethod(method: string, data?: unknown): PermissionRequest {
    return new PermissionRequest({ c: this.c, user: this.user, auth: this.auth, method, data })
  }

  get raw(): Request | undefined {
    return this.c?.req.raw
  }

  get path(): string {
    return this.c?.req.path ?? '/graphql'
  }

  get url(): string {
    return this.c?.req.url ?? ''
  }

  get headers(): Headers {
    return this.c?.req.raw.headers ?? new Headers()
  }

  header(name: string): string | undefined {
    return this.c?.req.header(name)
  }

  get queryParams(): URLSearchParams {
    return this.c ? new URL(this.c.req.url).searchParams : new URLSearchParams()
  }

  get query(): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [k, v] of this.queryParams) if (!(k in out)) out[k] = v
    return out
  }
}

/** The `view` permission classes receive: describes what is being resolved. */
export interface PermissionView {
  /** `'query'`, `'create'`, `'update'`, `'delete'` or a custom mutation name. */
  action: string
  info?: ResolveInfo
  /** Model involved, when there is one (`ModelPermissions` needs it through `getQueryset()`). */
  model?: any
  queryset?: any
  getQueryset?(): any
  /** Field arguments / mutation input. */
  kwargs?: Record<string, unknown>
  [key: string]: unknown
}

function messageOf(perm: { message?: unknown }): string | undefined {
  const m = perm.message
  if (typeof m === 'string') return m
  if (m && typeof m === 'object') return JSON.stringify(m)
  return undefined
}

function denied(perm: { message?: unknown }, request: PermissionRequest): Error {
  if (!request.user?.isAuthenticated) return new NotAuthenticated()
  return new PermissionDenied(messageOf(perm) ?? DEFAULT_PERMISSION_MESSAGE)
}

/** Run `hasPermission` of every class; throws `NotAuthenticated` / `PermissionDenied` on the first refusal. */
export async function checkPermissions(
  classes: readonly PermissionClassLike[] | undefined,
  request: PermissionRequest,
  view: PermissionView,
): Promise<void> {
  for (const Cls of classes ?? []) {
    const perm = new Cls()
    if (perm.hasPermission && !(await perm.hasPermission(request, view))) throw denied(perm, request)
  }
}

/** Run `hasObjectPermission` of every class; throws on the first refusal. */
export async function checkObjectPermissions(
  classes: readonly PermissionClassLike[] | undefined,
  request: PermissionRequest,
  view: PermissionView,
  obj: unknown,
): Promise<void> {
  for (const Cls of classes ?? []) {
    const perm = new Cls()
    if (perm.hasObjectPermission && !(await perm.hasObjectPermission(request, view, obj))) {
      throw denied(perm, request)
    }
  }
}

/** Like `checkObjectPermissions` but returns a boolean (errors other than denials still throw). */
export async function hasObjectPermissions(
  classes: readonly PermissionClassLike[] | undefined,
  request: PermissionRequest,
  view: PermissionView,
  obj: unknown,
): Promise<boolean> {
  try {
    await checkObjectPermissions(classes, request, view, obj)
    return true
  } catch (err) {
    if (err instanceof PermissionDenied) return false
    // REST Http404 from ObjectPermissions (object not readable) → hidden
    if ((err as any)?.status === 404 || (err as any)?.statusCode === 404) return false
    throw err
  }
}

// ---- resolver decorators -------------------------------------------------------------------------------

type AnyResolver = (...args: any[]) => any

/** Find the resolve info among resolver arguments (`(parent, args, info)`). */
function findInfo(args: unknown[]): ResolveInfo | undefined {
  for (let i = args.length - 1; i >= 0; i--) {
    const a = args[i] as any
    if (a && typeof a === 'object' && a.context && a.fieldName !== undefined) return a as ResolveInfo
  }
  return undefined
}

function userOf(args: unknown[]): RequestUser | undefined {
  return findInfo(args)?.context?.user
}

export interface UserTestOptions {
  /** Message of the `PermissionDenied` error. */
  message?: string
}

/** A resolver wrapper that also works as a TC39 method decorator (`@loginRequired static mutate(…)`). */
export type ResolverDecorator = <F extends AnyResolver>(fn: F, context?: unknown) => F

/**
 * Build a resolver decorator from a predicate (Django's `user_passes_test`). Anonymous users who fail the test
 * get `NotAuthenticated` (code `UNAUTHENTICATED`), others `PermissionDenied` (code `PERMISSION_DENIED`).
 */
export function userPassesTest(
  test: (user: RequestUser, info: ResolveInfo | undefined) => MaybePromise<boolean>,
  opts: UserTestOptions = {},
): ResolverDecorator {
  return <F extends AnyResolver>(fn: F): F => {
    const wrapped = async function (this: unknown, ...args: unknown[]) {
      const info = findInfo(args)
      const user = userOf(args)
      if (!user || !(await test(user, info))) {
        if (!user?.isAuthenticated) throw new NotAuthenticated()
        throw new PermissionDenied(opts.message ?? DEFAULT_PERMISSION_MESSAGE)
      }
      return fn.apply(this, args)
    }
    Object.defineProperty(wrapped, 'name', { value: fn.name })
    return wrapped as unknown as F
  }
}

/** Only authenticated (and active) users may run the resolver. */
export const loginRequired: ResolverDecorator = userPassesTest(
  (u) => !!u.isAuthenticated && u.isActive !== false,
)

/** Only active staff users (`isStaff`). */
export const staffMemberRequired: ResolverDecorator = userPassesTest(
  (u) => !!u.isAuthenticated && u.isActive !== false && !!u.isStaff,
)

/** Only active superusers. */
export const superuserRequired: ResolverDecorator = userPassesTest(
  (u) => !!u.isAuthenticated && u.isActive !== false && !!u.isSuperuser,
)

/**
 * Require Django-style permissions: `permissionRequired('blog.add_post')(resolver)` or an array
 * (all required). Works as a decorator too.
 */
export function permissionRequired(
  perm: string | readonly string[],
  opts: UserTestOptions = {},
): ResolverDecorator {
  const perms = typeof perm === 'string' ? [perm] : [...perm]
  return userPassesTest(async (u) => {
    if (!u.isAuthenticated || u.isActive === false) return false
    if (typeof u.hasPerms === 'function') return u.hasPerms(perms)
    for (const p of perms) if (!(await u.hasPerm(p))) return false
    return true
  }, opts)
}
