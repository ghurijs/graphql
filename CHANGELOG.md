# Changelog

## Unreleased

- `GraphQLView` throttling with the `@ghuri/rest` throttle classes: `throttleClasses` / `throttleScope` options
  (default `GRAPHQL.DEFAULT_THROTTLE_CLASSES`, else none), checked once per HTTP request (batches count once) after
  authentication. Throttled requests get 429, `Retry-After` and `extensions: { code: "THROTTLED", wait }`; the
  GraphiQL page is not throttled. Override `throttled(request, wait)` to customize the error.
- `Schema` builds the graphql-js schema on first use (`graphqlSchema`, `execute()`, `printSchema()`, the view) instead of in the constructor, so a project's `src/schema.ts` can be imported by the settings module (`GRAPHQL.SCHEMA`) before `INSTALLED_APPS` assign app labels. `schema.validate()` builds it eagerly and throws configuration errors.

## 0.1.0-alpha.0

- Initial alpha (ARCHITECTURE.md §15).
- Code-first type system on graphql-js 17: `ObjectType`, `InputObjectType`, `Interface`, `Union`, `Enum`,
  `Field` / `List` / `NonNull` / `Argument`, scalars (`DateTime`, `Date`, `Time`, `Decimal`, `JSON`, `UUID`,
  `BigInt`, `Base64`), `Query` / `Mutation` classes merged by `Schema` across apps.
- `ModelType`: object types from ORM `_meta` (every field type, choices → enums, FK / reverse FK / M2M / one-to-one
  relations, file URLs), `resolveX` methods, `getQueryset()` row-level scoping, type permission classes,
  `registerFieldConverter()`.
- Per-request DataLoaders for every relation (no N+1) and an optional `selectRelated` / `prefetchRelated` / `only`
  optimizer.
- Relay: `Node` interface, global IDs, `node` / `nodes` fields, `ConnectionField` with cursor pagination
  (both directions, `totalCount`, `RELAY_CONNECTION_MAX_LIMIT`), nested `filter:` inputs from `filterFields`
  (ORM lookups, and / or / not, global IDs), `orderBy`, custom connection classes.
- Mutations: `Mutation`, `ClientIDMutation`, `SerializerMutation` (REST serializers, `errors: [ErrorType]`),
  `ModelMutation` (create / update / delete via `lookupField`, REST permission classes).
- Auth: `loginRequired`, `staffMemberRequired`, `superuserRequired`, `permissionRequired`, `userPassesTest`;
  permission classes on fields, mutations and types.
- `GraphQLView`: GraphQL over HTTP (GET / POST, `application/graphql-response+json` status codes), GraphiQL,
  REST authentication classes, CSRF for session auth only, batching, depth / complexity limits, introspection
  toggle, persisted queries, error masking.
- `GRAPHQL` settings, `GraphQLConfig` app with the `graphql_schema` command, `@ghuri/graphql/testing`.
