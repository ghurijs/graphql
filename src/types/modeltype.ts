// `ModelType`: GraphQL object types generated from ORM models (graphene-django's `DjangoObjectType`).
import type { ModelClass, QuerySet } from '@ghuri/orm'
import { GraphQLConfigurationError } from '../errors'
import type { PermissionClassLike } from '../permissions'
import { isQuerySet } from '../utils'
import { ObjectType, type ObjectTypeMeta, type ResolveInfo, type TypeRef } from './definitions'

/** `filterFields`: `['title', 'published']` (exact) or `{ title: ['icontains', 'exact'], createdAt: ['gte', 'lte'] }`. */
export type FilterFieldsSpec = readonly string[] | Readonly<Record<string, readonly string[]>>

export interface ModelTypeMeta<M extends ModelClass = any> extends ObjectTypeMeta {
  /** The ORM model. */
  model: M
  /** Model fields to expose (default / `'__all__'`: every field and reverse relation). */
  fields?: readonly string[] | '__all__'
  /** Model fields to hide. */
  exclude?: readonly string[]
  /** Filters of connection fields returning this type (`filter: { title: { icontains: "x" } }`). */
  filterFields?: FilterFieldsSpec
  /** Fields allowed in `orderBy` of connection fields returning this type (`'__all__'`: concrete fields). */
  orderBy?: readonly string[] | '__all__'
  /** Custom connection class (`class PostConnection extends Connection { static fields = {...} }`). */
  connectionClass?: TypeRef
  /**
   * REST permission classes enforced whenever an object of this type is resolved: `hasPermission` once per
   * request (method `GET`), `hasObjectPermission` per object. Lists silently drop objects failing the
   * object check; single fields raise `PERMISSION_DENIED`.
   */
  permissionClasses?: PermissionClassLike[]
  /** Turn fields with `choices` into GraphQL enums (default true; or a list of field names). */
  convertChoicesToEnum?: boolean | readonly string[]
}

/**
 * An object type generated from a model:
 *
 * ```ts
 * class PostType extends ModelType {
 *   static Meta = { model: Post, fields: ['id', 'title', 'author', 'tags'], interfaces: [Node],
 *                   filterFields: { title: ['icontains'] } }
 *   static fields = { excerpt: Field(String, { resolve: (post: Post) => post.body.slice(0, 100) }) }
 *   static getQueryset(qs: QuerySet<Post>, info: ResolveInfo) {
 *     return info.context.user.isStaff ? qs : qs.filter({ published: true })
 *   }
 * }
 * ```
 * Scalars map from the field type, `choices` become enums, foreign keys object fields, reverse relations and
 * many-to-many lists (or connections when the related type implements `Node`). Relations are loaded through
 * per-request DataLoaders, so nested queries run a constant number of SQL queries.
 */
export class ModelType extends ObjectType {
  static readonly __ghuriModelType = true
  static override Meta?: ModelTypeMeta

  /**
   * Row-level scoping: every QuerySet producing objects of this type goes through it (root lists, connections,
   * `node`, relation loaders, mutation lookups). Must return the QuerySet synchronously — a QuerySet is
   * thenable, so returning it from an `async` function would run the query.
   */
  static getQueryset(queryset: QuerySet<any>, _info: ResolveInfo): QuerySet<any> {
    return queryset
  }

  /** Fetch one object by primary key for `node(id:)` (default: through `getQueryset`, batched). */
  static async getNode(id: unknown, info: ResolveInfo): Promise<unknown> {
    const { loadNode } = await import('../loaders')
    return loadNode(this, id, info)
  }
}

export type ModelTypeClass = typeof ModelType

export function isModelTypeClass(v: unknown): v is ModelTypeClass {
  return typeof v === 'function' && (v as any).__ghuriModelType === true && !!(v as any).Meta?.model
}

/** The model of a ModelType class. */
export function modelOf(cls: ModelTypeClass): ModelClass {
  const model = cls.Meta?.model
  if (!model) throw new TypeError(`${cls.name}.Meta.model is not set.`)
  return model
}

/** True when the type does not customize `getQueryset` and has no permission classes. */
export function hasDefaultQueryset(cls: ModelTypeClass): boolean {
  return cls.getQueryset === ModelType.getQueryset && !cls.Meta?.permissionClasses?.length
}

/** `cls.getQueryset(base ?? model.objects.all(), info)`. */
export function typeQueryset(cls: ModelTypeClass, info: ResolveInfo, base?: QuerySet<any>): QuerySet<any> {
  const qs = base ?? (modelOf(cls)._defaultManager.getQueryset() as QuerySet<any>)
  const out = cls.getQueryset(qs, info) as unknown
  if (out === undefined || out === null) return qs
  if (!isQuerySet(out)) {
    throw new GraphQLConfigurationError(
      `${cls.name}.getQueryset() must return a QuerySet synchronously (a QuerySet is thenable: returning it from an async function runs the query).`,
    )
  }
  return out
}
