// Throttling in GraphQLView with the @ghuri/rest throttle classes.
import { memoryCache, path } from '@ghuri/core'
import {
  AnonRateThrottle,
  BaseThrottle,
  ScopedRateThrottle,
  SimpleRateThrottle,
  Throttled,
  UserRateThrottle,
} from '@ghuri/rest'
import type { Context } from 'hono'
import { beforeEach, describe, expect, it } from 'vitest'
import { Field, GraphQLView, type PermissionRequest, Query, Schema } from '../src/index'
import { fakeUser, useHttp } from './helpers'

// Deterministic clock for every SimpleRateThrottle (each test jumps far ahead, expiring older history).
let now = 1_000_000
for (const T of [AnonRateThrottle, UserRateThrottle, ScopedRateThrottle, SimpleRateThrottle]) {
  T.prototype.timer = () => now
}

class ThrottleQuery extends Query {
  static override fields = {
    hello: Field(String, { resolve: () => 'world' }),
    whoami: Field(String, {
      resolve: (_: unknown, _a: unknown, info: any) => info.context.user.username || null,
    }),
  }
}
const schema = new Schema({ query: ThrottleQuery })

/** `X-User-Id: 7` authenticates user 7 (a token-style authentication class: no CSRF). */
class HeaderAuthentication {
  async authenticate(c: Context) {
    const id = c.req.header('x-user-id')
    return id ? ([fakeUser({ pk: Number(id), username: `user${id}` }), 'token'] as [any, unknown]) : null
  }
}

/** Per-token limits for a storefront API (the README example). */
class StorefrontTokenThrottle extends SimpleRateThrottle {
  override scope = 'storefront'
  getCacheKey(request: { header(name: string): string | undefined }) {
    const token = request.header('x-storefront-token')
    return token ? this.formatKey({ scope: this.scope, ident: token }) : null
  }
}

/** Always refuses, without a wait estimate. */
class Closed extends BaseThrottle {
  allowRequest() {
    return false
  }
}

class StorefrontView extends GraphQLView {
  override throttleClasses = [ScopedRateThrottle]
  override throttleScope = 'storefront'
}

class PoliteView extends GraphQLView {
  override throttled(_request: PermissionRequest, wait: number | null): never {
    throw new Throttled(wait, 'Slow down.')
  }
}

const GQL = 'application/graphql-response+json'
const RATES = { anon: '2/min', user: '3/min', uploads: '1/min', storefront: '2/min' }

describe('GraphQLView throttling', () => {
  const h = useHttp(() => ({
    settings: {
      CACHES: { default: memoryCache() },
      // X-Forwarded-For is only read behind a known number of proxies (@ghuri/rest > 0.1.0-alpha.1)
      REST_FRAMEWORK: {
        DEFAULT_THROTTLE_RATES: RATES,
        DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle],
        NUM_PROXIES: 1,
      },
      GRAPHQL: { DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle] },
    },
    urls: [
      path('default/', GraphQLView.asView({ schema })),
      path('open/', GraphQLView.asView({ schema, throttleClasses: [] })),
      path(
        'anon/',
        GraphQLView.asView({
          schema,
          throttleClasses: [AnonRateThrottle],
          authenticationClasses: [HeaderAuthentication],
        }),
      ),
      path(
        'user/',
        GraphQLView.asView({
          schema,
          throttleClasses: [UserRateThrottle],
          authenticationClasses: [HeaderAuthentication],
        }),
      ),
      path(
        'scoped/',
        GraphQLView.asView({ schema, throttleClasses: [ScopedRateThrottle], throttleScope: 'uploads' }),
      ),
      path('unscoped/', GraphQLView.asView({ schema, throttleClasses: [ScopedRateThrottle] })),
      path('storefront/', StorefrontView.asView({ schema })),
      path('token/', GraphQLView.asView({ schema, throttleClasses: [StorefrontTokenThrottle] })),
      path('closed/', GraphQLView.asView({ schema, throttleClasses: [Closed] })),
      path('polite/', PoliteView.asView({ schema, throttleClasses: [AnonRateThrottle] })),
      path('batch/', GraphQLView.asView({ schema, batch: true, throttleClasses: [AnonRateThrottle] })),
      path('ide/', GraphQLView.asView({ schema, graphiql: true, throttleClasses: [AnonRateThrottle] })),
    ],
  }))

  beforeEach(() => {
    now += 100_000
  })

  const query = (url: string, headers: Record<string, string> = {}, json: unknown = { query: '{ hello }' }) =>
    h.client.post(url, { json, headers: { accept: GQL, 'x-forwarded-for': '10.0.0.1', ...headers } })

  it('limits anonymous clients by IP (AnonRateThrottle)', async () => {
    expect((await query('/anon/')).status).toBe(200)
    expect((await query('/anon/')).status).toBe(200)
    expect((await query('/anon/')).status).toBe(429)
    // another IP has its own history; authenticated users are not limited by AnonRateThrottle
    expect((await query('/anon/', { 'x-forwarded-for': '10.0.0.2' })).status).toBe(200)
    for (let i = 0; i < 4; i++) expect((await query('/anon/', { 'x-user-id': '1' })).status).toBe(200)
  })

  it('limits users by id after authentication (UserRateThrottle)', async () => {
    const as7 = { 'x-user-id': '7' }
    for (let i = 0; i < 3; i++) {
      const res = await query('/user/', as7, { query: '{ whoami }' })
      expect(await res.json()).toEqual({ data: { whoami: 'user7' } })
    }
    expect((await query('/user/', as7)).status).toBe(429)
    // same IP, other user / anonymous: separate buckets
    expect((await query('/user/', { 'x-user-id': '8' })).status).toBe(200)
    expect((await query('/user/')).status).toBe(200)
    now += 61
    expect((await query('/user/', as7)).status).toBe(200)
  })

  it('limits by throttleScope (ScopedRateThrottle) from asView options or the class', async () => {
    expect((await query('/scoped/')).status).toBe(200)
    expect((await query('/scoped/')).status).toBe(429)
    expect((await query('/storefront/')).status).toBe(200)
    expect((await query('/storefront/')).status).toBe(200)
    expect((await query('/storefront/')).status).toBe(429)
    // no scope: ScopedRateThrottle does not apply
    for (let i = 0; i < 4; i++) expect((await query('/unscoped/')).status).toBe(200)
  })

  it('answers 429 with Retry-After and a GraphQL error', async () => {
    await query('/anon/')
    now += 30
    await query('/anon/')
    const res = await query('/anon/')
    expect(res.status).toBe(429)
    // the oldest request leaves the 1-minute window in 30 seconds
    expect(res.headers.get('retry-after')).toBe('30')
    expect(res.headers.get('content-type')).toBe(`${GQL}; charset=utf-8`)
    expect(await res.json()).toEqual({
      errors: [
        {
          message: 'Request was throttled. Expected available in 30 seconds.',
          extensions: { code: 'THROTTLED', wait: 30 },
        },
      ],
    })
    // the operation was not executed; application/json clients get the same 429
    const legacy = await query('/anon/', { accept: 'application/json' })
    expect(legacy.status).toBe(429)
    expect(legacy.headers.get('content-type')).toBe('application/json; charset=utf-8')
    now += 31
    expect((await query('/anon/')).status).toBe(200)
  })

  it('omits Retry-After when the throttle has no wait estimate', async () => {
    const res = await query('/closed/')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeNull()
    expect(await res.json()).toEqual({
      errors: [{ message: 'Request was throttled.', extensions: { code: 'THROTTLED', wait: null } }],
    })
  })

  it('maps REST Throttled raised by a throttled() override', async () => {
    await query('/polite/')
    await query('/polite/')
    const res = await query('/polite/')
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBe('60')
    expect((await res.json()).errors[0]).toEqual({
      message: 'Slow down. Expected available in 60 seconds.',
      extensions: { code: 'THROTTLED', wait: 60 },
    })
  })

  it('counts a batch as one request', async () => {
    const ops = [{ query: '{ hello }' }, { query: '{ hello }' }, { query: '{ hello }' }]
    const first = await query('/batch/', {}, ops)
    expect(first.status).toBe(200)
    expect(await first.json()).toHaveLength(3)
    expect((await query('/batch/', {}, ops)).status).toBe(200)
    const third = await query('/batch/', {}, ops)
    expect(third.status).toBe(429)
    expect((await third.json()).errors[0].extensions.code).toBe('THROTTLED')
  })

  it('never throttles the GraphiQL page, only its operations', async () => {
    for (let i = 0; i < 5; i++) {
      const page = await h.client.get('/ide/', {
        headers: { accept: 'text/html', 'x-forwarded-for': '10.0.0.1' },
      })
      expect(page.status).toBe(200)
      expect(page.headers.get('content-type')).toContain('text/html')
    }
    expect((await query('/ide/')).status).toBe(200)
    expect((await query('/ide/')).status).toBe(200)
    expect((await query('/ide/')).status).toBe(429)
    const get = await h.client.get('/ide/', {
      query: { query: '{ hello }', raw: '1' },
      headers: { accept: GQL, 'x-forwarded-for': '10.0.0.1' },
    })
    expect(get.status).toBe(429)
  })

  it('throttles per token with a custom SimpleRateThrottle', async () => {
    const shopA = { 'x-storefront-token': 'shop-a' }
    expect((await query('/token/', shopA)).status).toBe(200)
    expect((await query('/token/', shopA, { query: '{ hello }' })).status).toBe(200)
    expect((await query('/token/', shopA)).status).toBe(429)
    // other token (same IP) and no token (no cache key) are not limited
    expect((await query('/token/', { 'x-storefront-token': 'shop-b' })).status).toBe(200)
    for (let i = 0; i < 3; i++) expect((await query('/token/')).status).toBe(200)
  })

  it('uses GRAPHQL.DEFAULT_THROTTLE_CLASSES unless the view sets throttleClasses', async () => {
    expect((await query('/default/')).status).toBe(200)
    expect((await query('/default/')).status).toBe(200)
    expect((await query('/default/')).status).toBe(429)
    for (let i = 0; i < 4; i++) expect((await query('/open/')).status).toBe(200)
  })
})

describe('GraphQLView without throttles', () => {
  const h = useHttp(() => ({
    settings: {
      CACHES: { default: memoryCache() },
      // REST defaults do not leak into GraphQL: only GRAPHQL.DEFAULT_THROTTLE_CLASSES applies
      REST_FRAMEWORK: {
        DEFAULT_THROTTLE_RATES: { anon: '1/min' },
        DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle],
      },
    },
    urls: [path('graphql/', GraphQLView.asView({ schema }))],
  }))

  it('behaves as before', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await h.client.post('/graphql/', { json: { query: '{ hello }' }, headers: { accept: GQL } })
      expect(res.status).toBe(200)
      expect(res.headers.get('retry-after')).toBeNull()
      expect(await res.json()).toEqual({ data: { hello: 'world' } })
    }
  })
})
