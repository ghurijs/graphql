import { settingsFor, tryGetContext } from '@ghuri/core'
import type { Context } from 'hono'

/** Anything `GraphQLView` accepts as a schema (a `Schema`, a graphql-js schema, or a thunk returning one). */
export type SchemaLike = { readonly graphqlSchema: unknown } | import('graphql').GraphQLSchema

/** The `GRAPHQL` setting (graphene-django's `GRAPHENE` dict). */
export interface GraphQLSettings {
  /** Default schema for `GraphQLView` and the `graphql_schema` command. */
  SCHEMA?: SchemaLike | (() => SchemaLike)
  /** Serve GraphiQL to browsers (default: `DEBUG`). */
  GRAPHIQL?: boolean
  /** Maximum selection depth (default: unlimited). */
  MAX_DEPTH?: number
  /** Maximum query complexity (default: unlimited). See `complexityLimit()`. */
  MAX_COMPLEXITY?: number
  /** Allow introspection queries (default true). */
  INTROSPECTION?: boolean
  /** Maximum `first` / `last` of Relay connections; also the default page size (default 100). */
  RELAY_CONNECTION_MAX_LIMIT?: number
  /** Accept batched (array) requests in `GraphQLView` (default false). */
  BATCH?: boolean
  /** Default authentication classes of `GraphQLView` (default: the core request user). */
  AUTHENTICATION_CLASSES?: Array<new () => { authenticate(c: Context): Promise<[any, unknown] | null> }>
  /**
   * Default throttle classes of `GraphQLView` (default: none). `@ghuri/rest` throttles; their rates come from
   * `REST_FRAMEWORK.DEFAULT_THROTTLE_RATES`. `REST_FRAMEWORK.DEFAULT_THROTTLE_CLASSES` does not apply here.
   */
  DEFAULT_THROTTLE_CLASSES?: Array<
    new () => {
      allowRequest(request: any, view: any): boolean | Promise<boolean>
      wait?(): number | null
    }
  >
  /** Apply the query optimizer (`selectRelated` / `prefetchRelated`) to root QuerySets (default false). */
  OPTIMIZE?: boolean
}

declare module '@ghuri/core' {
  interface GhuriSettings {
    GRAPHQL?: GraphQLSettings
  }
}

export const DEFAULT_MAX_LIMIT = 100

/** Current `GRAPHQL` settings merged with defaults (works outside a request: defaults only). */
export function graphqlSettings(c?: Context): GraphQLSettings & { DEBUG: boolean } {
  let s: Record<string, unknown> | undefined
  try {
    s = (c ? settingsFor(c) : tryGetContext()?.settings) as Record<string, unknown> | undefined
  } catch {
    s = undefined
  }
  const g = (s?.GRAPHQL ?? {}) as GraphQLSettings
  return {
    INTROSPECTION: true,
    RELAY_CONNECTION_MAX_LIMIT: DEFAULT_MAX_LIMIT,
    BATCH: false,
    OPTIMIZE: false,
    ...g,
    DEBUG: !!s?.DEBUG,
  }
}
