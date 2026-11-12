import { CsrfMiddleware, PermissionDenied, path, setUser } from '@ghuri/core'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  Field,
  GraphQLView,
  ID,
  Int,
  List,
  ModelType,
  Mutation,
  NonNull,
  Query,
  Schema,
  String as GString,
} from '../src/index'
import { assertResponseHasErrors, assertResponseNoErrors, graphqlQuery, payloadErrors } from '../src/testing'
import { fakeUser, useHttp } from './helpers'
import { Member, Post } from './models'

class MemberType extends ModelType {
  static override Meta = { model: Member }
}
class PostType extends ModelType {
  static override Meta = { model: Post }
}

class Echo extends Mutation {
  static override Arguments = { text: NonNull(String) }
  static override fields = { text: GString, user: GString }
  static override mutate(_root: unknown, { text }: { text: string }, info: any) {
    return { text, user: info.context.user.username ?? null }
  }
}

class HttpQuery extends Query {
  static override fields = {
    hello: Field(String, { args: { name: GString }, resolve: (_: unknown, { name }) => `Hello ${name ?? 'world'}` }),
    whoami: Field(String, { resolve: (_: unknown, _a: unknown, info: any) => info.context.user.username || null }),
    boom: Field(String, {
      resolve: () => {
        throw new Error('secret database password leaked')
      },
    }),
    denied: Field(String, {
      resolve: () => {
        throw new PermissionDenied('Nope.')
      },
    }),
    double: Field(Int, { args: { n: NonNull(Int) }, resolve: (_: unknown, { n }) => n * 2 }),
    members: List(MemberType),
    posts: List(PostType),
  }
}
class HttpMutation extends Mutation {
  static override fields = { echo: Echo.field() }
}
const schema = new Schema({ query: HttpQuery, mutation: HttpMutation })

/** Simulates AuthenticationMiddleware: `x-test-user: name` logs that user in. */
async function fakeAuth(c: Context, next: () => Promise<void>) {
  const name = c.req.header('x-test-user')
  if (name) setUser(c, fakeUser({ username: name }))
  await next()
}

const GQL = 'application/graphql-response+json'

describe('GraphQL over HTTP', () => {
  const h = useHttp(() => ({
    middleware: [fakeAuth, CsrfMiddleware],
    urls: [
      path('graphql/', GraphQLView.asView({ schema })),
      path('strict/', GraphQLView.asView({ schema, maxDepth: 2, maxComplexity: 20, introspection: false })),
      path('batch/', GraphQLView.asView({ schema, batch: true })),
      path('ide/', GraphQLView.asView({ schema, graphiql: true })),
      path('debug/', GraphQLView.asView({ schema, debug: true })),
      path(
        'persisted/',
        GraphQLView.asView({
          schema,
          persistedQueriesOnly: true,
          persistedQueries: ({ id, sha256Hash }) => (id === 'hello' || sha256Hash === 'abc' ? '{ hello }' : null),
        }),
      ),
    ],
  }))
  const post = (path: string, json: unknown, headers: Record<string, string> = { accept: GQL }, extra = {}) =>
    h.client.post(path, { json, headers, ...extra })

  it('executes POST JSON with application/graphql-response+json', async () => {
    const res = await post('/graphql/', { query: 'query ($n: String) { hello(name: $n) }', variables: { n: 'Ann' } })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe(`${GQL}; charset=utf-8`)
    expect(await res.json()).toEqual({ data: { hello: 'Hello Ann' } })
  })

  it('negotiates the response media type', async () => {
    const json = await post('/graphql/', { query: '{ hello }' }, { accept: 'application/json' })
    expect(json.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const none = await h.client.post('/graphql/', { body: JSON.stringify({ query: '{ hello }' }), headers: { 'content-type': 'application/json' } })
    expect(none.headers.get('content-type')).toBe('application/json; charset=utf-8')
    const any = await post('/graphql/', { query: '{ hello }' }, { accept: '*/*' })
    expect(any.headers.get('content-type')).toContain(GQL)
    const bad = await post('/graphql/', { query: '{ hello }' }, { accept: 'text/plain' })
    expect(bad.status).toBe(406)
  })

  it('maps request errors to status codes', async () => {
    const invalidJson = await h.client.post('/graphql/', {
      body: '{"query": ',
      headers: { 'content-type': 'application/json', accept: GQL },
    })
    expect(invalidJson.status).toBe(400)
    expect((await invalidJson.json()).errors[0].message).toBe('POST body sent invalid JSON.')
    expect((await post('/graphql/', {})).status).toBe(400)
    expect((await post('/graphql/', { query: '{ hello }', variables: '[1]' })).status).toBe(400)
    const unsupported = await h.client.post('/graphql/', { body: '{ hello }', headers: { 'content-type': 'text/plain', accept: GQL } })
    expect(unsupported.status).toBe(415)
    const graphqlBody = await h.client.post('/graphql/', {
      body: '{ hello }',
      headers: { 'content-type': 'application/graphql', accept: GQL },
    })
    expect(await graphqlBody.json()).toEqual({ data: { hello: 'Hello world' } })
  })

  it('returns 400 for invalid documents with graphql-response+json and 200 with application/json', async () => {
    for (const [query, variables] of [
      ['{ hello(', undefined],
      ['{ nope }', undefined],
      ['query ($n: Int!) { double(n: $n) }', { n: 'x' }],
      ['query A { hello } query B { hello }', undefined],
    ] as const) {
      const strict = await post('/graphql/', { query, variables })
      expect(strict.status).toBe(400)
      const body = await strict.json()
      expect(body.data).toBeUndefined()
      expect(body.errors.length).toBeGreaterThan(0)
      const legacy = await post('/graphql/', { query, variables }, { accept: 'application/json' })
      expect(legacy.status).toBe(200)
    }
    const named = await post('/graphql/', { query: 'query A { hello } query B { double(n: 2) }', operationName: 'B' })
    expect(await named.json()).toEqual({ data: { double: 4 } })
    const unknownOp = await post('/graphql/', { query: 'query A { hello }', operationName: 'C' })
    expect(unknownOp.status).toBe(400)
  })

  it('serves queries over GET and rejects mutations with 405', async () => {
    const res = await graphqlQuery(h.client, 'query ($n: String) { hello(name: $n) }', {
      method: 'GET',
      variables: { n: 'GET' },
    })
    assertResponseNoErrors(res)
    expect(res.data).toEqual({ hello: 'Hello GET' })
    const mutation = await graphqlQuery(h.client, 'mutation { echo(text: "x") { text } }', { method: 'GET' })
    expect(mutation.status).toBe(405)
    expect(mutation.response.headers.get('allow')).toBe('POST')
    expect(mutation.errors?.[0].message).toContain('Can only perform a mutation operation from a POST request')
    const put = await h.client.put('/graphql/', { json: { query: '{ hello }' } })
    expect(put.status).toBe(405)
  })

  it('masks unexpected errors, keeps GhuriError messages, and adds stacks in debug', async () => {
    const res = await graphqlQuery(h.client, '{ hello boom denied }')
    expect(res.status).toBe(200)
    expect(res.data).toEqual({ hello: 'Hello world', boom: null, denied: null })
    expect(res.errors).toEqual([
      expect.objectContaining({ message: 'Internal server error', path: ['boom'], extensions: { code: 'INTERNAL_SERVER_ERROR' } }),
      expect.objectContaining({ message: 'Nope.', path: ['denied'], extensions: { code: 'PERMISSION_DENIED' } }),
    ])
    assertResponseHasErrors(res, { message: 'Nope.', code: 'PERMISSION_DENIED' })
    const debug = await graphqlQuery(h.client, '{ boom }', { path: '/debug/' })
    expect(debug.errors?.[0].message).toBe('secret database password leaked')
    expect((debug.errors?.[0].extensions as any).exception.stack.length).toBeGreaterThan(1)
  })

  it('enforces depth and complexity limits and the introspection toggle', async () => {
    await Member.objects.create({ username: 'ann' })
    const ok = await graphqlQuery(h.client, '{ members { username } }', { path: '/strict/' })
    assertResponseNoErrors(ok)
    const deep = await graphqlQuery(h.client, '{ members { posts { author { username } } } }', { path: '/strict/' })
    expect(deep.status).toBe(400)
    expect(deep.errors?.[0].message).toBe('Query depth 4 exceeds the maximum allowed depth of 2.')
    const wide = await graphqlQuery(h.client, `{ ${Array.from({ length: 21 }, (_, i) => `a${i}: hello`).join(' ')} }`, {
      path: '/strict/',
    })
    expect(wide.status).toBe(400)
    expect(wide.errors?.[0].message).toContain('Query complexity 21 exceeds the maximum allowed complexity of 20')
    const introspection = await graphqlQuery(h.client, '{ __schema { queryType { name } } }', { path: '/strict/' })
    expect(introspection.status).toBe(400)
    expect(introspection.errors?.[0].message).toContain('introspection')
    const allowed = await graphqlQuery(h.client, '{ __schema { queryType { name } } }')
    expect(allowed.data).toEqual({ __schema: { queryType: { name: 'Query' } } })
  })

  it('supports batching when enabled', async () => {
    const off = await post('/graphql/', [{ query: '{ hello }' }])
    expect(off.status).toBe(400)
    const on = await post('/batch/', [{ query: '{ hello }' }, { query: 'query ($n: Int!) { double(n: $n) }', variables: { n: 3 } }, {}])
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual([
      { data: { hello: 'Hello world' } },
      { data: { double: 6 } },
      { errors: [{ message: 'Must provide query string.' }] },
    ])
  })

  it('serves GraphiQL to browsers when enabled and sets the CSRF cookie', async () => {
    const ide = await h.client.get('/ide/', { headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' } })
    expect(ide.status).toBe(200)
    expect(ide.headers.get('content-type')).toContain('text/html')
    const html = await ide.text()
    expect(html).toContain('graphiql.min.js')
    expect(html).toContain('X-CSRFToken')
    expect(h.client.getCookie('csrftoken')).toBeTruthy()
    const raw = await h.client.get('/ide/', { query: { raw: '1', query: '{ hello }' }, headers: { accept: 'text/html,*/*' } })
    expect(raw.headers.get('content-type')).toContain('json')
    const off = await h.client.get('/graphql/', { headers: { accept: 'text/html' } })
    expect(off.status).toBe(406)
  })

  it('exempts the view from CsrfMiddleware but enforces CSRF for authenticated (session) POSTs', async () => {
    const anon = await graphqlQuery(h.client, 'mutation { echo(text: "hi") { text user } }', { csrf: false })
    expect(anon.status).toBe(200)
    expect(anon.data).toEqual({ echo: { text: 'hi', user: '' } })
    const noToken = await graphqlQuery(h.client, 'mutation { echo(text: "hi") { text } }', {
      csrf: false,
      headers: { 'x-test-user': 'ann' },
    })
    expect(noToken.status).toBe(403)
    expect(noToken.errors?.[0].message).toContain('CSRF')
    const withToken = await graphqlQuery(h.client, 'mutation { echo(text: "hi") { user } }', { headers: { 'x-test-user': 'ann' } })
    expect(withToken.data).toEqual({ echo: { user: 'ann' } })
    const get = await graphqlQuery(h.client, '{ whoami }', { method: 'GET', headers: { 'x-test-user': 'bob' } })
    expect(get.data).toEqual({ whoami: 'bob' })
  })

  it('resolves persisted queries', async () => {
    const byId = await h.client.get('/persisted/', { query: { documentId: 'hello' }, headers: { accept: GQL } })
    expect(await byId.json()).toEqual({ data: { hello: 'Hello world' } })
    const apq = await post('/persisted/', { extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } })
    expect(await apq.json()).toEqual({ data: { hello: 'Hello world' } })
    const missing = await post('/persisted/', { documentId: 'nope' })
    expect(missing.status).toBe(400)
    expect((await missing.json()).errors[0]).toEqual({ message: 'PersistedQueryNotFound', extensions: { code: 'PERSISTED_QUERY_NOT_FOUND' } })
    const adhoc = await post('/persisted/', { query: '{ hello }' })
    expect(adhoc.status).toBe(400)
  })

  it('testing helpers report payload errors', () => {
    expect(payloadErrors({ errors: [{ field: 'title', messages: ['Required.'] }] })).toEqual({ title: ['Required.'] })
    expect(() => assertResponseNoErrors({ status: 200, errors: [{ message: 'x' }] } as any)).toThrow(/x/)
    expect(() => assertResponseHasErrors({ status: 200, errors: [] } as any)).toThrow(/Expected GraphQL errors/)
  })
})

void ID
