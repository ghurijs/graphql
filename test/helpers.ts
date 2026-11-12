import { createApp, defineSettings, type GhuriApp, type RequestUser, type UrlPatterns } from '@ghuri/core'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { setupTestDatabase, type TestBackend, type TestDatabase } from '@ghuri/orm/testing'
import { afterAll, beforeAll, beforeEach } from 'vitest'
import { allModels } from './models'

export const backends: TestBackend[] = (process.env.GHURI_TEST_BACKENDS?.split(',') as
  | TestBackend[]
  | undefined) ?? ['sqlite', 'pglite']

/** A test database (models of test/models.ts) flushed before each test. */
export function useDatabase(using: TestBackend = 'sqlite', models: any[] = allModels): { db: TestDatabase } {
  const h = {} as { db: TestDatabase }
  beforeAll(async () => {
    h.db = await setupTestDatabase({ using, models })
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    await h.db.flush()
  })
  return h
}

export interface HttpHarness {
  app: GhuriApp
  db: TestDatabase
  client: TestClient
  env: Record<string, unknown>
}

/** createApp + test DB + test client sharing one env (no auth package). */
export function useHttp(
  factory: () => {
    urls: UrlPatterns
    settings?: Record<string, unknown>
    backend?: TestBackend
    middleware?: any[]
  },
): HttpHarness {
  const h = {} as HttpHarness
  beforeAll(async () => {
    const opts = factory()
    const env: Record<string, unknown> = {}
    const settings = defineSettings(() => ({
      SECRET_KEY: 'test-secret',
      DEBUG: false,
      INSTALLED_APPS: [],
      MIDDLEWARE: opts.middleware ?? [],
      ROOT_URLCONF: opts.urls,
      ...(opts.settings ?? {}),
    }))
    h.app = createApp(settings, { checks: false })
    await h.app.setup(env)
    h.db = await setupTestDatabase({ using: opts.backend ?? 'sqlite', models: allModels })
    h.client = createTestClient(h.app, { env })
    h.env = env
  }, 60_000)
  afterAll(async () => {
    await h.db?.teardown()
  })
  beforeEach(async () => {
    await h.db.flush()
    h.client.clearCookies()
  })
  return h
}

/** A RequestUser without the auth package. */
export function fakeUser(
  opts: { pk?: number; username?: string; isStaff?: boolean; isSuperuser?: boolean; perms?: string[] } = {},
): RequestUser {
  const perms = new Set(opts.perms ?? [])
  return {
    pk: opts.pk ?? 1,
    username: opts.username ?? 'alice',
    isAuthenticated: true,
    isAnonymous: false,
    isActive: true,
    isStaff: opts.isStaff ?? false,
    isSuperuser: opts.isSuperuser ?? false,
    async hasPerm(perm: string) {
      return opts.isSuperuser || perms.has(perm)
    },
  }
}
