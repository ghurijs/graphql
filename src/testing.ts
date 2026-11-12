// @ghuri/graphql/testing — run GraphQL operations through the test client (graphene-django's GraphQLTestCase).
import type { FormattedExecutionResult, GraphQLFormattedError } from 'graphql'

/** Anything with the core test client's `post()` / `get()`. */
export interface TestClientLike {
  post(
    path: string,
    opts?: { json?: unknown; headers?: Record<string, string>; csrf?: boolean; body?: any },
  ): Promise<Response>
  get(
    path: string,
    opts?: { query?: Record<string, unknown>; headers?: Record<string, string> },
  ): Promise<Response>
}

export interface GraphQLQueryOptions {
  variables?: Record<string, unknown>
  operationName?: string
  headers?: Record<string, string>
  /** Endpoint (default `/graphql/`). */
  path?: string
  /** `GET` sends the operation as query parameters (default `POST`). */
  method?: 'GET' | 'POST'
  /** Override the test client's automatic CSRF token. */
  csrf?: boolean
  /** Accept header (default `application/graphql-response+json`). */
  accept?: string
}

/** The result of `graphqlQuery()`: the HTTP response plus the parsed GraphQL result. */
export interface GraphQLTestResponse<TData = any> {
  response: Response
  status: number
  /** The parsed JSON body (`{ data, errors }`). */
  json: FormattedExecutionResult<TData> & Record<string, unknown>
  data: TData | null | undefined
  errors: readonly GraphQLFormattedError[] | undefined
}

/** Default endpoint used by `graphqlQuery()`. Change it once in a setup file if your URL differs. */
export const graphqlTestDefaults = { path: '/graphql/' }

/**
 * Send a GraphQL operation with the test client:
 *
 * ```ts
 * const res = await graphqlQuery(client, 'query { me { username } }')
 * assertResponseNoErrors(res)
 * expect(res.data.me.username).toBe('ann')
 * ```
 */
export async function graphqlQuery<TData = any>(
  client: TestClientLike,
  query: string,
  opts: GraphQLQueryOptions = {},
): Promise<GraphQLTestResponse<TData>> {
  const path = opts.path ?? graphqlTestDefaults.path
  const headers = { accept: opts.accept ?? 'application/graphql-response+json', ...(opts.headers ?? {}) }
  let response: Response
  if (opts.method === 'GET') {
    const q: Record<string, unknown> = { query }
    if (opts.variables) q.variables = JSON.stringify(opts.variables)
    if (opts.operationName) q.operationName = opts.operationName
    response = await client.get(path, { query: q, headers })
  } else {
    const json: Record<string, unknown> = { query }
    if (opts.variables) json.variables = opts.variables
    if (opts.operationName) json.operationName = opts.operationName
    response = await client.post(path, {
      json,
      headers,
      ...(opts.csrf === undefined ? {} : { csrf: opts.csrf }),
    })
  }
  const text = await response.text()
  let json: any
  try {
    json = text ? JSON.parse(text) : {}
  } catch {
    json = { errors: [{ message: `Non-JSON response (${response.status}): ${text.slice(0, 200)}` }] }
  }
  return { response, status: response.status, json, data: json?.data, errors: json?.errors }
}

function describe(errors: readonly GraphQLFormattedError[] | undefined): string {
  return (errors ?? []).map((e) => `${e.message}${e.path ? ` (at ${e.path.join('.')})` : ''}`).join('; ')
}

/** Throw unless the response is 200 without GraphQL errors. */
export function assertResponseNoErrors(res: GraphQLTestResponse): void {
  if (res.status !== 200 || res.errors?.length) {
    throw new Error(
      `Expected a successful GraphQL response, got ${res.status}: ${describe(res.errors) || JSON.stringify(res.json)}`,
    )
  }
}

/** Throw unless the response carries GraphQL errors. Optionally match a message and / or `extensions.code`. */
export function assertResponseHasErrors(
  res: GraphQLTestResponse,
  expected: { message?: string | RegExp; code?: string } = {},
): void {
  const errors = res.errors ?? []
  if (!errors.length) throw new Error(`Expected GraphQL errors, got none (status ${res.status}).`)
  if (expected.message !== undefined) {
    const m = expected.message
    const ok = errors.some((e) => (typeof m === 'string' ? e.message.includes(m) : m.test(e.message)))
    if (!ok) throw new Error(`No GraphQL error matches ${String(m)}: ${describe(errors)}`)
  }
  if (expected.code !== undefined && !errors.some((e) => e.extensions?.code === expected.code)) {
    throw new Error(`No GraphQL error has code ${expected.code}: ${JSON.stringify(errors)}`)
  }
}

/** Mutation payload validation errors (`errors: [{ field, messages }]`) as a `{ field: messages }` dict. */
export function payloadErrors(
  payload: { errors?: Array<{ field: string; messages: string[] }> | null } | null | undefined,
): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const e of payload?.errors ?? []) out[e.field] = e.messages
  return out
}
