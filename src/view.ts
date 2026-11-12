// `GraphQLView`: GraphQL over HTTP (https://graphql.github.io/graphql-over-http/) on a core `View`.
import {
  anonymousUser,
  enforceCsrf,
  getCsrfToken,
  getUser,
  ImproperlyConfigured,
  type RequestUser,
  setCsrfCookieIfNeeded,
  setUser,
  View,
} from '@ghuri/core'
import {
  type DocumentNode,
  execute,
  type FormattedExecutionResult,
  GraphQLError,
  type GraphQLFormattedError,
  type GraphQLSchema,
  getOperationAST,
  NoSchemaIntrospectionCustomRule,
  parse,
  specifiedRules,
  type ValidationRule,
  validate,
} from 'graphql'
import type { Context } from 'hono'
import { createGraphQLContext, type GraphQLContext } from './context'
import { formatError } from './errors'
import { renderGraphiQL } from './graphiql'
import { PermissionRequest } from './permissions'
import { toGraphQLSchema } from './schema'
import { type GraphQLSettings, graphqlSettings, type SchemaLike } from './settings'
import type { MaybePromise } from './utils'
import { complexityLimit, depthLimit } from './validation'

export const GRAPHQL_RESPONSE_MEDIA_TYPE = 'application/graphql-response+json'
export const JSON_MEDIA_TYPE = 'application/json'

/** An authentication class (`SessionAuthentication`, `TokenAuthentication`, `JWTAuthentication`, …). */
export type GraphQLAuthenticationClass = new () => {
  authenticate(c: Context): Promise<[RequestUser, unknown] | null>
  authenticateHeader?(c: Context): string | undefined
}

/**
 * A throttle class: `AnonRateThrottle`, `UserRateThrottle`, `ScopedRateThrottle` or your own `BaseThrottle` /
 * `SimpleRateThrottle` subclass from `@ghuri/rest`. `allowRequest(request, view)` receives a `PermissionRequest`
 * (`user`, `auth`, `method`, `header()`, `c`) and the view.
 */
export type GraphQLThrottleClass = new () => GraphQLThrottle

/** A throttle instance (DRF's `BaseThrottle` interface). */
export interface GraphQLThrottle {
  allowRequest(request: any, view: any): MaybePromise<boolean>
  /** Seconds until the next request is allowed, or null when unknown. */
  wait?(): number | null
}

/** Default message of a throttled request (DRF's `Throttled`). */
export const THROTTLED_MESSAGE = 'Request was throttled.'

/** `Request was throttled. Expected available in N seconds.` (DRF's `Throttled` detail). */
export function throttledMessage(wait: number | null, detail: string = THROTTLED_MESSAGE): string {
  if (wait === null) return detail
  return `${detail} Expected available in ${wait} second${wait === 1 ? '' : 's'}.`
}

/** The parameters of one GraphQL request. */
export interface GraphQLParams {
  query?: unknown
  variables?: unknown
  operationName?: unknown
  extensions?: unknown
  /** Persisted document id (`documentId` / `id`). */
  documentId?: unknown
  id?: unknown
}

export interface PersistedQueryLookup {
  /** `documentId` / `id` of the request. */
  id?: string
  /** `extensions.persistedQuery.sha256Hash` (Apollo APQ style). */
  sha256Hash?: string
  /** The query text when the client also sent it (APQ registration). */
  query?: string
  extensions?: Record<string, unknown>
}

/** Returns the stored query text, or null when unknown. */
export type PersistedQueryHook = (
  lookup: PersistedQueryLookup,
  c: Context,
) => MaybePromise<string | null | undefined>

class HttpProblem extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly headers: Record<string, string> = {},
    readonly code?: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString()
  return v
}

interface AcceptEntry {
  type: string
  q: number
  i: number
}

function parseAccept(header: string): AcceptEntry[] {
  return header
    .split(',')
    .map((part, i) => {
      const [type, ...params] = part.trim().split(';')
      let q = 1
      for (const p of params) {
        const [k, v] = p.trim().split('=')
        if (k === 'q') q = Number(v)
      }
      return { type: type.trim().toLowerCase(), q: Number.isNaN(q) ? 0 : q, i }
    })
    .filter((e) => e.type && e.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
}

/** Response media type for an `Accept` header (null → 406). Missing header → `application/json` (spec legacy rule). */
export function negotiateMediaType(accept: string | undefined): string | null {
  if (!accept?.trim()) return JSON_MEDIA_TYPE
  for (const e of parseAccept(accept)) {
    if (e.type === GRAPHQL_RESPONSE_MEDIA_TYPE) return GRAPHQL_RESPONSE_MEDIA_TYPE
    if (e.type === JSON_MEDIA_TYPE) return JSON_MEDIA_TYPE
    if (e.type === '*/*' || e.type === 'application/*') return GRAPHQL_RESPONSE_MEDIA_TYPE
  }
  return null
}

function prefersHtml(accept: string | undefined): boolean {
  if (!accept) return false
  for (const e of parseAccept(accept)) {
    if (e.type === 'text/html') return true
    if (e.type === GRAPHQL_RESPONSE_MEDIA_TYPE || e.type === JSON_MEDIA_TYPE) return false
  }
  return false
}

interface AuthResult {
  user: RequestUser
  auth: unknown
}

interface OneResult {
  status: number
  body: FormattedExecutionResult
  headers?: Record<string, string>
}

/**
 * Serve a schema over HTTP (graphene-django's `GraphQLView`):
 *
 * ```ts
 * path('graphql/', GraphQLView.asView({ schema, graphiql: true }))
 * ```
 * - `GET` (queries only; mutations get 405) and `POST` with `application/json`, `application/graphql` or a form.
 * - Responses use `application/graphql-response+json` when accepted (400 for invalid documents / variables),
 *   otherwise `application/json` (200 for every well-formed request), per the GraphQL-over-HTTP spec.
 * - GraphiQL for browsers when `graphiql` (or `GRAPHQL.GRAPHIQL`, default `DEBUG`) is on.
 * - `authenticationClasses` from `@ghuri/auth/rest` (`SessionAuthentication` enforces CSRF; token / JWT
 *   requests are exempt). Without them the core request user is used and CSRF is enforced for authenticated
 *   POSTs (the view itself is exempt from `CsrfMiddleware` so token clients work).
 * - `throttleClasses` from `@ghuri/rest` (`AnonRateThrottle`, `UserRateThrottle`, `ScopedRateThrottle` with
 *   `throttleScope`, …; default `GRAPHQL.DEFAULT_THROTTLE_CLASSES`): checked once per HTTP request (a batch counts
 *   once) after authentication and before execution; throttled requests get 429 + `Retry-After` and
 *   `extensions.code: "THROTTLED"`. The GraphiQL page itself is never throttled.
 * - `maxDepth`, `maxComplexity`, `introspection`, `batch` (default from `GRAPHQL` settings).
 * - Unexpected errors are masked as "Internal server error" unless `DEBUG`.
 */
export class GraphQLView extends View {
  static override csrfExempt = true

  /** The schema (default `GRAPHQL.SCHEMA`). */
  schema?: SchemaLike | (() => SchemaLike)
  /** Serve GraphiQL to browsers (default `GRAPHQL.GRAPHIQL`, then `DEBUG`). */
  graphiql?: boolean
  /** Accept arrays of operations (default `GRAPHQL.BATCH`). */
  batch?: boolean
  /** Authentication classes (default `GRAPHQL.AUTHENTICATION_CLASSES`, else the core request user). */
  authenticationClasses?: GraphQLAuthenticationClass[]
  /**
   * Throttle classes (default `GRAPHQL.DEFAULT_THROTTLE_CLASSES`, else none). Rates come from
   * `REST_FRAMEWORK.DEFAULT_THROTTLE_RATES`, history from the `REST_FRAMEWORK.THROTTLE_CACHE` cache.
   */
  throttleClasses?: GraphQLThrottleClass[]
  /** Scope for `ScopedRateThrottle` (a key of `REST_FRAMEWORK.DEFAULT_THROTTLE_RATES`). */
  throttleScope?: string
  maxDepth?: number
  maxComplexity?: number
  /** Allow introspection (default `GRAPHQL.INTROSPECTION`, true). */
  introspection?: boolean
  /** Extra validation rules. */
  validationRules?: ValidationRule[]
  rootValue?: unknown
  /** Persisted queries: resolve `documentId` / APQ hashes to query text. */
  persistedQueries?: PersistedQueryHook
  /** Only accept persisted queries (requires `persistedQueries`). */
  persistedQueriesOnly?: boolean
  /** Add keys to the GraphQL context. */
  getContext?: (c: Context, context: GraphQLContext) => MaybePromise<Record<string, unknown> | undefined>
  /** Show error stacks (default `DEBUG`). */
  debug?: boolean

  override async get(c: Context): Promise<Response> {
    return this.handle(c)
  }

  override async post(c: Context): Promise<Response> {
    return this.handle(c)
  }

  resolveSchema(settings: GraphQLSettings): GraphQLSchema {
    const s = this.schema ?? settings.SCHEMA
    if (!s)
      throw new ImproperlyConfigured(
        'GraphQLView needs a schema: GraphQLView.asView({ schema }) or GRAPHQL.SCHEMA.',
      )
    return toGraphQLSchema(s)
  }

  protected respond(
    c: Context,
    status: number,
    body: unknown,
    mediaType: string,
    headers: Record<string, string> = {},
  ): Response {
    return c.body(JSON.stringify(body, jsonReplacer), status as any, {
      'Content-Type': `${mediaType}; charset=utf-8`,
      ...headers,
    })
  }

  protected problem(c: Context, p: HttpProblem, mediaType: string): Response {
    const error: GraphQLFormattedError = p.code
      ? { message: p.message, extensions: { code: p.code, ...p.extensions } }
      : { message: p.message }
    return this.respond(c, p.status, { errors: [error] }, mediaType, p.headers)
  }

  async handle(c: Context): Promise<Response> {
    const settings = graphqlSettings(c)
    const schema = this.resolveSchema(settings)
    const method = c.req.method.toUpperCase()
    const accept = c.req.header('accept')
    const url = new URL(c.req.url)
    const graphiql = this.graphiql ?? settings.GRAPHIQL ?? settings.DEBUG
    if (
      (method === 'GET' || method === 'HEAD') &&
      graphiql &&
      prefersHtml(accept) &&
      !url.searchParams.has('raw')
    ) {
      return this.renderGraphiQL(c)
    }
    const mediaType = negotiateMediaType(accept)
    if (!mediaType) {
      return this.respond(
        c,
        406,
        {
          errors: [{ message: `Not acceptable: use ${GRAPHQL_RESPONSE_MEDIA_TYPE} or ${JSON_MEDIA_TYPE}.` }],
        },
        JSON_MEDIA_TYPE,
      )
    }
    let params: GraphQLParams | GraphQLParams[]
    try {
      params = await this.parseRequest(c, method, url)
    } catch (err) {
      if (err instanceof HttpProblem) return this.problem(c, err, mediaType)
      throw err
    }
    const batch = Array.isArray(params)
    if (batch && !(this.batch ?? settings.BATCH)) {
      return this.problem(c, new HttpProblem(400, 'Batch requests are not enabled.'), mediaType)
    }
    if (batch && !(params as GraphQLParams[]).length) {
      return this.problem(c, new HttpProblem(400, 'Received an empty list in the batch request.'), mediaType)
    }
    let auth: AuthResult
    try {
      auth = await this.authenticate(c, method, settings)
    } catch (err) {
      const p = this.authProblem(err)
      if (p) return this.problem(c, p, mediaType)
      throw err
    }
    try {
      await this.checkThrottles(
        new PermissionRequest({ c, user: auth.user, auth: auth.auth, method }),
        settings,
      )
    } catch (err) {
      const p = err instanceof HttpProblem ? err : this.throttleProblem(err)
      if (p) return this.problem(c, p, mediaType)
      throw err
    }
    const list = batch ? (params as GraphQLParams[]) : [params as GraphQLParams]
    const results: OneResult[] = []
    for (const p of list) {
      try {
        results.push(await this.executeOne(c, schema, p, auth, mediaType, method, settings))
      } catch (err) {
        if (!(err instanceof HttpProblem)) throw err
        if (!batch) return this.problem(c, err, mediaType)
        results.push({
          status: err.status,
          body: { errors: [{ message: err.message }] },
          headers: err.headers,
        })
      }
    }
    if (!batch) return this.respond(c, results[0].status, results[0].body, mediaType, results[0].headers)
    return this.respond(
      c,
      200,
      results.map((r) => r.body),
      mediaType,
    )
  }

  // ---- request parsing ------------------------------------------------------------------------------------

  protected async parseRequest(
    c: Context,
    method: string,
    url: URL,
  ): Promise<GraphQLParams | GraphQLParams[]> {
    if (method === 'GET' || method === 'HEAD') {
      const q = url.searchParams
      return {
        query: q.get('query') ?? undefined,
        variables: q.get('variables') ?? undefined,
        operationName: q.get('operationName') ?? undefined,
        extensions: q.get('extensions') ?? undefined,
        documentId: q.get('documentId') ?? q.get('id') ?? undefined,
      }
    }
    const contentType = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType === 'application/graphql') return { query: await c.req.text() }
    if (contentType === 'application/x-www-form-urlencoded') {
      const form = new URLSearchParams(await c.req.text())
      return {
        query: form.get('query') ?? undefined,
        variables: form.get('variables') ?? undefined,
        operationName: form.get('operationName') ?? undefined,
        extensions: form.get('extensions') ?? undefined,
        documentId: form.get('documentId') ?? undefined,
      }
    }
    if (contentType && contentType !== 'application/json' && !contentType.endsWith('+json')) {
      throw new HttpProblem(415, `Unsupported media type "${contentType}": send application/json.`)
    }
    const text = await c.req.text()
    let body: unknown
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      throw new HttpProblem(400, 'POST body sent invalid JSON.')
    }
    if (Array.isArray(body)) {
      if (!body.every((b) => b && typeof b === 'object' && !Array.isArray(b))) {
        throw new HttpProblem(400, 'Batch requests must be a list of objects.')
      }
      return body as GraphQLParams[]
    }
    if (!body || typeof body !== 'object') throw new HttpProblem(400, 'POST body must be a JSON object.')
    return body as GraphQLParams
  }

  // ---- authentication -----------------------------------------------------------------------------------

  protected async authenticate(c: Context, method: string, settings: GraphQLSettings): Promise<AuthResult> {
    const classes = this.authenticationClasses ?? settings.AUTHENTICATION_CLASSES
    if (classes?.length) {
      for (const Cls of classes) {
        const authenticator = new Cls()
        const result = await authenticator.authenticate(c)
        if (result) {
          setUser(c, result[0])
          return { user: result[0], auth: result[1] }
        }
      }
      return { user: anonymousUser, auth: null }
    }
    // core request user (session via AuthenticationMiddleware): CSRF applies to unsafe methods
    const user = getUser(c)
    if (user.isAuthenticated && user.isActive !== false) {
      if (method !== 'GET' && method !== 'HEAD') await enforceCsrf(c)
      return { user, auth: null }
    }
    return { user: anonymousUser, auth: null }
  }

  protected authProblem(err: unknown): HttpProblem | null {
    const e = err as any
    const status: number | undefined =
      typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined
    if (status !== 401 && status !== 403) return null
    const headers: Record<string, string> = {}
    const www = e.authenticateHeader ?? e.authHeader
    if (status === 401 && typeof www === 'string') headers['WWW-Authenticate'] = www
    const message = typeof e.detail === 'string' ? e.detail : (e.message ?? 'Authentication failed.')
    return new HttpProblem(status, message, headers, status === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED')
  }

  // ---- throttling --------------------------------------------------------------------------------------

  /** Instantiate the throttle classes (DRF's `get_throttles()`). */
  getThrottles(settings: GraphQLSettings): GraphQLThrottle[] {
    return (this.throttleClasses ?? settings.DEFAULT_THROTTLE_CLASSES ?? []).map((T) => new T())
  }

  /**
   * Run every throttle once for this HTTP request (DRF's `check_throttles()`): all of them are consulted, and
   * when any refuses, `throttled()` is called with the longest known wait.
   */
  async checkThrottles(request: PermissionRequest, settings: GraphQLSettings): Promise<void> {
    const durations: Array<number | null> = []
    for (const throttle of this.getThrottles(settings)) {
      if (!(await throttle.allowRequest(request, this))) durations.push(throttle.wait?.() ?? null)
    }
    if (!durations.length) return
    const known = durations.filter((d): d is number => d !== null && d !== undefined)
    this.throttled(request, known.length ? Math.max(...known) : null)
  }

  /** Called when a throttle refuses the request: raises the 429 (DRF's `throttled()`; override to customize). */
  throttled(_request: PermissionRequest, wait: number | null): never {
    throw throttleHttpProblem(wait === null ? null : Math.ceil(wait))
  }

  /** Map an error raised by a `throttled()` override (e.g. REST's `Throttled`) to a 429. */
  protected throttleProblem(err: unknown): HttpProblem | null {
    const e = err as any
    const status: number | undefined =
      typeof e?.statusCode === 'number' ? e.statusCode : typeof e?.status === 'number' ? e.status : undefined
    if (status !== 429) return null
    const wait = typeof e.wait === 'number' ? Math.ceil(e.wait) : null
    const message = typeof e.detail === 'string' ? e.detail : (e.message ?? throttledMessage(wait))
    return throttleHttpProblem(wait, message)
  }

  // ---- execution ---------------------------------------------------------------------------------------

  protected async loadQuery(c: Context, params: GraphQLParams): Promise<string> {
    const ext = parseJsonParam(params.extensions, 'extensions') as Record<string, any> | undefined
    const hash = ext?.persistedQuery?.sha256Hash
    const id =
      typeof params.documentId === 'string'
        ? params.documentId
        : typeof params.id === 'string'
          ? params.id
          : undefined
    const query = typeof params.query === 'string' ? params.query : undefined
    if (this.persistedQueries && (id || hash)) {
      const stored = await this.persistedQueries({ id, sha256Hash: hash, query, extensions: ext }, c)
      if (stored) return stored
      if (!query || this.persistedQueriesOnly)
        throw new HttpProblem(400, 'PersistedQueryNotFound', {}, 'PERSISTED_QUERY_NOT_FOUND')
    } else if (this.persistedQueriesOnly) {
      throw new HttpProblem(400, 'Only persisted queries are accepted.', {}, 'PERSISTED_QUERY_REQUIRED')
    }
    if (params.query !== undefined && params.query !== null && typeof params.query !== 'string') {
      throw new HttpProblem(400, 'The "query" parameter must be a string.')
    }
    if (!query) throw new HttpProblem(400, 'Must provide query string.')
    return query
  }

  validationRulesFor(
    settings: GraphQLSettings,
    variables: Record<string, unknown> | undefined,
  ): ValidationRule[] {
    const rules: ValidationRule[] = [...specifiedRules]
    const maxDepth = this.maxDepth ?? settings.MAX_DEPTH
    const maxComplexity = this.maxComplexity ?? settings.MAX_COMPLEXITY
    if (maxDepth !== undefined && maxDepth !== null) rules.push(depthLimit(maxDepth))
    if (maxComplexity !== undefined && maxComplexity !== null)
      rules.push(complexityLimit(maxComplexity, { variables }))
    if (!(this.introspection ?? settings.INTROSPECTION ?? true)) rules.push(NoSchemaIntrospectionCustomRule)
    if (this.validationRules) rules.push(...this.validationRules)
    return rules
  }

  protected async executeOne(
    c: Context,
    schema: GraphQLSchema,
    params: GraphQLParams,
    auth: AuthResult,
    mediaType: string,
    method: string,
    settings: GraphQLSettings & { DEBUG: boolean },
  ): Promise<OneResult> {
    const query = await this.loadQuery(c, params)
    const variables = parseJsonParam(params.variables, 'variables')
    if (
      variables !== undefined &&
      variables !== null &&
      (typeof variables !== 'object' || Array.isArray(variables))
    ) {
      throw new HttpProblem(400, 'The "variables" parameter must be an object.')
    }
    const operationName = params.operationName
    if (operationName !== undefined && operationName !== null && typeof operationName !== 'string') {
      throw new HttpProblem(400, 'The "operationName" parameter must be a string.')
    }
    const strict = mediaType === GRAPHQL_RESPONSE_MEDIA_TYPE
    const requestError = (errors: readonly GraphQLError[]): OneResult => ({
      status: strict ? 400 : 200,
      body: { errors: errors.map((e) => e.toJSON()) },
    })
    let document: DocumentNode
    try {
      document = parse(query)
    } catch (err) {
      if (err instanceof GraphQLError) return requestError([err])
      throw err
    }
    const errors = validate(
      schema,
      document,
      this.validationRulesFor(settings, variables as Record<string, unknown> | undefined),
    )
    if (errors.length) return requestError(errors)
    const op = getOperationAST(document, (operationName as string | undefined) ?? undefined)
    if (!op) {
      return requestError([
        new GraphQLError(
          operationName
            ? `Unknown operation named "${operationName}".`
            : 'Must provide operation name if query contains multiple operations.',
        ),
      ])
    }
    if ((method === 'GET' || method === 'HEAD') && op.operation !== 'query') {
      throw new HttpProblem(405, `Can only perform a ${op.operation} operation from a POST request.`, {
        Allow: 'POST',
      })
    }
    if (op.operation === 'subscription') {
      return requestError([new GraphQLError('Subscriptions are not supported over this endpoint.')])
    }
    const contextValue = createGraphQLContext({ c, user: auth.user, auth: auth.auth })
    if (this.getContext) Object.assign(contextValue, (await this.getContext(c, contextValue)) ?? {})
    const result = await execute({
      schema,
      document,
      rootValue: this.rootValue,
      contextValue,
      variableValues: (variables as Record<string, unknown> | undefined) ?? undefined,
      operationName: (operationName as string | undefined) ?? undefined,
    })
    const debug = this.debug ?? settings.DEBUG
    const body: FormattedExecutionResult = {}
    if (result.errors?.length) body.errors = result.errors.map((e) => formatError(e, { debug }))
    if ('data' in result) body.data = result.data as any
    if (result.extensions) body.extensions = result.extensions as any
    // no `data`: the request failed before execution (e.g. variable coercion) → request error
    const status = 'data' in result && result.data !== undefined ? 200 : strict ? 400 : 200
    return { status, body }
  }

  // ---- GraphiQL --------------------------------------------------------------------------------------------

  protected renderGraphiQL(c: Context): Response {
    const token = getCsrfToken(c)
    setCsrfCookieIfNeeded(c)
    const html = renderGraphiQL({
      csrfToken: token,
      csrfHeaderName: (graphqlSettingsCsrfHeader(c) as string) ?? 'X-CSRFToken',
    })
    return c.html(html, 200, { 'Cache-Control': 'no-store' })
  }
}

function graphqlSettingsCsrfHeader(c: Context): string | undefined {
  try {
    const s = (c.get('ghuri') as any)?.settings
    return s?.CSRF_HEADER_NAME
  } catch {
    return undefined
  }
}

function throttleHttpProblem(wait: number | null, message?: string): HttpProblem {
  return new HttpProblem(
    429,
    message ?? throttledMessage(wait),
    wait === null ? {} : { 'Retry-After': String(wait) },
    'THROTTLED',
    { wait },
  )
}

function parseJsonParam(value: unknown, name: string): unknown {
  if (typeof value !== 'string') return value
  if (value === '') return undefined
  try {
    return JSON.parse(value)
  } catch {
    throw new HttpProblem(400, `The "${name}" parameter is not valid JSON.`)
  }
}
