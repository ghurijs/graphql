// Bundles a Worker using GraphQLView with esbuild (from src/ and, when fresh, dist/) and runs it in workerd.
import { existsSync, readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { build, type Plugin } from 'esbuild'
import { convertV4MiniflareOptions, Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))
const distEntry = `${root}dist/index.js`

function newest(dir: string): number {
  let t = 0
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = `${dir}/${f.name}`
    t = Math.max(t, f.isDirectory() ? newest(p) : statSync(p).mtimeMs)
  }
  return t
}

const distFresh = existsSync(distEntry) && newest(`${root}src`) <= statSync(distEntry).mtimeMs
const targets: Array<'src' | 'dist'> = distFresh ? ['src', 'dist'] : ['src']

function useDist(): Plugin {
  return {
    name: 'ghuri-graphql-dist',
    setup(b) {
      b.onResolve({ filter: /\/src\/index$/ }, () => ({ path: distEntry }))
    },
  }
}

async function bundle(target: 'src' | 'dist'): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL('./fixtures/worker.ts', import.meta.url))],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2022',
    mainFields: ['module', 'main'],
    conditions: ['workerd', 'worker', 'browser', 'import'],
    external: ['node:*', 'cloudflare:*', 'postgres'],
    plugins: target === 'dist' ? [useDist()] : [],
    write: false,
    logLevel: 'silent',
  })
  return result.outputFiles[0].text
}

describe.each(targets)('Worker bundle from %s on workerd', (target) => {
  let mf: Miniflare
  const base = 'https://example.com/graphql/'

  beforeAll(async () => {
    const script = await bundle(target)
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script,
        compatibilityDate: '2025-06-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: { DB: `graphql-${crypto.randomUUID()}` },
        bindings: { SECRET_KEY: 'workerd-secret' },
      }),
    )
    const db = await mf.getD1Database('DB')
    await db.exec('CREATE TABLE edge_tag (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)')
    await db.exec("INSERT INTO edge_tag (name) VALUES ('workers'), ('d1')")
  }, 60_000)

  afterAll(async () => {
    await mf?.dispose()
  })

  it('serves GraphQL over HTTP from D1', async () => {
    const res = await mf.dispatchFetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/graphql-response+json' },
      body: JSON.stringify({ query: '{ hello tags { id name } }' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/graphql-response+json')
    expect(await res.json()).toEqual({
      data: {
        hello: 'hello from Cloudflare-Workers',
        tags: [
          { id: '1', name: 'workers' },
          { id: '2', name: 'd1' },
        ],
      },
    })
  })

  it('handles GET, 405 for GET mutations, 400 for invalid documents and GraphiQL', async () => {
    const get = await mf.dispatchFetch(`${base}?query=${encodeURIComponent('{ hello }')}`)
    expect(get.status).toBe(200)
    const mutation = await mf.dispatchFetch(`${base}?query=${encodeURIComponent('mutation { x }')}`, {
      headers: { accept: 'application/graphql-response+json' },
    })
    expect([400, 405]).toContain(mutation.status)
    const invalid = await mf.dispatchFetch(`${base}?query=${encodeURIComponent('{ nope }')}`, {
      headers: { accept: 'application/graphql-response+json' },
    })
    expect(invalid.status).toBe(400)
    const ide = await mf.dispatchFetch(base, { headers: { accept: 'text/html' } })
    expect(await ide.text()).toContain('graphiql')
  })
})
