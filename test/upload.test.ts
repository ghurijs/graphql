// File uploads: the Upload scalar, the GraphQL multipart request spec in GraphQLView, limits and CSRF.
import { CsrfMiddleware, path, setUser } from '@ghuri/core'
import { printSchema } from 'graphql'
import type { Context } from 'hono'
import { describe, expect, it } from 'vitest'
import {
  Field,
  GraphQLView,
  String as GString,
  InputObjectType,
  Int,
  List,
  Mutation,
  NonNull,
  ObjectType,
  processMultipartForm,
  Query,
  Schema,
  Upload,
  UploadError,
  uploadFormData,
} from '../src/index'
import { assertResponseNoErrors, graphqlQuery } from '../src/testing'
import { fakeUser, useHttp } from './helpers'

class FileInfo extends ObjectType {
  static override fields = { name: GString, type: GString, size: Int, text: GString }
}

async function info(file: File) {
  return { name: file.name, type: file.type, size: file.size, text: await file.text() }
}

class AttachmentInput extends InputObjectType {
  static override fields = { title: NonNull(String), file: NonNull(Upload) }
}

class UploadQuery extends Query {
  static override fields = { ok: Field(Boolean, { resolve: () => true }) }
}

class UploadMutation extends Mutation {
  static override fields = {
    single: Field(FileInfo, {
      args: { file: NonNull(Upload) },
      resolve: (_: unknown, { file }: { file: File }) => info(file),
    }),
    optional: Field(GString, {
      args: { file: Upload },
      resolve: (_: unknown, { file }: { file?: File | null }) => (file ? file.name : 'none'),
    }),
    multiple: List(FileInfo, {
      args: { files: NonNull(List(Upload)) },
      resolve: (_: unknown, { files }: { files: File[] }) => Promise.all(files.map(info)),
    }),
    attach: Field(GString, {
      args: { input: NonNull(AttachmentInput) },
      resolve: async (_: unknown, { input }: { input: { title: string; file: File } }) =>
        `${input.title}: ${await input.file.text()}`,
    }),
    whoami: Field(GString, {
      args: { file: Upload },
      resolve: (_: unknown, _a: unknown, ctx: any) => ctx.context.user.username || 'anonymous',
    }),
  }
}

const schema = new Schema({ query: UploadQuery, mutation: UploadMutation })
const noUploadSchema = new Schema({ query: UploadQuery })

async function fakeAuth(c: Context, next: () => Promise<void>) {
  const name = c.req.header('x-test-user')
  if (name) setUser(c, fakeUser({ username: name }))
  await next()
}

const GQL = 'application/graphql-response+json'
const SINGLE = 'mutation ($file: Upload!) { single(file: $file) { name type size text } }'

function form(operations: unknown, map: unknown, files: Record<string, Blob | string> = {}): FormData {
  const fd = new FormData()
  fd.append('operations', typeof operations === 'string' ? operations : JSON.stringify(operations))
  fd.append('map', typeof map === 'string' ? map : JSON.stringify(map))
  for (const [k, v] of Object.entries(files)) {
    if (typeof v === 'string') fd.append(k, v)
    else fd.append(k, v, (v as File).name ?? 'blob')
  }
  return fd
}

const file = (text: string, name = 'a.txt', type = 'text/plain') => new File([text], name, { type })

describe('GraphQL multipart uploads over HTTP', () => {
  const h = useHttp(() => ({
    middleware: [fakeAuth, CsrfMiddleware],
    urls: [
      path('graphql/', GraphQLView.asView({ schema })),
      path('batch/', GraphQLView.asView({ schema, batch: true })),
      path('small/', GraphQLView.asView({ schema, maxFileSize: 5, maxUploadSize: 2000, maxFiles: 2 })),
      path('off/', GraphQLView.asView({ schema, uploads: false })),
      path('none/', GraphQLView.asView({ schema: noUploadSchema })),
      path('open/', GraphQLView.asView({ schema, uploadCsrfPrevention: false })),
    ],
  }))
  const send = (url: string, fd: FormData, opts: { headers?: Record<string, string>; csrf?: boolean } = {}) =>
    h.client.post(url, {
      form: fd,
      headers: { accept: GQL, 'GraphQL-Require-Preflight': '1', ...(opts.headers ?? {}) },
      ...(opts.csrf === undefined ? {} : { csrf: opts.csrf }),
    })

  it('uploads one file into a variable', async () => {
    const res = await send(
      '/graphql/',
      form({ query: SINGLE, variables: { file: null } }, { 0: ['variables.file'] }, { 0: file('hello') }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      data: { single: { name: 'a.txt', type: 'text/plain', size: 5, text: 'hello' } },
    })
  })

  it('uploads files in a list, in an input object and one file at two paths', async () => {
    const list = await send(
      '/graphql/',
      form(
        {
          query: 'mutation ($files: [Upload!]!) { multiple(files: $files) { name text } }',
          variables: { files: [null, null] },
        },
        { a: ['variables.files.0'], b: ['variables.files.1'] },
        { a: file('one', 'one.txt'), b: file('two', 'two.txt') },
      ),
    )
    expect(await list.json()).toEqual({
      data: {
        multiple: [
          { name: 'one.txt', text: 'one' },
          { name: 'two.txt', text: 'two' },
        ],
      },
    })

    const input = await send(
      '/graphql/',
      form(
        {
          query: 'mutation ($input: AttachmentInput!) { attach(input: $input) }',
          variables: { input: { title: 'Doc', file: null } },
        },
        { 0: ['variables.input.file'] },
        { 0: file('body') },
      ),
    )
    expect(await input.json()).toEqual({ data: { attach: 'Doc: body' } })

    const twice = await send(
      '/graphql/',
      form(
        {
          query: 'mutation ($files: [Upload!]!) { multiple(files: $files) { text } }',
          variables: { files: [null, null] },
        },
        { 0: ['variables.files.0', 'variables.files.1'] },
        { 0: file('same') },
      ),
    )
    expect(await twice.json()).toEqual({ data: { multiple: [{ text: 'same' }, { text: 'same' }] } })
  })

  it('supports batched operations', async () => {
    const res = await send(
      '/batch/',
      form(
        [
          { query: SINGLE, variables: { file: null } },
          { query: 'mutation ($f: Upload) { optional(file: $f) }', variables: { f: null } },
          { query: 'mutation ($f: Upload) { optional(file: $f) }' },
        ],
        { 0: ['0.variables.file'], 1: ['1.variables.f'] },
        { 0: file('first'), 1: file('second', 'b.txt') },
      ),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      { data: { single: { name: 'a.txt', type: 'text/plain', size: 5, text: 'first' } } },
      { data: { optional: 'b.txt' } },
      { data: { optional: 'none' } },
    ])
    const notEnabled = await send(
      '/graphql/',
      form([{ query: SINGLE, variables: { file: null } }], { 0: ['0.variables.file'] }, { 0: file('x') }),
    )
    expect(notEnabled.status).toBe(400)
  })

  it('works through the graphqlQuery() test helper', async () => {
    const res = await graphqlQuery(h.client, SINGLE, { variables: { file: file('helper', 'h.txt') } })
    assertResponseNoErrors(res)
    expect(res.data.single).toEqual({ name: 'h.txt', type: 'text/plain', size: 6, text: 'helper' })
    const anonymous = await graphqlQuery(h.client, SINGLE, {
      variables: { file: file('x') },
      csrf: false,
    })
    assertResponseNoErrors(anonymous)
  })

  it.each([
    ['no operations', () => withoutField('operations'), 'Missing multipart field "operations"'],
    ['no map', () => withoutField('map'), 'Missing multipart field "map"'],
    ['invalid operations JSON', () => form('{nope', {}), '"operations" is not valid JSON'],
    ['invalid map JSON', () => form({ query: SINGLE }, '[', {}), '"map" is not valid JSON'],
    ['operations not an object', () => form('"x"', {}), 'must be a JSON object or array'],
    ['map not an object', () => form({ query: SINGLE }, ['variables.file']), '"map" must be a JSON object'],
    ['map entry not a list', () => mapped({ 0: 'variables.file' }), 'must be a non-empty array'],
    ['empty map entry', () => mapped({ 0: [] }), 'must be a non-empty array'],
    [
      'file part missing',
      () => form({ query: SINGLE, variables: { file: null } }, { 0: ['variables.file'] }),
      'File missing',
    ],
    [
      'map entry is not a file',
      () => form({ query: SINGLE, variables: { file: null } }, { 0: ['variables.file'] }, { 0: 'text' }),
      'is not a file',
    ],
    ['path outside variables', () => mapped({ 0: ['query'] }), 'Invalid object path "query"'],
    ['path to a missing key', () => mapped({ 0: ['variables.other'] }), 'Invalid object path'],
    [
      'path to a non-null value',
      () => form({ query: SINGLE, variables: { file: 'x' } }, { 0: ['variables.file'] }, { 0: file('x') }),
      'Invalid object path',
    ],
    ['prototype pollution', () => mapped({ 0: ['variables.__proto__.polluted'] }), 'Invalid object path'],
    ['empty segment', () => mapped({ 0: ['variables..file'] }), 'Invalid object path'],
    ['batch path on a single operation', () => mapped({ 0: ['0.variables.file'] }), 'Invalid object path'],
  ])('rejects a malformed request: %s', async (_name, build, message) => {
    const res = await send('/graphql/', build() as FormData)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.errors[0].message).toContain(message)
    expect((Object.prototype as any).polluted).toBeUndefined()
  })

  it('rejects a body that is not multipart at all', async () => {
    const res = await h.client.post('/graphql/', {
      body: 'garbage',
      headers: {
        'content-type': 'multipart/form-data; boundary=x',
        accept: GQL,
        'GraphQL-Require-Preflight': '1',
      },
    })
    expect(res.status).toBe(400)
    expect((await res.json()).errors[0].message).toBe('Malformed multipart/form-data body.')
  })

  it('enforces the per-file, file-count and total size limits', async () => {
    const big = await send(
      '/small/',
      form({ query: SINGLE, variables: { file: null } }, { 0: ['variables.file'] }, { 0: file('123456') }),
    )
    expect(big.status).toBe(413)
    expect((await big.json()).errors[0].message).toContain('at most 5 bytes per file')

    const many = await send(
      '/small/',
      form(
        { query: SINGLE, variables: { file: null } },
        { 0: ['variables.file'] },
        { 0: file('a'), 1: file('b'), 2: file('c') },
      ),
    )
    expect(many.status).toBe(413)
    expect((await many.json()).errors[0].message).toContain('at most 2 per request')

    // Content-Length over the limit: refused before reading
    const declared = await h.client.fetch(
      new Request('http://testserver/small/', {
        method: 'POST',
        headers: {
          'content-type': 'multipart/form-data; boundary=x',
          'content-length': '5000',
          'GraphQL-Require-Preflight': '1',
          accept: GQL,
        },
        body: 'x'.repeat(5000),
      }),
    )
    expect(declared.status).toBe(413)
    expect((await declared.json()).errors[0].message).toContain('at most 2000 bytes')

    // streamed (no Content-Length): cut off while reading
    const fd = form(
      { query: SINGLE, variables: { file: null } },
      { 0: ['variables.file'] },
      {
        0: file('x'.repeat(3000)),
      },
    )
    const encoded = new Request('http://testserver/', { method: 'POST', body: fd })
    const chunks = encoded.body!
    const streamed = await h.client.fetch(
      new Request('http://testserver/small/', {
        method: 'POST',
        headers: {
          'content-type': encoded.headers.get('content-type')!,
          'GraphQL-Require-Preflight': '1',
          accept: GQL,
        },
        body: chunks,
        duplex: 'half',
      } as RequestInit),
    )
    expect(streamed.status).toBe(413)
    expect((await streamed.json()).errors[0].message).toContain('Request body too large')
  })

  it('is off (415) when the schema has no Upload scalar or uploads: false', async () => {
    const fd = () => form({ query: '{ ok }', variables: {} }, {}, {})
    expect((await send('/off/', fd())).status).toBe(415)
    expect((await send('/none/', fd())).status).toBe(415)
    expect((await send('/graphql/', fd())).status).toBe(200)
  })

  describe('CSRF', () => {
    const op = () =>
      form(
        { query: 'mutation ($file: Upload) { whoami(file: $file) }', variables: { file: null } },
        { 0: ['variables.file'] },
        { 0: file('x') },
      )

    it('blocks anonymous multipart requests without a preflight header', async () => {
      const res = await h.client.post('/graphql/', { form: op(), headers: { accept: GQL }, csrf: false })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body.errors[0].extensions.code).toBe('CSRF_PREVENTION')
      expect(body.errors[0].message).toContain('GraphQL-Require-Preflight')
    })

    it.each([
      ['GraphQL-Require-Preflight', '1'],
      ['Apollo-Require-Preflight', 'true'],
      ['X-Apollo-Operation-Name', 'Upload'],
      ['Authorization', 'Token abc'],
      ['X-CSRFToken', 'anything'],
    ])('lets anonymous requests with %s through', async (header, value) => {
      const res = await h.client.post('/graphql/', {
        form: op(),
        headers: { accept: GQL, [header]: value },
        csrf: false,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { whoami: 'anonymous' } })
    })

    it('can be turned off with uploadCsrfPrevention: false', async () => {
      const res = await h.client.post('/open/', { form: op(), headers: { accept: GQL }, csrf: false })
      expect(res.status).toBe(200)
    })

    it('enforces the CSRF token for session-authenticated uploads', async () => {
      const missing = await h.client.post('/graphql/', {
        form: op(),
        headers: { accept: GQL, 'x-test-user': 'ann', 'GraphQL-Require-Preflight': '1' },
        csrf: false,
      })
      expect(missing.status).toBe(403)

      const header = await h.client.post('/graphql/', {
        form: op(),
        headers: { accept: GQL, 'x-test-user': 'ann' },
      })
      expect(header.status).toBe(200)
      expect(await header.json()).toEqual({ data: { whoami: 'ann' } })
    })

    it('accepts the CSRF token as a csrfmiddlewaretoken form field', async () => {
      h.client.setCookie('csrftoken', 'a'.repeat(32))
      const fd = op()
      fd.append('csrfmiddlewaretoken', 'a'.repeat(32))
      const res = await h.client.post('/graphql/', {
        form: fd,
        headers: { accept: GQL, 'x-test-user': 'ann' },
        csrf: false,
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ data: { whoami: 'ann' } })

      const cross = await h.client.post('/graphql/', {
        form: op(),
        headers: { accept: GQL, 'x-test-user': 'ann', origin: 'https://evil.example' },
        csrf: false,
      })
      expect(cross.status).toBe(403)
    })
  })

  function withoutField(name: 'operations' | 'map'): FormData {
    const fd = form({ query: SINGLE, variables: { file: null } }, { 0: ['variables.file'] }, { 0: file('x') })
    fd.delete(name)
    return fd
  }
  function mapped(map: unknown): FormData {
    return form({ query: SINGLE, variables: { file: null } }, map, { 0: file('x') })
  }
})

describe('the Upload scalar', () => {
  it('prints in the SDL', () => {
    expect(schema.printSchema()).toContain('scalar Upload')
    expect(printSchema(schema.graphqlSchema)).toContain('single(file: Upload!): FileInfo')
    expect(schema.printSchema()).toContain(
      '@specifiedBy(url: "https://github.com/jaydenseric/graphql-multipart-request-spec")',
    )
  })

  it('takes File and Blob variables through schema.execute()', async () => {
    const single = await schema.execute(SINGLE, { variables: { file: file('in-process', 'p.txt') } })
    expect(single).toEqual({
      data: { single: { name: 'p.txt', type: 'text/plain', size: 10, text: 'in-process' } },
    })
    const blob = await schema.execute(SINGLE, {
      variables: { file: new Blob(['raw'], { type: 'application/octet-stream' }) },
    })
    expect(blob.data).toEqual({
      single: { name: 'blob', type: 'application/octet-stream', size: 3, text: 'raw' },
    })
    const nested = await schema.execute('mutation ($input: AttachmentInput!) { attach(input: $input) }', {
      variables: { input: { title: 'T', file: file('n') } },
    })
    expect(nested.data).toEqual({ attach: 'T: n' })
    const list = await schema.execute('mutation ($files: [Upload!]!) { multiple(files: $files) { text } }', {
      variables: { files: [file('1'), new Blob(['2'])] },
    })
    expect(list.data).toEqual({ multiple: [{ text: '1' }, { text: '2' }] })
  })

  it('rejects non-file values and literals', async () => {
    const str = await schema.execute(SINGLE, { variables: { file: 'not a file' } })
    expect(str.errors?.[0].message).toContain('Upload value invalid')
    const literal = await schema.execute('mutation { single(file: "x") { name } }')
    expect(literal.errors?.[0].message).toMatch(/Upload/)
    expect(() => Upload.coerceOutputValue(file('x'))).toThrow('Upload cannot be used as an output type.')
  })
})

describe('uploadFormData() / processMultipartForm()', () => {
  it('extracts files into map entries and round-trips', () => {
    const a = file('a', 'a.txt')
    const b = file('b', 'b.txt')
    const fd = uploadFormData({
      query: 'q',
      variables: { one: a, list: [b, a], nested: { deep: [{ f: b }] }, n: 1, s: 'x', z: null },
    })
    expect(JSON.parse(fd.get('operations') as string)).toEqual({
      query: 'q',
      variables: { one: null, list: [null, null], nested: { deep: [{ f: null }] }, n: 1, s: 'x', z: null },
    })
    expect(JSON.parse(fd.get('map') as string)).toEqual({
      1: ['variables.one', 'variables.list.1'],
      2: ['variables.list.0', 'variables.nested.deep.0.f'],
    })
    const ops = processMultipartForm(fd) as any
    expect(ops.variables.one.name).toBe('a.txt')
    expect(ops.variables.list[0].name).toBe('b.txt')
    expect(ops.variables.nested.deep[0].f.name).toBe('b.txt')
    expect(ops.variables.n).toBe(1)
  })

  it('handles batches', () => {
    const fd = uploadFormData([{ query: 'a', variables: { f: file('1') } }, { query: 'b' }])
    expect(JSON.parse(fd.get('map') as string)).toEqual({ 1: ['0.variables.f'] })
    const ops = processMultipartForm(fd) as any[]
    expect(ops[0].variables.f).toBeInstanceOf(File)
    expect(ops[1]).toEqual({ query: 'b' })
  })

  it('throws UploadError with the HTTP status', () => {
    const fd = uploadFormData({ query: 'q', variables: { f: file('toolong') } })
    try {
      processMultipartForm(fd, { maxFileSize: 3 })
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(UploadError)
      expect((err as UploadError).status).toBe(413)
    }
  })
})
