// `Schema`: merges the Query / Mutation classes of every app into one graphql-js schema.

import type { RequestUser } from '@ghuri/core'
import {
  assertValidSchema,
  type ExecutionResult,
  type GraphQLNamedType,
  GraphQLSchema,
  getIntrospectionQuery,
  graphql,
  printSchema,
} from 'graphql'
import type { Context } from 'hono'
import { declaredFields, TypeBuilder } from './builder'
import { createGraphQLContext, type GraphQLContext, isGraphQLContext } from './context'
import { GraphQLConfigurationError } from './errors'
import type { OptimizeOptions } from './optimizer'
import type { TypeRef } from './types/definitions'

export interface SchemaOptions {
  /** Query classes (`static fields` are merged into the root `Query` type). */
  query: Function | Function[]
  /** Mutation classes (`static fields` are merged into the root `Mutation` type). */
  mutation?: Function | Function[]
  /** Extra types to include (e.g. types only reachable through `node(id:)` or generated relations). */
  types?: TypeRef[]
  /** Apply the query optimizer to root list / connection QuerySets. */
  optimize?: boolean | OptimizeOptions
  description?: string
}

export interface ExecuteOptions {
  variables?: Record<string, unknown> | null
  operationName?: string | null
  /** User for `info.context.user` (default AnonymousUser). */
  user?: RequestUser
  auth?: unknown
  /** Hono context, when executing inside a request. */
  c?: Context
  /** A full context, or extra keys merged into a new one. */
  context?: GraphQLContext | Record<string, unknown>
  rootValue?: unknown
}

function arr<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v]
}

/**
 * The GraphQL schema of a project (graphene's `graphene.Schema`):
 *
 * ```ts
 * export const schema = new Schema({ query: [BlogQuery, ShopQuery], mutation: [BlogMutation] })
 * const result = await schema.execute('{ allPosts { totalCount } }', { user })
 * ```
 */
export class Schema {
  readonly graphqlSchema: GraphQLSchema
  readonly builder: TypeBuilder

  constructor(readonly options: SchemaOptions) {
    const b = new TypeBuilder({ optimize: options.optimize })
    this.builder = b
    const queries = arr(options.query)
    const mutations = arr(options.mutation)
    if (!queries.length) throw new GraphQLConfigurationError('Schema needs at least one query class.')
    for (const cls of [...queries, ...mutations])
      for (const ref of Object.values(declaredFields(cls))) b.discover(ref)
    for (const t of options.types ?? []) b.discover(t)
    const query = b.rootType('Query', queries)!
    const mutation = b.rootType('Mutation', mutations)
    const roots = new Set<Function>([...queries, ...mutations])
    const types: GraphQLNamedType[] = []
    for (const t of options.types ?? []) types.push(b.output(t) as GraphQLNamedType)
    for (const cls of b.discoveredClasses()) {
      if (roots.has(cls)) continue
      const kind = (cls as any).__ghuriType
      if (!['object', 'interface', 'union', 'enum', 'input'].includes(kind)) continue
      types.push(b.classType(cls))
    }
    this.graphqlSchema = new GraphQLSchema({ query, mutation, types, description: options.description })
    assertValidSchema(this.graphqlSchema)
  }

  /** Run an operation (no HTTP): `await schema.execute('{ me { username } }', { user })`. */
  async execute(source: string, opts: ExecuteOptions = {}): Promise<ExecutionResult> {
    const contextValue = isGraphQLContext(opts.context)
      ? opts.context
      : createGraphQLContext({ c: opts.c, user: opts.user, auth: opts.auth, extra: opts.context })
    return graphql({
      schema: this.graphqlSchema,
      source,
      rootValue: opts.rootValue,
      contextValue,
      variableValues: opts.variables ?? undefined,
      operationName: opts.operationName ?? undefined,
    })
  }

  /** The schema in SDL. */
  printSchema(): string {
    return printSchema(this.graphqlSchema)
  }

  toString(): string {
    return this.printSchema()
  }

  getType(name: string): GraphQLNamedType | undefined {
    return this.graphqlSchema.getType(name) ?? undefined
  }

  /** The introspection result (`{ __schema { … } }`), e.g. for client code generators. */
  async introspect(): Promise<Record<string, unknown>> {
    const result = await graphql({
      schema: this.graphqlSchema,
      source: getIntrospectionQuery(),
      contextValue: createGraphQLContext(),
    })
    if (result.errors?.length) throw result.errors[0]
    return result.data as Record<string, unknown>
  }
}

/** A graphql-js schema from a `Schema`, a graphql-js schema or a thunk. */
export function toGraphQLSchema(s: unknown): GraphQLSchema {
  const v = typeof s === 'function' ? (s as () => unknown)() : s
  if (v instanceof GraphQLSchema) return v
  if (v && typeof v === 'object' && (v as any).graphqlSchema instanceof GraphQLSchema)
    return (v as any).graphqlSchema
  throw new GraphQLConfigurationError('Expected a Schema (new Schema({...})) or a graphql-js GraphQLSchema.')
}
