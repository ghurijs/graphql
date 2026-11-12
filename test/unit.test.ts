import { CharField, Model, type QuerySet } from '@ghuri/orm'
import { GraphQLError, parse } from 'graphql'
import { describe, expect, it } from 'vitest'
import {
  createGraphQLContext,
  errorsToList,
  Field,
  formatError,
  List,
  loginRequired,
  ModelType,
  negotiateMediaType,
  operationComplexity,
  operationDepth,
  paginateArray,
  Query,
  Schema,
} from '../src/index'
import { fakeUser } from './helpers'

describe('helpers', () => {
  it('computes depth and complexity', () => {
    const doc = parse(
      'query { a(first: 10) { edges { node { b c } } } d ...F } fragment F on Query { e { f } }',
    )
    const op = doc.definitions[0] as any
    const frags = (n: string) => doc.definitions.find((d: any) => d.name?.value === n) as any
    expect(operationDepth(op, frags)).toBe(4)
    // a: 1 + 10 * (edges: 1 + node: (1 + 2)) = 41; d: 1; e: 1 + 1 = 2
    expect(operationComplexity(op, frags)).toBe(44)
  })

  it('negotiates media types', () => {
    expect(negotiateMediaType(undefined)).toBe('application/json')
    expect(negotiateMediaType('application/json, application/graphql-response+json;q=0.9')).toBe(
      'application/json',
    )
    expect(negotiateMediaType('application/graphql-response+json, application/json;q=0.9')).toBe(
      'application/graphql-response+json',
    )
    expect(negotiateMediaType('text/html')).toBeNull()
  })

  it('flattens validation errors', () => {
    expect(
      errorsToList({ title: ['Too long.'], tags: [{ name: ['Bad.'] }, {}], nonFieldErrors: ['Nope.'] }),
    ).toEqual([
      { field: 'title', messages: ['Too long.'] },
      { field: 'tags.0.name', messages: ['Bad.'] },
      { field: 'nonFieldErrors', messages: ['Nope.'] },
    ])
    expect(errorsToList(['Whole input is wrong.'])).toEqual([
      { field: '__all__', messages: ['Whole input is wrong.'] },
    ])
  })

  it('paginates arrays in both directions', async () => {
    const list = [1, 2, 3, 4, 5]
    const a = await paginateArray(list, { first: 2 }, { maxLimit: 10 })
    expect(a.edges.map((e) => e.node)).toEqual([1, 2])
    expect(a.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false })
    const b = await paginateArray(list, { last: 2, before: a.edges[1].cursor }, { maxLimit: 10 })
    expect(b.edges.map((e) => e.node)).toEqual([1])
    expect(await b.totalCount()).toBe(5)
    const all = await paginateArray(list, {}, { maxLimit: 3 })
    expect(all.edges).toHaveLength(3)
  })

  it('decorators work on resolvers and need a context', async () => {
    const r = loginRequired((_p: unknown, args: { x: number }, _info: unknown) => args.x * 2)
    const info = { fieldName: 'f', context: createGraphQLContext({ user: fakeUser() }) } as any
    expect(await r(null, { x: 2 }, info)).toBe(4)
    await expect(
      r(null, { x: 2 }, { fieldName: 'f', context: createGraphQLContext() } as any),
    ).rejects.toThrow('Authentication credentials were not provided.')
  })

  it('formatError masks unknown errors but not GraphQL ones', () => {
    const masked = formatError(new GraphQLError('x', { originalError: new Error('db down') }), {
      log: () => {},
    })
    expect(masked).toMatchObject({
      message: 'Internal server error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    const plain = formatError(new GraphQLError('Syntax Error'))
    expect(plain.message).toBe('Syntax Error')
  })

  it('rejects async getQueryset (a QuerySet is thenable)', async () => {
    class Thing extends Model({ name: new CharField({ maxLength: 5 }) }) {
      static Meta = { appLabel: 'blog' }
    }
    class ThingType extends ModelType {
      static override Meta = { model: Thing }
      // what an `async getQueryset()` returns: a promise (here of an array; with a QuerySet it would run it)
      static override getQueryset(_qs: QuerySet<Thing>): any {
        return Promise.resolve([])
      }
    }
    const schema = new Schema({
      query: class extends Query {
        static override fields = { things: List(ThingType), f: Field(String) }
      },
    })
    const r = await schema.execute('{ things { name } }')
    expect(r.errors?.[0].message).toContain('must return a QuerySet synchronously')
  })
})
