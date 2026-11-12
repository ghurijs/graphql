# @ghuri/graphql

GraphQL for [Ghuri](https://github.com/ghurijs/ghuri), in the style of **graphene-django**: object types generated
from your models, `Query` / `Mutation` classes per app merged into one schema, Relay nodes and connections with
filters, mutations powered by your **@ghuri/rest serializers and permission classes**, the same authentication
classes as your REST API, and a GraphQL-over-HTTP view with GraphiQL. Runs on Cloudflare Workers (D1) and Node
(SQLite / Postgres).

> Status: alpha. Built on [graphql-js](https://github.com/graphql/graphql-js) v17 (a peer dependency).

```sh
npm install @ghuri/graphql graphql
```

## Contents

1. [Types from models](#1-types-from-models)
2. [Queries](#2-queries)
3. [Relations](#3-relations-no-n1)
4. [Relay: nodes, connections, filters, ordering](#4-relay-nodes-connections-filters-and-ordering)
5. [Mutations](#5-mutations)
6. [Authentication and permissions](#6-authentication-and-permissions)
7. [The view, GraphiQL, throttling and settings](#7-the-view-graphiql-and-settings)
8. [Performance](#8-performance)
9. [Testing](#9-testing)
10. [For graphene-django users](#10-for-graphene-django-users)

## 1. Types from models

```ts
// src/blog/schema.ts
import { Field, ModelType, Node, String as GString } from '@ghuri/graphql'
import type { QuerySet } from '@ghuri/orm'
import { Post, Tag } from './models'

export class TagType extends ModelType {
  static Meta = { model: Tag, fields: ['id', 'name'] }
}

export class PostType extends ModelType {
  static Meta = {
    model: Post,
    fields: ['id', 'title', 'body', 'author', 'tags', 'status', 'createdAt'], // or '__all__' / exclude: [...]
    interfaces: [Node],
    filterFields: { title: ['icontains'], published: ['exact'] },
    orderBy: ['createdAt', 'title'],
  }
  // extra fields
  static fields = {
    excerpt: Field(GString, { resolve: (post: Post) => post.body.slice(0, 100) }),
  }
  // or resolvers for any field: resolveX(parent, args, info)
  static resolveTitle(post: Post) {
    return post.title.trim()
  }
  // row-level scoping, applied wherever PostType objects are fetched
  static getQueryset(qs: QuerySet<Post>, info) {
    return info.context.user.isStaff ? qs : qs.filter({ published: true })
  }
}
```

Field mapping (`internalType`, walking up the class chain; add your own with
`registerFieldConverter('MoneyField', () => Decimal)`):

| ORM field | GraphQL |
|---|---|
| primary key | `ID!` (global ID with `Node`) |
| `CharField`, `TextField`, `SlugField`, `EmailField`, `URLField`, `GenericIPAddressField` | `String` |
| `IntegerField`, `SmallIntegerField`, `Positive*IntegerField` | `Int` |
| `BigIntegerField`, `PositiveBigIntegerField` | `BigInt` (number when safe, else string) |
| `FloatField`, `DurationField` (ms) | `Float` |
| `DecimalField` | `Decimal` (string) |
| `BooleanField` | `Boolean` |
| `DateField` / `DateTimeField` / `TimeField` | `Date` / `DateTime` / `Time` |
| `UUIDField` | `UUID` |
| `JSONField` | `JSON` |
| `BinaryField` | `Base64` |
| `FileField`, `ImageField` | `String` (the file URL) |
| field with `choices` | enum `<Model><Field>` (`PostStatus { DRAFT IN_REVIEW LIVE }`), disable with `Meta.convertChoicesToEnum` |
| `ForeignKey`, `OneToOneField` | the related type |
| reverse FK, `ManyToManyField`, reverse M2M | `[Related!]!`, or a connection when the related type implements `Node` |
| reverse one-to-one | the related type (nullable) |

Fields are non-null unless the model field has `null: true`. Relations to models that have no `ModelType` are
skipped (an error if you list them in `fields`).

Plain types work like graphene's:

```ts
import { Argument, Enum, Field, InputObjectType, Int, Interface, List, NonNull, ObjectType, String as GString, Union } from '@ghuri/graphql'

class Named extends Interface { static fields = { name: NonNull(GString) } }
class Person extends ObjectType {
  static Meta = { interfaces: [Named] }
  static fields = () => ({ name: NonNull(GString), friends: List(Person) })  // thunk for self references
}
class Episode extends Enum { static values = { NEWHOPE: 4, EMPIRE: 5, JEDI: 6 } }
const Color = Enum.from('Color', { RED: 'r', GREEN: 'g' })                 // or from a TS enum
class SearchResult extends Union { static Meta = { types: [PostType, Person] } }
class PostFilterInput extends InputObjectType { static fields = { title: GString, limit: Argument(Int, { defaultValue: 10 }) } }
```

Type references can be classes, graphql-js types, the exported scalars (`String`, `Int`, `Float`, `Boolean`, `ID`,
`DateTime`, `DateScalar`, `Time`, `Decimal`, `JSONScalar`, `UUID`, `BigIntScalar`, `Base64`), the JS
constructors `String` / `Number` / `Boolean` / `Date` / `BigInt` / `JSON`, a type name, or a thunk.

## 2. Queries

Every app defines a `Query` class; the schema merges them (name clashes are errors):

```ts
import { ConnectionField, Field, ID, List, NonNull, Query, Schema } from '@ghuri/graphql'

export class BlogQuery extends Query {
  static fields = {
    posts: List(PostType),                                       // root lists default to Model.objects.all()
    published: List(PostType, { resolve: () => Post.objects.filter({ published: true }) }),
    post: Field(PostType, { args: { id: NonNull(ID) }, resolve: (_, { id }) => Post.objects.get({ id }) }),
    allPosts: ConnectionField(PostType),
  }
}

// src/schema.ts
export const schema = new Schema({ query: [BlogQuery, ShopQuery], mutation: [BlogMutation] })
```

The schema is built on first use, so `src/schema.ts` can be imported from your settings (`GRAPHQL.SCHEMA`)
before the apps are loaded; `schema.validate()` builds it eagerly (configuration errors throw). Model types that
are only reachable through relations (e.g. `CommentType` via `post.comments`) go in `types: [...]`.

Resolvers receive `(parent, args, info)`; `info.context` is `{ c, user, auth, loaders, request, state }` (`c` is
the Hono context). Argument types are inferred from `args`. `schema.execute(query, { user, variables })` runs an
operation without HTTP, `schema.printSchema()` returns the SDL.

QuerySets returned by resolvers of `ModelType` lists go through the type's `getQueryset()` (and the optimizer).
Return them **synchronously**: a QuerySet is thenable, so an `async` resolver (or `getQueryset`) that returns one
runs the query. For the same reason `getQueryset()` must be synchronous.

## 3. Relations (no N+1)

```graphql
{ posts { title author { username } tags { name } comments { text } } }
```

Foreign keys, reverse foreign keys, one-to-ones and many-to-many relations are resolved through **per-request
DataLoaders**: one batched `__in` query per relation and nesting level (two for many-to-many: links, then
targets), whatever the number of rows. `selectRelated` / `prefetchRelated` results are reused when present.
The related type's `getQueryset()` is applied to every relation. Use `info.context.loaders.get(key, batchFn)` for
your own loaders.

## 4. Relay: nodes, connections, filters and ordering

```ts
class RelayQuery extends Query {
  static fields = {
    node: Node.Field(),                 // node(id: ID!): Node
    nodes: Node.ListField(),            // nodes(ids: [ID!]!): [Node]!
    post: Node.Field(PostType),         // typed: post(id: ID!): PostType
    allPosts: ConnectionField(PostType, { orderBy: ['createdAt', 'title'], maxLimit: 50 }),
  }
}
```

Global IDs are `base64("PostType:42")` (`toGlobalId` / `fromGlobalId`). Plain `ObjectType`s can implement `Node`
with a `static getNode(id, info)`.

```graphql
{
  allPosts(first: 10, after: "YXJyYXljb25uZWN0aW9uOjk=",
           filter: { title: { icontains: "ghuri" }, or: [{ published: { exact: true } }, { authorUsername: { exact: "ann" } }] },
           orderBy: ["-createdAt"]) {
    totalCount
    pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    edges { cursor node { id title } }
  }
}
```

- Pagination: `first`/`after` and `last`/`before`, offset cursors (graphene-compatible). Without `first`/`last`
  the page size is `RELAY_CONNECTION_MAX_LIMIT` (default 100); asking for more is an error. `totalCount` and
  `count()` queries only run when needed.
- **Filters** (design decision): one nested `filter:` input per type instead of graphene-django-filter's flat
  `title_Icontains` arguments. `filterFields` (`['title']` → `exact`, or `{ title: ['icontains', 'exact'] }`)
  generates `<Type>Filter` with one `<Type><Field>Filter` per field whose members are the allowed ORM lookups
  (`exact`, `iexact`, `contains`, `icontains`, `in`, `gt`, `gte`, `lt`, `lte`, `startswith`, `istartswith`,
  `endswith`, `iendswith`, `range`, `isnull`, `regex`, `year`, `month`, `day`, `date`, …). Relations span with
  `__` (`author__username` → `authorUsername`); ids accept raw pks and global IDs. Combine with `and`, `or`, `not`.
- **Ordering**: `orderBy: [String!]` (`"-createdAt"`), allowed fields from the `orderBy` option or `Meta.orderBy`
  (`'__all__'`: every concrete field). Results always get a stable order (pk appended).
- Reverse / M2M relations to `Node` types are connections too (paginated in memory over one batched query, with
  the related type's filters and ordering).
- Custom connection types: `class PostConnection extends Connection { static fields = { … } }` in
  `Meta.connectionClass`; their resolvers get `{ edges, pageInfo, totalCount(), iterable, args }`.

## 5. Mutations

### With a REST serializer (recommended)

Your DRF-style serializer does validation, `create()` / `update()` and field-level checks:

```ts
import { IsAuthenticated, ModelSerializer } from '@ghuri/rest'
import { Mutation, SerializerMutation } from '@ghuri/graphql'

class PostSerializer extends ModelSerializer {
  static Meta = { model: Post, fields: ['id', 'title', 'body', 'tags'] }
  validateTitle(value: string) { if (value.includes('spam')) throw new ValidationError('No spam'); return value }
}

class SavePost extends SerializerMutation {
  static Meta = { serializerClass: PostSerializer, permissionClasses: [IsAuthenticated] }
}

export class BlogMutation extends Mutation {
  static fields = { savePost: SavePost.field() }
}
```

```graphql
mutation {
  savePost(input: { title: "Hello", tags: ["1"], clientMutationId: "a1" }) {
    id title errors { field messages } clientMutationId
  }
}
```

The input (`SavePostInput`) holds the writable serializer fields; the payload the readable ones plus
`errors: [ErrorType!]` and `clientMutationId`. With `id` (`Meta.lookupField`) in the input it updates
(`partial: true`, object found through the model type's `getQueryset`), otherwise it creates
(`Meta.modelOperations` restricts). Validation errors come back in `errors` (graphene-django style), not as GraphQL
errors. The serializer context has `request` (with `user`), so `CurrentUserDefault` works. Override
`getSerializerKwargs()` / `performMutate()` to customize.

`@ghuri/rest` is an optional peer: the package never imports it, you pass your classes in.

### Model mutations

```ts
class CreatePost extends ModelMutation {
  static Meta = { model: Post, operation: 'create', fields: ['title', 'body', 'tags'], permissionClasses: [ModelPermissions] }
}
class UpdatePost extends ModelMutation { static Meta = { model: Post, operation: 'update', serializerClass: PostSerializer } }
class DeletePost extends ModelMutation { static Meta = { model: Post, operation: 'delete', permissionClasses: [IsOwner] } }
```

Input `{ …fields, id (update/delete), clientMutationId }`; payload `{ post, errors, clientMutationId }` or
`{ ok, deletedId, errors, clientMutationId }`. Without a serializer the instance is validated with `fullClean()`.
Permission classes see `request.method` `POST` / `PATCH` / `DELETE` (so `ModelPermissions` checks `add_` /
`change_` / `delete_`), and `hasObjectPermission` runs on the object.

### Plain mutations

```ts
class PublishPost extends Mutation {
  static Arguments = { id: NonNull(ID) }
  static fields = { post: Field(PostType), ok: Boolean }       // payload: PublishPostPayload
  static mutate = loginRequired(async (_root, { id }, info) => {
    const post = await Post.objects.get({ id })
    post.published = true
    await post.save()
    return { post, ok: true }
  })
}

class IntroduceShip extends ClientIDMutation {                 // Relay: input + clientMutationId
  static Input = { name: NonNull(String) }
  static fields = { ship: Field(ShipType) }
  static async mutateAndGetPayload(_root, input, info) { return { ship: await Ship.objects.create(input) } }
}
```

## 6. Authentication and permissions

`info.context.user` is the request user. In the view, `authenticationClasses` are the REST ones:

```ts
import { SessionAuthentication, TokenAuthentication, JWTAuthentication } from '@ghuri/auth/rest'
path('graphql/', GraphQLView.asView({ schema, authenticationClasses: [SessionAuthentication, JWTAuthentication] }))
```

- Without them (and without `GRAPHQL.AUTHENTICATION_CLASSES`) the core request user (`AuthenticationMiddleware`)
  is used.
- **CSRF**: the view is exempt from `CsrfMiddleware` (so token / JWT clients work); CSRF is enforced for
  session-authenticated `POST`s (`SessionAuthentication`, or the core-user fallback). Invalid credentials give
  401 (+ `WWW-Authenticate`), CSRF failures 403.

Resolver decorators (also usable as TC39 method decorators):

```ts
me: Field(UserType, { resolve: loginRequired((_, __, info) => info.context.user) }),
stats: Field(StatsType, { resolve: staffMemberRequired(resolveStats) }),
export: Field(String, { resolve: permissionRequired('blog.export_post')(resolveExport) }),
// also superuserRequired, userPassesTest(test)
```

Anonymous users get `extensions.code: "UNAUTHENTICATED"`, others `"PERMISSION_DENIED"`.

REST permission classes:

- on fields: `Field(PostType, { permissionClasses: [IsAuthenticated], resolve })` (and `ConnectionField`);
- on mutations: `Meta.permissionClasses` (`hasPermission`, plus `hasObjectPermission` for updates / deletes);
- on types: `ModelType` `Meta.permissionClasses` — `hasPermission` once per request whenever the type is
  resolved, `hasObjectPermission` per object (lists drop hidden objects, single fields raise `PERMISSION_DENIED`,
  `node` returns null).
- row-level scoping: `getQueryset(qs, info)` on the type.

## 7. The view, GraphiQL and settings

```ts
import { GraphQLView } from '@ghuri/graphql'
export const urlpatterns = [path('graphql/', GraphQLView.asView({ schema, graphiql: true }))]
```

GraphQL over HTTP (spec-compliant):

- `GET` with `query` / `variables` / `operationName` (queries only: mutations → **405**, `Allow: POST`), `POST`
  with `application/json`, `application/graphql` or a form.
- `Accept: application/graphql-response+json` → that media type; parse / validation / variable errors → **400**;
  executed requests → 200 (errors in `errors`). `application/json` (or no `Accept`) → 200 for every well-formed
  request. Malformed JSON / missing query → 400, other content types → 415, unacceptable `Accept` → 406.
- `batch: true` accepts arrays of operations.
- `maxDepth`, `maxComplexity` (`first`/`last` multiply nested costs), `introspection: false`,
  `validationRules`, `persistedQueries` (`documentId` or APQ `sha256Hash` → query text; `persistedQueriesOnly`),
  `getContext(c, ctx)` to add context keys.
- Errors: unexpected exceptions become `"Internal server error"` (logged); `GhuriError` subclasses (permission,
  validation, not found, REST `APIException`s) keep their message; every error has `extensions.code`. With
  `DEBUG` the original message and stack are in `extensions.exception`.
- GraphiQL (pinned CDN assets) for browsers when `graphiql` / `GRAPHQL.GRAPHIQL` / `DEBUG`; it sends the CSRF
  token. Add `?raw` to get JSON in a browser.

### Throttling

`throttleClasses` takes the `@ghuri/rest` throttles as they are (`AnonRateThrottle`, `UserRateThrottle`,
`ScopedRateThrottle` with `throttleScope`, your own `SimpleRateThrottle` subclasses); the default is
`GRAPHQL.DEFAULT_THROTTLE_CLASSES`, else none (`REST_FRAMEWORK.DEFAULT_THROTTLE_CLASSES` does not apply to
GraphQL). Rates come from `REST_FRAMEWORK.DEFAULT_THROTTLE_RATES` and request history from the
`REST_FRAMEWORK.THROTTLE_CACHE` cache (default `'default'`: use a shared cache such as `kvCache()` in production).

- Checked once per HTTP request (a batch of operations counts once), after authentication (so
  `UserRateThrottle` sees the user) and before anything executes. Requests rejected earlier (406, 415, malformed
  JSON) are not counted.
- Throttled → **429**, `Retry-After: <seconds>` when the throttle knows the wait, and
  `{ "errors": [{ "message": "Request was throttled. Expected available in 42 seconds.", "extensions": { "code": "THROTTLED", "wait": 42 } }] }`
  (`wait: null` and no `Retry-After` when unknown).
- The GraphiQL page (`GET` from a browser) is never throttled; the operations it sends are.
- Throttles receive a `PermissionRequest` (`user`, `auth`, `method`, `header()`, `c`) and the view. Override
  `throttled(request, wait)` to change the error (throwing REST's `Throttled` works).

Per-token limits for a public storefront API:

```ts
import { SimpleRateThrottle, AnonRateThrottle } from '@ghuri/rest'

class StorefrontTokenThrottle extends SimpleRateThrottle {
  scope = 'storefront'
  getCacheKey(request) {
    const token = request.header('X-Storefront-Token')
    return token ? this.formatKey({ scope: this.scope, ident: token }) : null   // null: not throttled
  }
}

path('storefront/graphql/', GraphQLView.asView({ schema, throttleClasses: [StorefrontTokenThrottle, AnonRateThrottle] }))

// settings
REST_FRAMEWORK: { DEFAULT_THROTTLE_RATES: { storefront: '1000/min', anon: '60/min' } },
CACHES: { default: kvCache('CACHE') },
```

Settings (`GRAPHQL`, typed via `GhuriSettings`):

```ts
GRAPHQL: {
  SCHEMA: schema,                 // default schema of GraphQLView and the graphql_schema command
  GRAPHIQL: true,                 // default: DEBUG
  MAX_DEPTH: 10,
  MAX_COMPLEXITY: 5000,
  INTROSPECTION: true,
  RELAY_CONNECTION_MAX_LIMIT: 100,
  BATCH: false,
  AUTHENTICATION_CLASSES: [SessionAuthentication, TokenAuthentication],
  DEFAULT_THROTTLE_CLASSES: [AnonRateThrottle, UserRateThrottle],   // default: none
  OPTIMIZE: false,
}
```

Add `GraphQLConfig` to `INSTALLED_APPS` for the command:

```sh
ghuri graphql_schema                   # SDL to stdout
ghuri graphql_schema --out schema.graphql --sort
ghuri graphql_schema --json --out schema.json
```

## 8. Performance

- Relations are batched by DataLoaders (see 3); counts stay constant as data grows.
- The optimizer turns the selection into joins and prefetches: `optimize(qs, info)` in a resolver, or
  `new Schema({ …, optimize: true })` / `GRAPHQL.OPTIMIZE` for every root list and connection. Forward foreign
  keys become `selectRelated`, argument-less reverse / M2M lists `prefetchRelated` (only for related types with
  the default `getQueryset`), `{ only: true }` also restricts columns.
- `maxDepth` / `maxComplexity` protect the API from expensive queries; `throttleClasses` from abusive clients.

## 9. Testing

```ts
import { assertResponseHasErrors, assertResponseNoErrors, graphqlQuery, payloadErrors } from '@ghuri/graphql/testing'

const res = await graphqlQuery(client, 'query ($id: ID!) { post(id: $id) { title } }', { variables: { id } })
assertResponseNoErrors(res)
expect(res.data.post.title).toBe('Hi')

await client.forceLogin(user)                       // @ghuri/auth
const m = await graphqlQuery(client, 'mutation { savePost(input: {}) { errors { field messages } } }')
expect(payloadErrors(m.data.savePost)).toHaveProperty('title')
assertResponseHasErrors(await graphqlQuery(anonClient, '{ me { id } }'), { code: 'UNAUTHENTICATED' })
```

Options: `variables`, `operationName`, `headers`, `path` (default `/graphql/`, or `graphqlTestDefaults.path`),
`method: 'GET'`, `csrf: false`. Or skip HTTP with `schema.execute(query, { user })`.

## 10. For graphene-django users

| graphene-django | @ghuri/graphql |
|---|---|
| `class PostType(DjangoObjectType): class Meta: model = Post` | `class PostType extends ModelType { static Meta = { model: Post } }` |
| `fields = (...)` / `exclude = (...)` | `Meta.fields` / `Meta.exclude` (`'__all__'` default) |
| `def resolve_title(self, info)` | `static resolveTitle(post, args, info)` |
| `graphene.String()` as class attribute | `static fields = { title: String }` |
| `graphene.Field(T, id=graphene.ID(required=True))` | `Field(T, { args: { id: NonNull(ID) } })` |
| `graphene.List(T)` / `graphene.NonNull(T)` / `required=True` | `List(T)` / `NonNull(T)` / `{ required: true }` |
| `get_queryset(cls, queryset, info)` | `static getQueryset(qs, info)` (synchronous) |
| `info.context.user` | `info.context.user` (Hono context: `info.context.c`) |
| `class Query(graphene.ObjectType)` per app + multiple inheritance | `class BlogQuery extends Query` + `Schema({ query: [BlogQuery, …] })` |
| `graphene.Schema(query=Query, mutation=Mutation)` | `new Schema({ query, mutation, types })` |
| `relay.Node`, `relay.Node.Field()` | `Node`, `Node.Field()`, `Node.ListField()` |
| `DjangoFilterConnectionField(T)` + `filter_fields` | `ConnectionField(T)` + `Meta.filterFields` → `filter: { … }` input |
| `title_Icontains: "x"` | `filter: { title: { icontains: "x" } }` |
| `order_by` (OrderingFilter) | `orderBy: ["-createdAt"]` + `Meta.orderBy` |
| `RELAY_CONNECTION_MAX_LIMIT` | `GRAPHQL.RELAY_CONNECTION_MAX_LIMIT` |
| `graphene.Mutation` with `class Arguments` + `mutate()` | `Mutation` with `static Arguments` + `static mutate()` |
| `relay.ClientIDMutation` + `mutate_and_get_payload` | `ClientIDMutation` + `static mutateAndGetPayload()` |
| `SerializerMutation` (`serializer_class`, `model_operations`, `lookup_field`) | `SerializerMutation` (`serializerClass`, `modelOperations`, `lookupField`) |
| `ErrorType` (`field`, `messages`) | `ErrorType` (`field`, `messages`) |
| `@login_required`, `@permission_required` (django-graphql-jwt) | `loginRequired`, `permissionRequired`, `staffMemberRequired`, `superuserRequired` |
| `GraphQLView.as_view(graphiql=True)` | `GraphQLView.asView({ graphiql: true })` |
| `GRAPHENE = { 'SCHEMA': … }` | `GRAPHQL: { SCHEMA: … }` |
| `./manage.py graphql_schema` | `ghuri graphql_schema` |
| `GraphQLTestCase.query()` | `graphqlQuery(client, …)` |
| `convert_choices_to_enum` | `Meta.convertChoicesToEnum` |
| `DjangoListField` | `List(ModelType)` (applies `getQueryset`) |

Differences worth knowing: generated mutation payloads are named `<Mutation>Payload`; connection edges are
`[XEdge!]!` with `totalCount` built in; DataLoaders are built in (no `graphene-django-optimizer` needed);
subscriptions are not supported yet.

## License

MIT
