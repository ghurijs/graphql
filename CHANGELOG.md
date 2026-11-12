# Changelog

## Unreleased

- **Security fix: relation types are resolved per schema.** With several `Schema`s in one process, a generated
  relation (`ForeignKey`, one-to-one, reverse FK, M2M) on one schema's `ModelType` could resolve to a `ModelType`
  of the *other* schema for the same model, through the process-wide registry `TypeBuilder.typeForModel` fell
  back to. A public schema could then expose an admin-only type and its fields (in the SDL, through the relation
  and through `node(id:)`). A schema now only uses types reachable from its own `query`, `mutation` and `types`:
  relations to a model without a `ModelType` in the schema are skipped (an error when listed in `Meta.fields`),
  as documented. The same scoping applies to `node` / `nodes` (an ID of another schema's type is `Relay Node "X"
  not found in schema.`), connection types, global-ID decoding in filters and mutation inputs, `ModelMutation`
  payloads and lookups, and type references by name.
- Behaviour change: a `ModelType` that was only reachable through the registry (referenced by `Field()` / `List()`
  in a class outside the schema, or `registerType()`) is no longer added to a schema; list it in
  `new Schema({ types: [...] })`. `registerType()` is deprecated (it only feeds configuration error hints now).
- The error for a relation listed in `Meta.fields` without a type now reads `X.field: no ModelType for app.Model is
  part of this schema (...)` and names the `ModelType`s that exist outside the schema.

## 0.1.0-alpha.1

- `GraphQLView` throttling with the `@ghuri/rest` throttle classes: `throttleClasses` / `throttleScope` options
  (default `GRAPHQL.DEFAULT_THROTTLE_CLASSES`, else none), checked once per HTTP request (batches count once) after
  authentication. Throttled requests get 429, `Retry-After` and `extensions: { code: "THROTTLED", wait }`; the
  GraphiQL page is not throttled. Override `throttled(request, wait)` to customize the error.

## 0.1.0-alpha.0

- `Schema` builds the graphql-js schema on first use (`graphqlSchema`, `execute()`, `printSchema()`, the view) instead of in the constructor, so a project's `src/schema.ts` can be imported by the settings module (`GRAPHQL.SCHEMA`) before `INSTALLED_APPS` assign app labels. `schema.validate()` builds it eagerly and throws configuration errors.
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
