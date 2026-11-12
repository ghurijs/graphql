// The code-first type system: field definitions (`Field`, `List`, `NonNull`, `Argument`) and the base
// classes (`ObjectType`, `InputObjectType`, `Interface`, `Union`, `Enum`, `Query`).
import type { GraphQLList, GraphQLNonNull, GraphQLResolveInfo, GraphQLScalarType, GraphQLType } from 'graphql'
import type { GraphQLContext } from '../context'
import type { PermissionClassLike } from '../permissions'
import type { MaybePromise } from '../utils'

/** graphql-js resolve info plus the Ghuri context (`info.context.user`, `info.context.loaders`, `info.context.c`). */
export interface ResolveInfo extends GraphQLResolveInfo {
  readonly context: GraphQLContext
}

/** Resolver signature used everywhere in Ghuri: `(parent, args, info)` (context is `info.context`). */
export type Resolver<TParent = any, TArgs = any, TResult = unknown> = (
  parent: TParent,
  args: TArgs,
  info: ResolveInfo,
) => TResult | Promise<TResult>

/** `List(x)` / `NonNull(x)` wrappers that can hold class references (resolved when the schema is built). */
export interface TypeWrapper {
  readonly __ghuriWrapper: 'list' | 'nonNull'
  readonly ofType: TypeRef
}

/** Special references built by helpers (`ConnectionField`, `Mutation.field()`, `Node.Field()`). */
export interface SpecialRef {
  readonly __ghuriWrapper: 'connection' | 'mutation' | 'node'
  readonly [key: string]: unknown
}

type AnyClass = abstract new (...args: any[]) => any

/**
 * Anything usable as a GraphQL type:
 * - a graphql-js type (`GraphQLString`, a `GraphQLObjectType`, …) or the exported aliases (`String`, `Int`, …),
 * - a class extending `ObjectType`, `ModelType`, `InputObjectType`, `Interface`, `Union` or `Enum`,
 * - JS constructors: `String`, `Number` (Float), `Boolean`, `Date` (DateTime), `BigInt`, and `JSON`,
 * - `List(x)` / `NonNull(x)` / another `Field(...)` (its type is used),
 * - a type name (`'PostType'`) or a thunk `() => PostType` for forward references.
 */
export type TypeRef =
  | GraphQLType
  | AnyClass
  | FieldDef<any>
  | TypeWrapper
  | SpecialRef
  | StringConstructor
  | NumberConstructor
  | BooleanConstructor
  | DateConstructor
  | BigIntConstructor
  | JSON
  | string
  | (() => unknown)

/** Argument map of a field: `{ id: ID, first: Argument(Int, { defaultValue: 10 }) }`. */
export type ArgsInput = Record<string, TypeRef>

export interface FieldOptions<TParent = any, TArgs = any> {
  /** Arguments (`{ id: NonNull(ID) }`). */
  args?: ArgsInput
  /** Resolver `(parent, args, info)`. Defaults to the parent property (or a `resolveX` static method). */
  resolve?: Resolver<TParent, TArgs>
  description?: string
  deprecationReason?: string
  /** Default value (arguments and input fields). */
  defaultValue?: unknown
  /** Shortcut for `NonNull(type)` (graphene's `required=True`). */
  required?: boolean
  /** Read this attribute path of the parent instead of the field name (`'author.username'`). */
  source?: string
  /** REST permission classes checked (`hasPermission`) before resolving. */
  permissionClasses?: PermissionClassLike[]
  extensions?: Record<string, unknown>
  /** @internal options used by helpers (connections, mutations, node fields). */
  [key: string]: unknown
}

/** A field / argument / input field definition (what `Field()`, `List()`, `NonNull()`, `Argument()` return). */
export class FieldDef<T = any> {
  declare readonly __ts: T
  readonly __ghuriField = true as const
  constructor(
    readonly type: TypeRef,
    readonly options: FieldOptions = {},
  ) {}

  /** A copy with extra options. */
  with(options: FieldOptions): FieldDef<T> {
    return new FieldDef<T>(this.type, { ...this.options, ...options })
  }
}

export function isFieldDef(v: unknown): v is FieldDef {
  return !!v && typeof v === 'object' && (v as any).__ghuriField === true
}

export function isTypeWrapper(v: unknown): v is TypeWrapper | SpecialRef {
  return !!v && typeof v === 'object' && typeof (v as any).__ghuriWrapper === 'string'
}

// ---- TypeScript inference of argument values (best effort) ---------------------------------------

type Nullable<T> = T | null | undefined

/** The TS type of a value of GraphQL type `R` (nullable unless wrapped in `NonNull`). */
export type TsOf<R> =
  R extends FieldDef<infer T>
    ? T
    : R extends StringConstructor
      ? Nullable<string>
      : R extends NumberConstructor
        ? Nullable<number>
        : R extends BooleanConstructor
          ? Nullable<boolean>
          : R extends DateConstructor
            ? Nullable<Date>
            : R extends GraphQLNonNull<infer U>
              ? NonNullable<TsOf<U>>
              : R extends GraphQLList<infer U>
                ? Nullable<Array<TsOf<U>>>
                : R extends GraphQLScalarType<infer I, any>
                  ? Nullable<I>
                  : any

/** Argument values of an `ArgsInput` map. */
export type InferArgs<A> = A extends ArgsInput ? { [K in keyof A]: TsOf<A[K]> } : Record<string, any>

// ---- process-wide list of referenced type classes (error hints only) --------------------------------

const registered: Function[] = []
const registeredSet = new Set<Function>()

/**
 * Remember a type class process-wide. `Field()`, `List()`, `ConnectionField()`… call this for you.
 *
 * Schemas never look types up in this list: a schema only contains the types reachable from its own `query`,
 * `mutation` and `types` (so two schemas in one process cannot leak each other's types through generated
 * relations, `node(id:)` or type names). The list only improves configuration error messages.
 *
 * @deprecated Registering a type no longer adds it to any schema. List types that are only reachable through
 * generated relations in `new Schema({ types: [...] })`.
 */
export function registerType<T extends Function>(cls: T): T {
  return rememberType(cls)
}

/** @internal remember a referenced type class (for error hints; never consulted when building a schema). */
export function rememberType<T extends Function>(cls: T): T {
  if (typeof cls === 'function' && (cls as any).__ghuriType && !registeredSet.has(cls)) {
    registeredSet.add(cls)
    registered.push(cls)
  }
  return cls
}

/** @internal every remembered type class, in registration order (error hints only). */
export function registeredTypes(): readonly Function[] {
  return registered
}

function registerRef(ref: unknown): void {
  if (typeof ref === 'function' && (ref as any).__ghuriType) rememberType(ref)
  else if (isTypeWrapper(ref)) registerRef((ref as any).ofType ?? (ref as any).node)
  else if (isFieldDef(ref)) registerRef(ref.type)
}

// ---- helpers ---------------------------------------------------------------------------------------

/**
 * A field: `Field(PostType, { args: { id: NonNull(ID) }, resolve: (_, { id }) => Post.objects.get({ id }) })`.
 * Also used for input fields and arguments.
 */
export function Field<R extends TypeRef, A extends ArgsInput = {}>(
  type: R,
  options: FieldOptions<any, InferArgs<A>> & { args?: A } = {},
): FieldDef<TsOf<R>> {
  registerRef(type)
  return new FieldDef(type, options)
}

/** `List(PostType)` — a list field (`[PostType!]` by default, items non-null; see `options.nullableItems`). */
export function List<R extends TypeRef, A extends ArgsInput = {}>(
  ofType: R,
  options: FieldOptions<any, InferArgs<A>> & { args?: A; nullableItems?: boolean } = {},
): FieldDef<Nullable<Array<NonNullable<TsOf<R>>>>> {
  registerRef(ofType)
  const item: TypeRef = options.nullableItems ? ofType : { __ghuriWrapper: 'nonNull', ofType }
  return new FieldDef({ __ghuriWrapper: 'list', ofType: item }, options)
}

/** `NonNull(ID)` — a required field / argument. */
export function NonNull<R extends TypeRef, A extends ArgsInput = {}>(
  ofType: R,
  options: FieldOptions<any, InferArgs<A>> & { args?: A } = {},
): FieldDef<NonNullable<TsOf<R>>> {
  registerRef(ofType)
  return new FieldDef({ __ghuriWrapper: 'nonNull', ofType }, options)
}

/** An argument with a default value / description: `Argument(Int, { defaultValue: 10 })`. */
export function Argument<R extends TypeRef>(
  type: R,
  options: Pick<FieldOptions, 'defaultValue' | 'description' | 'deprecationReason' | 'required'> = {},
): FieldDef<TsOf<R>> {
  registerRef(type)
  return new FieldDef(type, options)
}

/** An input field of an `InputObjectType` (alias of `Argument`). */
export const InputField = Argument

/** Fields of a type: `{ name: String, posts: List(PostType) }`, or a thunk returning them. */
export type FieldsInput = Record<string, TypeRef> | (() => Record<string, TypeRef>)

// ---- base classes ----------------------------------------------------------------------------------

export interface TypeMeta {
  /** GraphQL type name (default: the class name). */
  name?: string
  description?: string
}

export interface ObjectTypeMeta extends TypeMeta {
  /** Interfaces implemented (`[Node]`). Their fields are added automatically. */
  interfaces?: TypeRef[] | (() => TypeRef[])
}

/**
 * An object type (graphene's `ObjectType`):
 *
 * ```ts
 * class Person extends ObjectType {
 *   static fields = { firstName: String, lastName: String, fullName: String }
 *   static resolveFullName(person: { firstName: string; lastName: string }) {
 *     return `${person.firstName} ${person.lastName}`
 *   }
 * }
 * ```
 * `static resolveX(parent, args, info)` methods resolve field `x`.
 */
export class ObjectType {
  static readonly __ghuriType: string = 'object'
  static Meta?: ObjectTypeMeta
  static fields?: FieldsInput
  /** Decide whether `value` is of this type (used by interfaces/unions without `resolveType`). */
  static isTypeOf?(value: unknown, info: ResolveInfo): MaybePromise<boolean>
}

/** Root query fields. Every app defines one; `Schema({ query: [BlogQuery, ShopQuery] })` merges them. */
export class Query extends ObjectType {}

export interface InterfaceMeta extends TypeMeta {
  interfaces?: TypeRef[] | (() => TypeRef[])
}

/**
 * An interface: `class Named extends Interface { static fields = { name: NonNull(String) } }`; object types
 * list it in `Meta.interfaces`. Override `resolveType(value, info)` to pick the concrete type.
 */
export class Interface {
  static readonly __ghuriType: string = 'interface'
  static Meta?: InterfaceMeta
  static fields?: FieldsInput
  static resolveType?(value: unknown, info: ResolveInfo): MaybePromise<TypeRef | string | undefined | null>
}

export interface UnionMeta extends TypeMeta {
  types: TypeRef[] | (() => TypeRef[])
}

/** A union: `class SearchResult extends Union { static Meta = { types: [PostType, MemberType] } }`. */
export class Union {
  static readonly __ghuriType: string = 'union'
  static Meta?: UnionMeta
  static resolveType?(value: unknown, info: ResolveInfo): MaybePromise<TypeRef | string | undefined | null>
}

/** An input object: `class PostInput extends InputObjectType { static fields = { title: NonNull(String) } }`. */
export class InputObjectType {
  static readonly __ghuriType: string = 'input'
  static Meta?: TypeMeta
  static fields?: FieldsInput
}

export interface EnumValueConfig {
  value: unknown
  description?: string
  deprecationReason?: string
}

/**
 * An enum: `class Episode extends Enum { static values = { NEWHOPE: 4, EMPIRE: 5, JEDI: 6 } }`.
 * Resolvers return (and arguments receive) the values; the names are what clients see.
 */
export class Enum {
  static readonly __ghuriType: string = 'enum'
  static Meta?: TypeMeta
  static values: Record<string, unknown> = {}

  /**
   * Build an enum class from a TS enum, an object or `[name, value]` pairs:
   * `const Color = Enum.from('Color', { RED: 'r', GREEN: 'g' })`.
   */
  static from(
    name: string,
    values: Record<string, unknown> | ReadonlyArray<readonly [string, unknown]>,
    meta: Omit<TypeMeta, 'name'> = {},
  ): typeof Enum {
    const map: Record<string, unknown> = {}
    if (Array.isArray(values)) {
      for (const [k, v] of values as ReadonlyArray<readonly [string, unknown]>) map[k] = v
    } else {
      for (const [k, v] of Object.entries(values)) {
        if (/^\d+$/.test(k)) continue // numeric TS enums have reverse mappings
        map[k] = v
      }
    }
    const cls = class extends Enum {
      static override Meta = { ...meta, name }
      static override values = map
    }
    Object.defineProperty(cls, 'name', { value: name })
    return cls
  }
}

/** Every type a schema can be built from (used for runtime checks). */
export const TYPE_KINDS = ['object', 'interface', 'union', 'input', 'enum'] as const

/** Type name of a class (own `Meta.name` or the class name). */
export function typeNameOf(cls: Function): string {
  const own = Object.hasOwn(cls, 'Meta') ? ((cls as any).Meta as TypeMeta | undefined) : undefined
  return own?.name ?? cls.name
}
