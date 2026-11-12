// Converts the code-first classes (`ObjectType`, `ModelType`, `Mutation`, …) into graphql-js types.
import type { ModelClass, QuerySet } from '@ghuri/orm'
import {
  type GraphQLArgumentConfig,
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLEnumValueConfigMap,
  GraphQLError,
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLFieldResolver,
  GraphQLFloat,
  GraphQLID,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
  type GraphQLType,
  type GraphQLTypeResolver,
  GraphQLUnionType,
  getNamedType,
  getNullableType,
  isInputType,
  isOutputType,
  isType,
} from 'graphql'
import type { GraphQLContext } from './context'
import { GraphQLConfigurationError } from './errors'
import {
  loadNode,
  resolveForeignKey,
  resolveManyToMany,
  resolveReverseMany,
  resolveReverseOne,
} from './loaders'
import {
  type OptimizeOptions,
  optimize,
  type RelationMeta,
  type TypeExtension,
  typeExtension,
} from './optimizer'
import {
  checkObjectPermissions,
  checkPermissions,
  hasObjectPermissions,
  type PermissionView,
} from './permissions'
import { type ConnectionResult, paginate, paginateArray } from './relay/connection'
import { applyFilter, applyOrderBy, buildFilterSet, ensureOrdered, type FilterSet } from './relay/filters'
import { fromGlobalId, Node, toGlobalId } from './relay/node'
import { Base64, BigIntScalar, DateScalar, DateTime, Decimal, JSONScalar, Time, UUID } from './scalars'
import { graphqlSettings } from './settings'
import {
  type ArgsInput,
  type FieldDef,
  FieldDef as FieldDefClass,
  type FieldsInput,
  isFieldDef,
  isTypeWrapper,
  Query,
  type ResolveInfo,
  type Resolver,
  registeredTypes,
  type SpecialRef,
  type TypeRef,
  typeNameOf,
} from './types/definitions'
import {
  hasDefaultQueryset,
  isModelTypeClass,
  ModelType,
  type ModelTypeClass,
  modelOf,
  typeQueryset,
} from './types/modeltype'
import {
  capitalize,
  isManager,
  isModelInstance,
  isPlainObject,
  isPromiseLike,
  isQuerySet,
  isSubclassOf,
} from './utils'

// ---- ORM field → GraphQL scalar --------------------------------------------------------------------------

/** Converts an ORM field (by `internalType`) to a GraphQL type. Return null to fall through. */
export type FieldConverter = (field: any) => GraphQLOutputType | null | undefined

const SCALAR_BY_INTERNAL_TYPE: Record<string, () => GraphQLOutputType & GraphQLInputType> = {
  AutoField: () => GraphQLInt,
  SmallAutoField: () => GraphQLInt,
  BigAutoField: () => BigIntScalar,
  CharField: () => GraphQLString,
  TextField: () => GraphQLString,
  SlugField: () => GraphQLString,
  EmailField: () => GraphQLString,
  URLField: () => GraphQLString,
  GenericIPAddressField: () => GraphQLString,
  FilePathField: () => GraphQLString,
  UUIDField: () => UUID,
  IntegerField: () => GraphQLInt,
  SmallIntegerField: () => GraphQLInt,
  PositiveIntegerField: () => GraphQLInt,
  PositiveSmallIntegerField: () => GraphQLInt,
  BigIntegerField: () => BigIntScalar,
  PositiveBigIntegerField: () => BigIntScalar,
  FloatField: () => GraphQLFloat,
  DecimalField: () => Decimal,
  BooleanField: () => GraphQLBoolean,
  NullBooleanField: () => GraphQLBoolean,
  DateField: () => DateScalar,
  DateTimeField: () => DateTime,
  TimeField: () => Time,
  DurationField: () => GraphQLFloat,
  JSONField: () => JSONScalar,
  BinaryField: () => Base64,
  FileField: () => GraphQLString,
  ImageField: () => GraphQLString,
}

const customConverters = new Map<string, FieldConverter>()

/**
 * Map a custom ORM field type to GraphQL: `registerFieldConverter('MoneyField', () => Decimal)`.
 * Converters are looked up by `internalType`, walking up the field's class chain.
 */
export function registerFieldConverter(internalType: string, converter: FieldConverter): void {
  customConverters.set(internalType, converter)
}

/** Internal types of an ORM field, most specific first (`['ImageField', 'FileField', 'CharField']`). */
export function internalTypesOf(field: any): string[] {
  const out: string[] = []
  for (
    let c = field?.constructor;
    c && c !== Object && c !== Function.prototype;
    c = Object.getPrototypeOf(c)
  ) {
    if (Object.hasOwn(c, 'internalType') && typeof c.internalType === 'string') out.push(c.internalType)
  }
  if (!out.length && field?.internalType) out.push(field.internalType)
  return out
}

function isFileField(field: any): boolean {
  return internalTypesOf(field).some((t) => t === 'FileField' || t === 'ImageField')
}

/** The GraphQL scalar of a non-relation ORM field (custom converters first). */
export function scalarForModelField(field: any): GraphQLOutputType {
  if (field.primaryKey) return GraphQLID
  for (const t of internalTypesOf(field)) {
    const custom = customConverters.get(t)?.(field)
    if (custom) return custom
    const builtin = SCALAR_BY_INTERNAL_TYPE[t]
    if (builtin) return builtin()
  }
  // unknown field type: derive from its JSON Schema
  try {
    const schema = field.jsonSchema?.() ?? {}
    const t = Array.isArray(schema.type) ? schema.type.find((x: string) => x !== 'null') : schema.type
    if (t === 'integer') return GraphQLInt
    if (t === 'number') return GraphQLFloat
    if (t === 'boolean') return GraphQLBoolean
    if (t === 'string') return GraphQLString
  } catch {}
  return JSONScalar
}

/** GraphQL enum value name for a choice value (`'in-review'` → `IN_REVIEW`, `1` → `A_1`). */
export function enumValueName(value: unknown): string {
  let name = String(value)
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (!name) name = 'EMPTY'
  if (/^\d/.test(name)) name = `A_${name}`
  if (name === 'TRUE' || name === 'FALSE' || name === 'NULL') name = `${name}_`
  return name
}

// ---- reference normalization -------------------------------------------------------------------------------

type Norm =
  | { k: 'gql'; type: GraphQLType }
  | { k: 'class'; cls: Function }
  | { k: 'list'; of: TypeRef }
  | { k: 'nonNull'; of: TypeRef }
  | { k: 'special'; ref: SpecialRef }
  | { k: 'name'; name: string }

function normalize(ref: unknown, depth = 0): Norm {
  if (depth > 20) throw new GraphQLConfigurationError('Type reference thunks nest too deeply.')
  if (isFieldDef(ref)) {
    if (ref.options.required) return { k: 'nonNull', of: ref.type }
    return normalize(ref.type, depth + 1)
  }
  if (isType(ref)) return { k: 'gql', type: ref }
  if (ref === globalThis.String) return { k: 'gql', type: GraphQLString }
  if (ref === globalThis.Number) return { k: 'gql', type: GraphQLFloat }
  if (ref === globalThis.Boolean) return { k: 'gql', type: GraphQLBoolean }
  if (ref === globalThis.Date) return { k: 'gql', type: DateTime }
  if (ref === globalThis.BigInt) return { k: 'gql', type: BigIntScalar }
  if (ref === globalThis.JSON) return { k: 'gql', type: JSONScalar }
  if (isTypeWrapper(ref)) {
    const w = (ref as any).__ghuriWrapper
    if (w === 'list') return { k: 'list', of: (ref as any).ofType }
    if (w === 'nonNull') return { k: 'nonNull', of: (ref as any).ofType }
    return { k: 'special', ref: ref as SpecialRef }
  }
  if (typeof ref === 'string') return { k: 'name', name: ref }
  if (typeof ref === 'function') {
    if ((ref as any).__ghuriType) return { k: 'class', cls: ref }
    return normalize((ref as () => unknown)(), depth + 1)
  }
  throw new GraphQLConfigurationError(`Unknown GraphQL type reference: ${String(ref)}`)
}

/** Wrap in NonNull unless already non-null. */
export function nonNull(t: GraphQLType): any {
  return t instanceof GraphQLNonNull ? t : new GraphQLNonNull(t as any)
}

const fieldsCache = new WeakMap<Function, Record<string, TypeRef>>()

/** Fields declared with `static fields` along the class chain (base classes first). */
export function declaredFields(cls: Function): Record<string, TypeRef> {
  let cached = fieldsCache.get(cls)
  if (cached) return cached
  const chain: Function[] = []
  for (let c: any = cls; c && c !== Function.prototype; c = Object.getPrototypeOf(c)) chain.unshift(c)
  cached = {}
  for (const c of chain) {
    if (!Object.hasOwn(c, 'fields')) continue
    const f = (c as any).fields as FieldsInput | undefined
    if (!f) continue
    Object.assign(cached, typeof f === 'function' ? f() : f)
  }
  fieldsCache.set(cls, cached)
  return cached
}

function listOf(v: unknown): TypeRef[] {
  if (!v) return []
  const r = typeof v === 'function' ? (v as () => unknown)() : v
  return Array.isArray(r) ? r : []
}

/** Attach `context` to graphql-js resolve info. */
export function withContext(info: any, context: unknown): ResolveInfo {
  if (info && info.context === context) return info
  return Object.create(info, { context: { value: context, enumerable: true } })
}

function attrPath(obj: any, path: string): unknown {
  let cur = obj
  for (const part of path.split('.')) {
    if (cur === null || cur === undefined) return cur
    cur = cur[part]
  }
  return cur
}

const NODE_TYPES = Symbol.for('ghuri.graphql.nodeTypes')
const TYPE_PERMS = Symbol.for('ghuri.graphql.typePerms')
const OBJ_PERMS = Symbol.for('ghuri.graphql.objPerms')

function stateMap<K, V>(ctx: GraphQLContext, key: symbol, make: () => Map<K, V> | WeakMap<any, V>): any {
  let m = ctx.state.get(key)
  if (!m) {
    m = make()
    ctx.state.set(key, m)
  }
  return m
}

export interface BuilderOptions {
  optimize?: boolean | OptimizeOptions
}

/**
 * Builds graphql-js types from Ghuri classes. One builder per `Schema`; types are memoized per class so the
 * same class always yields the same GraphQL type within a schema.
 */
export class TypeBuilder {
  readonly named = new Map<string, GraphQLNamedType>()
  readonly classByName = new Map<string, Function>()
  private readonly byClass = new Map<Function, GraphQLNamedType>()
  private readonly modelTypes = new Map<ModelClass, ModelTypeClass>()
  private readonly discovered = new Set<Function>()
  private readonly choiceEnums = new Map<any, GraphQLEnumType>()
  private readonly connections = new Map<string, GraphQLObjectType>()
  private readonly filterSets = new Map<string, FilterSet | null>()
  private pageInfoType?: GraphQLObjectType
  private errorTypeCache?: GraphQLObjectType
  readonly optimizeOptions: OptimizeOptions | null

  constructor(readonly options: BuilderOptions = {}) {
    const o = options.optimize
    this.optimizeOptions = o ? (o === true ? {} : o) : null
  }

  // ---- discovery ------------------------------------------------------------------------------------------

  /** Pre-pass: find every class reachable from `ref` so model → type lookups are complete. */
  discover(ref: unknown): void {
    let n: Norm
    try {
      n = normalize(ref)
    } catch {
      return
    }
    if (isFieldDef(ref)) for (const a of Object.values(ref.options.args ?? {})) this.discover(a)
    if (n.k === 'list' || n.k === 'nonNull') {
      this.discover(n.of)
      return
    }
    if (n.k === 'special') {
      const r = n.ref as any
      if (r.__ghuriWrapper === 'connection') {
        this.discover(r.node)
        if (r.connectionClass) this.discoverClass(r.connectionClass)
      } else if (r.__ghuriWrapper === 'mutation') {
        for (const x of r.mutation.discoverRefs?.() ?? []) this.discover(x)
      } else if (r.__ghuriWrapper === 'node') {
        this.discover(Node)
        if (r.only) this.discover(r.only)
      }
      return
    }
    if (n.k === 'class') this.discoverClass(n.cls)
  }

  private discoverClass(cls: Function): void {
    if (this.discovered.has(cls)) return
    this.discovered.add(cls)
    if (isModelTypeClass(cls)) {
      const model = modelOf(cls)
      if (!this.modelTypes.has(model)) this.modelTypes.set(model, cls)
      const meta = cls.Meta as any
      if (meta?.connectionClass) this.discover(meta.connectionClass)
    }
    const meta = (cls as any).Meta ?? {}
    for (const i of listOf(meta.interfaces)) this.discover(i)
    if ((cls as any).__ghuriType === 'union') for (const t of listOf(meta.types)) this.discover(t)
    if ((cls as any).__ghuriType !== 'enum') {
      for (const f of Object.values(declaredFields(cls))) this.discover(f)
    }
  }

  /**
   * The ModelType of THIS schema used for `model` in generated relations (FK, one-to-one, reverse FK, M2M),
   * `ModelMutation` payloads / lookups and global-ID decoding. Resolution order:
   *
   * 1. the first ModelType of exactly `model` discovered by this schema, i.e. reachable from its `query`,
   *    `mutation` or `types` (through declared fields, arguments, interfaces, union members, connection
   *    classes and mutation inputs / outputs);
   * 2. else the first discovered ModelType of a parent class of `model` (proxy-like subclasses);
   * 3. else none: the relation is skipped (a configuration error when it is listed in `Meta.fields`).
   *
   * Never a type of another schema: there is no process-wide fallback, so with several schemas (e.g. an
   * admin API and a public API) a relation can never expose another schema's fields.
   */
  typeForModel(model: ModelClass): ModelTypeClass | undefined {
    const found = this.modelTypes.get(model)
    if (found) return found
    // subclass models (proxy-like) → nearest parent with a type
    for (const [m, cls] of this.modelTypes) if (isSubclassOf(model, m as any)) return cls
    return undefined
  }

  /** Every discovered type class (added to the schema's `types` so `node` can return them). */
  discoveredClasses(): Function[] {
    return [...this.discovered]
  }

  // ---- naming -------------------------------------------------------------------------------------------

  addNamed<T extends GraphQLNamedType>(type: T, cls?: Function): T {
    const existing = this.named.get(type.name)
    if (existing && existing !== type) {
      const prev = this.classByName.get(type.name)
      throw new GraphQLConfigurationError(
        `Two different GraphQL types are named "${type.name}"${prev && cls ? ` (${prev.name} and ${cls.name})` : ''}. Set Meta.name on one of them.`,
      )
    }
    this.named.set(type.name, type)
    if (cls) this.classByName.set(type.name, cls)
    return type
  }

  /** Names of Node types for a model (their global IDs are accepted in filters / mutation inputs). */
  nodeTypeNamesFor(model: ModelClass): Set<string> {
    const out = new Set<string>()
    for (const [name, cls] of this.classByName) {
      if (isModelTypeClass(cls) && modelOf(cls) === model && this.implementsNode(cls)) out.add(name)
    }
    const t = this.typeForModel(model)
    if (t && this.implementsNode(t)) out.add(typeNameOf(t))
    return out
  }

  implementsNode(cls: Function): boolean {
    return listOf((cls as any).Meta?.interfaces).some((i) => {
      try {
        const n = normalize(i)
        return n.k === 'class' && isSubclassOf(n.cls, Node)
      } catch {
        return false
      }
    })
  }

  /** Decode a global ID of one of `model`'s Node types (anything else is returned unchanged). */
  decodeId(model: ModelClass | undefined, value: unknown): unknown {
    if (typeof value !== 'string' || !model) return value
    const g = fromGlobalId(value)
    if (g && this.nodeTypeNamesFor(model).has(g.type)) return g.id
    return value
  }

  // ---- output / input types ---------------------------------------------------------------------------

  output(ref: TypeRef): GraphQLOutputType {
    const n = normalize(ref)
    switch (n.k) {
      case 'gql':
        if (!isOutputType(n.type))
          throw new GraphQLConfigurationError(`${String(n.type)} is not an output type.`)
        return n.type
      case 'list':
        return new GraphQLList(this.output(n.of))
      case 'nonNull':
        return nonNull(this.output(n.of))
      case 'name': {
        const t = this.named.get(n.name) ?? this.typeByClassName(n.name)
        if (!t || !isOutputType(t)) throw new GraphQLConfigurationError(`Unknown output type "${n.name}".`)
        return t
      }
      case 'special': {
        const r = n.ref as any
        if (r.__ghuriWrapper === 'connection') return this.connectionType(r.node, r.connectionClass)
        if (r.__ghuriWrapper === 'mutation') return r.mutation.buildOutputType(this)
        if (r.__ghuriWrapper === 'node') {
          const t = r.only ? this.output(r.only) : this.output(Node)
          return r.many ? new GraphQLNonNull(new GraphQLList(t)) : t
        }
        throw new GraphQLConfigurationError(`Unknown special type ${r.__ghuriWrapper}.`)
      }
      case 'class':
        return this.classType(n.cls) as GraphQLOutputType
    }
  }

  input(ref: TypeRef): GraphQLInputType {
    const n = normalize(ref)
    switch (n.k) {
      case 'gql':
        if (!isInputType(n.type))
          throw new GraphQLConfigurationError(`${String(n.type)} is not an input type.`)
        return n.type
      case 'list':
        return new GraphQLList(this.input(n.of))
      case 'nonNull':
        return nonNull(this.input(n.of))
      case 'name': {
        const t = this.named.get(n.name) ?? this.typeByClassName(n.name)
        if (!t || !isInputType(t)) throw new GraphQLConfigurationError(`Unknown input type "${n.name}".`)
        return t
      }
      case 'class': {
        const t = this.classType(n.cls)
        if (!isInputType(t)) {
          throw new GraphQLConfigurationError(
            `${n.cls.name} is an output type and cannot be used as an argument / input.`,
          )
        }
        return t
      }
      case 'special':
        throw new GraphQLConfigurationError('Connections and mutations cannot be used as input types.')
    }
  }

  /** A type referenced by name: only classes of this schema (never the process-wide `registerType` list). */
  private typeByClassName(name: string): GraphQLNamedType | undefined {
    for (const cls of [...this.discovered]) {
      if (typeNameOf(cls) === name) return this.classType(cls)
    }
    return undefined
  }

  /** The GraphQL type of a class (memoized). */
  classType(cls: Function): GraphQLNamedType {
    const cached = this.byClass.get(cls)
    if (cached) return cached
    this.discover(cls)
    const kind = (cls as any).__ghuriType
    let t: GraphQLNamedType
    if (kind === 'object') t = isModelTypeClass(cls) ? this.modelObjectType(cls) : this.objectType(cls)
    else if (kind === 'interface') t = this.interfaceType(cls)
    else if (kind === 'union') t = this.unionType(cls)
    else if (kind === 'input') t = this.inputObjectType(cls)
    else if (kind === 'enum') t = this.enumType(cls)
    else throw new GraphQLConfigurationError(`${cls.name} cannot be used as a GraphQL type.`)
    return t
  }

  private remember<T extends GraphQLNamedType>(cls: Function, t: T): T {
    this.byClass.set(cls, t)
    return this.addNamed(t, cls)
  }

  private interfacesOf(cls: Function): () => GraphQLInterfaceType[] {
    return () =>
      listOf((cls as any).Meta?.interfaces).map((i) => {
        const t = this.output(i)
        if (!(t instanceof GraphQLInterfaceType))
          throw new GraphQLConfigurationError(`${String(t)} is not an interface.`)
        return t
      })
  }

  private interfaceFieldRefs(cls: Function): Record<string, TypeRef> {
    const out: Record<string, TypeRef> = {}
    const visit = (ifaces: TypeRef[]) => {
      for (const i of ifaces) {
        const n = normalize(i)
        if (n.k !== 'class') continue
        visit(listOf((n.cls as any).Meta?.interfaces))
        Object.assign(out, declaredFields(n.cls))
      }
    }
    visit(listOf((cls as any).Meta?.interfaces))
    return out
  }

  objectType(cls: Function): GraphQLObjectType {
    const meta = (cls as any).Meta ?? {}
    const isTypeOf = (cls as any).isTypeOf
    const ext: TypeExtension = { cls }
    const t = new GraphQLObjectType({
      name: typeNameOf(cls),
      description: meta.description,
      interfaces: this.interfacesOf(cls),
      fields: () => {
        const out: GraphQLFieldConfigMap<any, any> = {}
        const isNode = this.implementsNode(cls)
        for (const [name, ref] of Object.entries({
          ...this.interfaceFieldRefs(cls),
          ...declaredFields(cls),
        })) {
          if (isNode && name === 'id' && !Object.hasOwn(declaredFields(cls), 'id')) {
            out.id = this.globalIdField(typeNameOf(cls), cls)
            continue
          }
          out[name] = this.fieldConfig(name, ref, cls)
        }
        return out
      },
      isTypeOf: isTypeOf ? (v, ctx, info) => isTypeOf.call(cls, v, withContext(info, ctx)) : undefined,
      extensions: { ghuri: ext },
    })
    return this.remember(cls, t)
  }

  interfaceType(cls: Function): GraphQLInterfaceType {
    const meta = (cls as any).Meta ?? {}
    const t = new GraphQLInterfaceType({
      name: typeNameOf(cls),
      description: meta.description,
      interfaces: this.interfacesOf(cls),
      fields: () => {
        const out: GraphQLFieldConfigMap<any, any> = {}
        for (const [name, ref] of Object.entries({
          ...this.interfaceFieldRefs(cls),
          ...declaredFields(cls),
        })) {
          out[name] = this.fieldConfig(name, ref, cls)
        }
        return out
      },
      resolveType: this.typeResolver(cls),
      extensions: { ghuri: { cls } },
    })
    return this.remember(cls, t)
  }

  unionType(cls: Function): GraphQLUnionType {
    const meta = (cls as any).Meta ?? {}
    const t = new GraphQLUnionType({
      name: typeNameOf(cls),
      description: meta.description,
      types: () =>
        listOf(meta.types).map((r) => {
          const ot = this.output(r)
          if (!(ot instanceof GraphQLObjectType))
            throw new GraphQLConfigurationError(`Union members must be object types.`)
          return ot
        }),
      resolveType: this.typeResolver(cls),
      extensions: { ghuri: { cls } },
    })
    return this.remember(cls, t)
  }

  inputObjectType(cls: Function): GraphQLInputObjectType {
    const meta = (cls as any).Meta ?? {}
    const t = new GraphQLInputObjectType({
      name: typeNameOf(cls),
      description: meta.description,
      fields: () => this.inputFieldsConfig(declaredFields(cls)),
      extensions: { ghuri: { cls } },
    })
    return this.remember(cls, t)
  }

  inputFieldsConfig(fields: Record<string, TypeRef>): GraphQLInputFieldConfigMap {
    const out: GraphQLInputFieldConfigMap = {}
    for (const [name, ref] of Object.entries(fields)) {
      const def = isFieldDef(ref) ? ref : undefined
      out[name] = {
        type: this.input(ref),
        description: def?.options.description,
        deprecationReason: def?.options.deprecationReason,
        ...(def && def.options.defaultValue !== undefined
          ? { default: { value: def.options.defaultValue } }
          : {}),
      }
    }
    return out
  }

  enumType(cls: Function): GraphQLEnumType {
    const meta = (cls as any).Meta ?? {}
    const values: GraphQLEnumValueConfigMap = {}
    for (const [name, v] of Object.entries(((cls as any).values ?? {}) as Record<string, unknown>)) {
      if (isPlainObject(v) && 'value' in v) {
        values[name] = { value: v.value, description: v.description, deprecationReason: v.deprecationReason }
      } else values[name] = { value: v }
    }
    const t = new GraphQLEnumType({
      name: typeNameOf(cls),
      description: meta.description,
      values,
      extensions: { ghuri: { cls } },
    })
    return this.remember(cls, t)
  }

  /** Default abstract type resolution: `resolveType`, node tags, model class, `instanceof`, `isTypeOf`, `__typename`. */
  private typeResolver(abstractCls: Function): GraphQLTypeResolver<any, any> {
    return async (value, ctx, info, abstractType) => {
      const custom = (abstractCls as any).resolveType
      if (custom) {
        const r = await custom.call(abstractCls, value, withContext(info, ctx))
        if (r !== undefined && r !== null) {
          if (typeof r === 'string') return r
          return (this.output(r) as GraphQLNamedType).name
        }
      }
      const tagged = (
        (ctx as GraphQLContext)?.state?.get(NODE_TYPES) as WeakMap<object, string> | undefined
      )?.get(value)
      if (tagged) return tagged
      const possible = info.schema.getPossibleTypes(abstractType)
      if (isModelInstance(value)) {
        for (let m = value.constructor; m && m !== Function.prototype; m = Object.getPrototypeOf(m)) {
          const hit = possible.find((p) => typeExtension(p)?.model === m)
          if (hit) return hit.name
        }
      }
      for (const p of possible) {
        const pc = typeExtension(p)?.cls as any
        if (pc && !isModelTypeClass(pc) && value instanceof pc) return p.name
      }
      for (const p of possible) {
        const pc = typeExtension(p)?.cls as any
        if (pc?.isTypeOf && (await pc.isTypeOf(value, withContext(info, ctx)))) return p.name
      }
      if (value && typeof value === 'object' && typeof (value as any).__typename === 'string')
        return (value as any).__typename
      return undefined
    }
  }

  // ---- fields ---------------------------------------------------------------------------------------------

  argsConfig(args: ArgsInput | undefined): GraphQLFieldConfigArgumentMap {
    const out: GraphQLFieldConfigArgumentMap = {}
    for (const [name, ref] of Object.entries(args ?? {})) {
      const def = isFieldDef(ref) ? ref : undefined
      const cfg: GraphQLArgumentConfig = {
        type: this.input(ref),
        description: def?.options.description,
        deprecationReason: def?.options.deprecationReason,
      }
      if (def && def.options.defaultValue !== undefined) cfg.default = { value: def.options.defaultValue }
      out[name] = cfg
    }
    return out
  }

  /** Field config for `name: ref` declared on `owner` (an ObjectType / ModelType / Query / Interface class). */
  fieldConfig(
    name: string,
    ref: TypeRef,
    owner: Function | undefined,
    fallbackResolve?: GraphQLFieldResolver<any, any>,
  ): GraphQLFieldConfig<any, any> {
    const def: FieldDef = isFieldDef(ref) ? ref : new FieldDefClass(ref)
    const n = normalize(def.type)
    if (n.k === 'special') {
      const r = n.ref as any
      if (r.__ghuriWrapper === 'connection') return this.connectionFieldConfig(name, def, r, owner)
      if (r.__ghuriWrapper === 'mutation') return r.mutation.buildField(this, name, def)
      if (r.__ghuriWrapper === 'node') return this.nodeFieldConfig(def, r)
    }
    let type = this.output(def.type)
    if (def.options.required) type = nonNull(type)
    const ownerResolver = owner ? (owner as any)[`resolve${capitalize(name)}`] : undefined
    let resolve: GraphQLFieldResolver<any, any> | undefined
    if (def.options.resolve) {
      const fn = def.options.resolve
      resolve = (parent, args, ctx, info) => fn(parent, args, withContext(info, ctx))
    } else if (typeof ownerResolver === 'function') {
      resolve = (parent, args, ctx, info) => ownerResolver.call(owner, parent, args, withContext(info, ctx))
    } else if (fallbackResolve) {
      resolve = fallbackResolve
    } else if (typeof def.options.source === 'string') {
      const src = def.options.source
      resolve = (parent) => attrPath(parent, src)
    }
    // Lists of ModelTypes: apply getQueryset / optimizer / object permissions to returned QuerySets.
    const named = getNamedType(type)
    const itemCls = typeExtension(named)?.cls
    const isList = getNullableType(type) instanceof GraphQLList
    if (itemCls && isModelTypeClass(itemCls) && isList) {
      const base = resolve
      const isRoot = owner !== undefined && isSubclassOf(owner, Query)
      resolve = async (parent, args, ctx, info) => {
        const i = withContext(info, ctx)
        let value = base ? base(parent, args, ctx, info) : parent?.[name]
        if (!isQuerySet(value) && isPromiseLike(value)) value = await value
        if (value === undefined && !base && isRoot) value = modelOf(itemCls)._defaultManager.getQueryset()
        return this.finishList(itemCls, value, i)
      }
    }
    const perms = def.options.permissionClasses
    if (perms?.length) {
      const inner = resolve
      resolve = async (parent, args, ctx, info) => {
        const i = withContext(info, ctx)
        await checkPermissions(
          perms,
          i.context.request.withMethod(this.methodOf(i), args),
          this.viewFor(i, args),
        )
        return inner ? inner(parent, args, ctx, info) : defaultProp(parent, args, ctx, info)
      }
    }
    return {
      type,
      args: this.argsConfig(def.options.args),
      resolve,
      description: def.options.description,
      deprecationReason: def.options.deprecationReason,
      extensions: def.options.extensions,
    }
  }

  methodOf(info: ResolveInfo): string {
    return info.operation.operation === 'mutation' ? 'POST' : 'GET'
  }

  viewFor(
    info: ResolveInfo,
    kwargs: Record<string, unknown>,
    extra: Partial<PermissionView> = {},
  ): PermissionView {
    return { action: info.operation.operation === 'mutation' ? 'mutation' : 'query', info, kwargs, ...extra }
  }

  /** Resolve a list result of a ModelType: QuerySet → getQueryset (+ optimizer) → array, minus hidden objects. */
  async finishList(cls: ModelTypeClass, value: unknown, info: ResolveInfo): Promise<unknown[] | null> {
    if (value === null || value === undefined) return null
    if (isManager(value)) value = (value as any).all()
    let items: unknown[]
    if (isQuerySet(value)) {
      await this.checkTypePermission(cls, info)
      let qs = typeQueryset(cls, info, value)
      if (this.optimizeOptions || graphqlSettings(info.context.c).OPTIMIZE)
        qs = optimize(qs, info, this.optimizeOptions ?? {})
      items = await qs
    } else {
      if (isPromiseLike(value)) value = await value
      items = Array.isArray(value) ? value : [...(value as Iterable<unknown>)]
    }
    return this.visible(cls, items, info)
  }

  // ---- type-level permissions ---------------------------------------------------------------------------

  private typeView(cls: ModelTypeClass, info: ResolveInfo): PermissionView {
    const model = modelOf(cls)
    return {
      action: 'query',
      info,
      model,
      typeClass: cls,
      get queryset() {
        return model._defaultManager.getQueryset()
      },
      getQueryset: () => model._defaultManager.getQueryset(),
    }
  }

  /** `hasPermission` of the type's permission classes (once per request and type). */
  async checkTypePermission(cls: ModelTypeClass, info: ResolveInfo): Promise<void> {
    const perms = cls.Meta?.permissionClasses
    if (!perms?.length) return
    const cache: Map<Function, Promise<void>> = stateMap(info.context, TYPE_PERMS, () => new Map())
    let p = cache.get(cls)
    if (!p) {
      p = checkPermissions(perms, info.context.request.withMethod('GET'), this.typeView(cls, info))
      cache.set(cls, p)
    }
    await p
  }

  private objectVisible(cls: ModelTypeClass, obj: unknown, info: ResolveInfo): Promise<boolean> {
    const perms = cls.Meta?.permissionClasses
    if (!perms?.length || !obj || typeof obj !== 'object') return Promise.resolve(true)
    const cache: WeakMap<object, Map<Function, Promise<boolean>>> = stateMap(
      info.context,
      OBJ_PERMS,
      () => new WeakMap(),
    )
    let per = cache.get(obj)
    if (!per) {
      per = new Map()
      cache.set(obj, per)
    }
    let p = per.get(cls)
    if (!p) {
      p = hasObjectPermissions(perms, info.context.request.withMethod('GET'), this.typeView(cls, info), obj)
      per.set(cls, p)
    }
    return p
  }

  /** Drop objects failing `hasObjectPermission`. */
  async visible(cls: ModelTypeClass, items: unknown[], info: ResolveInfo): Promise<unknown[]> {
    if (!cls.Meta?.permissionClasses?.length) return items
    await this.checkTypePermission(cls, info)
    const keep = await Promise.all(items.map((o) => this.objectVisible(cls, o, info)))
    return items.filter((_, i) => keep[i])
  }

  // ---- ModelType ------------------------------------------------------------------------------------------

  private modelObjectType(cls: ModelTypeClass): GraphQLObjectType {
    const model = modelOf(cls)
    const meta = cls.Meta!
    const name = typeNameOf(cls)
    const ext: TypeExtension = { cls, model, columns: {}, relations: {} }
    const perms = meta.permissionClasses
    const t = new GraphQLObjectType({
      name,
      description: meta.description ?? (model._meta.verboseNameRaw || undefined),
      interfaces: this.interfacesOf(cls),
      fields: () => this.modelFields(cls, ext),
      isTypeOf: perms?.length
        ? async (obj, ctx, info) => {
            const i = withContext(info, ctx)
            await this.checkTypePermission(cls, i)
            if (!(await this.objectVisible(cls, obj, i))) {
              await checkObjectPermissions(
                perms,
                i.context.request.withMethod('GET'),
                this.typeView(cls, i),
                obj,
              )
            }
            return true
          }
        : undefined,
      extensions: { ghuri: ext },
    })
    return this.remember(cls, t)
  }

  /** Names exposed by a ModelType (Meta.fields / exclude), resolved to model fields or reverse relations. */
  modelFieldEntries(
    cls: ModelTypeClass,
  ): Array<{ name: string; field?: any; rel?: any; raw?: any; explicit: boolean }> {
    const model = modelOf(cls)
    const meta = cls.Meta!
    const opts = model._meta
    const all: Array<{ name: string; field?: any; rel?: any }> = []
    for (const f of opts.forwardFields as any[]) {
      if (f.hidden) continue
      all.push({ name: f.name, field: f })
    }
    for (const r of opts.relatedObjects as any[]) {
      const accessor = r.getAccessorName()
      if (!accessor || r.field.reverseHidden || r.relatedModel._meta.autoCreated) continue
      all.push({ name: accessor, rel: r })
    }
    const exclude = new Set(meta.exclude ?? [])
    const declared = declaredFields(cls)
    if (Array.isArray(meta.fields)) {
      const byName = new Map(all.map((e) => [e.name, e]))
      const out: Array<{ name: string; field?: any; rel?: any; raw?: any; explicit: boolean }> = []
      for (const name of meta.fields as readonly string[]) {
        if (exclude.has(name)) continue
        const e = byName.get(name)
        if (e) {
          out.push({ ...e, explicit: true })
          continue
        }
        const f: any = opts.getForwardField(name)
        if (f && f.attname === name && f.isRelation) {
          out.push({ name, raw: f, explicit: true })
          continue
        }
        if (name === 'pk') {
          out.push({ name, field: opts.pk, explicit: true })
          continue
        }
        if (Object.hasOwn(declared, name)) continue
        throw new GraphQLConfigurationError(
          `${cls.name}.Meta.fields: "${name}" is not a field or reverse relation of ${opts.objectName}.`,
        )
      }
      return out
    }
    return all.filter((e) => !exclude.has(e.name)).map((e) => ({ ...e, explicit: false }))
  }

  private modelFields(cls: ModelTypeClass, ext: TypeExtension): GraphQLFieldConfigMap<any, any> {
    const out: GraphQLFieldConfigMap<any, any> = {}
    const declared = declaredFields(cls)
    const isNode = this.implementsNode(cls)
    const typeName = typeNameOf(cls)
    // interface fields (other than Node's id, generated below)
    for (const [name, ref] of Object.entries(this.interfaceFieldRefs(cls))) {
      if (name === 'id' && isNode) continue
      if (!Object.hasOwn(declared, name)) out[name] = this.fieldConfig(name, ref, cls)
    }
    const generated = new Map<string, GraphQLFieldConfig<any, any>>()
    for (const entry of this.modelFieldEntries(cls)) {
      const cfg = this.modelFieldConfig(cls, entry, ext)
      if (cfg) generated.set(entry.name, cfg)
    }
    for (const [name, cfg] of generated) if (!Object.hasOwn(declared, name)) out[name] = cfg
    if (isNode && !Object.hasOwn(declared, 'id')) {
      out.id = this.globalIdField(typeName, cls)
    }
    for (const [name, ref] of Object.entries(declared)) {
      const gen = generated.get(name)
      const def = isFieldDef(ref) ? ref : undefined
      const fallback = gen && !def?.options.resolve && !def?.options.source ? gen.resolve : undefined
      out[name] = this.fieldConfig(name, ref, cls, fallback)
    }
    return out
  }

  private globalIdField(typeName: string, cls: Function): GraphQLFieldConfig<any, any> {
    const custom = (cls as any).resolveId
    return {
      type: new GraphQLNonNull(GraphQLID),
      description: 'The ID of the object.',
      resolve: async (obj, _args, ctx, info) => {
        const raw = custom ? await custom.call(cls, obj, withContext(info, ctx)) : (obj?.pk ?? obj?.id)
        return toGlobalId(typeName, raw)
      },
    }
  }

  /** GraphQL input type for values of an ORM field (filters, mutation inputs). */
  fieldInputType(field: any): GraphQLInputType {
    if (field.isRelation) return GraphQLID
    if (field.primaryKey) return GraphQLID
    const enumT = this.choiceEnumFor(field)
    if (enumT) return enumT
    const t = scalarForModelField(field)
    return isInputType(t) ? t : GraphQLString
  }

  /** Enum generated for a field with `choices` (shared by every type exposing that field). */
  choiceEnumFor(field: any, owner?: ModelTypeClass): GraphQLEnumType | null {
    if (!field.choices?.length || field.isRelation) return null
    const convert = owner?.Meta?.convertChoicesToEnum ?? true
    if (convert === false) return null
    if (Array.isArray(convert) && !convert.includes(field.name)) return null
    let e = this.choiceEnums.get(field)
    if (e) return e
    const values: GraphQLEnumValueConfigMap = {}
    for (const [value, label] of field.choices as Array<[unknown, string]>) {
      if (value === '' || value === null) continue
      let name = enumValueName(value)
      while (values[name]) name = `${name}_`
      values[name] = { value, description: label }
    }
    const model = field.model
    e = new GraphQLEnumType({
      name: `${model._meta.objectName}${capitalize(field.name)}`,
      description: `Choices of ${model._meta.objectName}.${field.name}.`,
      values,
    })
    this.choiceEnums.set(field, this.addNamed(e))
    return e
  }

  private modelFieldConfig(
    cls: ModelTypeClass,
    entry: { name: string; field?: any; rel?: any; raw?: any; explicit: boolean },
    ext: TypeExtension,
  ): GraphQLFieldConfig<any, any> | null {
    const { name } = entry
    if (entry.raw) {
      const f = entry.raw
      ext.columns![name] = f.name
      return {
        type: f.null ? GraphQLID : new GraphQLNonNull(GraphQLID),
        description: `Raw value of ${f.name}.`,
        resolve: (obj) => obj?.[f.attname],
      }
    }
    if (entry.rel) return this.reverseRelationConfig(cls, entry, ext)
    const f = entry.field
    if (f.manyToMany) return this.manyToManyConfig(cls, entry, ext)
    if (f.isRelation) return this.foreignKeyConfig(cls, entry, ext)
    // scalar
    ext.columns![name] = f.name
    const enumT = this.choiceEnumFor(f, cls)
    const file = isFileField(f)
    const base = enumT ?? scalarForModelField(f)
    const isNullable = f.null || ((enumT || file) && f.blank)
    const attname = f.attname
    let resolve: GraphQLFieldResolver<any, any>
    if (file) {
      resolve = (obj) => {
        const v = obj?.[attname]
        if (!v || v.isEmpty || !v.name) return null
        return typeof v === 'string' ? v : v.url
      }
    } else if (enumT) {
      resolve = (obj) => {
        const v = obj?.[attname]
        return v === '' ? null : v
      }
    } else if (f.primaryKey && name === 'pk') {
      resolve = (obj) => obj?.pk
    } else {
      resolve = (obj) => obj?.[attname]
    }
    return {
      type: isNullable ? base : nonNull(base),
      description: f.helpText || undefined,
      resolve,
    }
  }

  private targetTypeOr(
    cls: ModelTypeClass,
    entry: { name: string; explicit: boolean },
    model: ModelClass,
  ): ModelTypeClass | null {
    const target = this.typeForModel(model)
    if (target) return target
    if (entry.explicit) {
      // `registerType` / `Field()` remember every referenced class process-wide; only used for this hint
      const elsewhere = registeredTypes().filter((t) => isModelTypeClass(t) && modelOf(t) === model)
      const hint = elsewhere.length
        ? ` (${elsewhere.map((t) => t.name).join(', ')} ${elsewhere.length > 1 ? 'are' : 'is'} not part of this schema)`
        : ''
      throw new GraphQLConfigurationError(
        `${cls.name}.${entry.name}: no ModelType for ${model._meta.label} is part of this schema${hint}. Reference one from this schema's fields or list it in Schema({ types: [...] }).`,
      )
    }
    return null
  }

  private foreignKeyConfig(
    cls: ModelTypeClass,
    entry: { name: string; field?: any; explicit: boolean },
    ext: TypeExtension,
  ): GraphQLFieldConfig<any, any> | null {
    const f = entry.field
    const target = this.targetTypeOr(cls, entry, f.relatedModel)
    if (!target) return null
    const defaultQs = hasDefaultQueryset(target)
    ext.relations![entry.name] = {
      kind: 'fk',
      lookup: f.name,
      defaultQs,
      target: typeNameOf(target),
      connection: false,
    } satisfies RelationMeta
    const t = this.output(target)
    return {
      type: f.null || !defaultQs ? t : nonNull(t),
      description: f.helpText || undefined,
      resolve: (obj, _args, ctx, info) => resolveForeignKey(obj, f, target, withContext(info, ctx)),
    }
  }

  private reverseRelationConfig(
    cls: ModelTypeClass,
    entry: { name: string; rel?: any; explicit: boolean },
    ext: TypeExtension,
  ): GraphQLFieldConfig<any, any> | null {
    const rel = entry.rel
    const target = this.targetTypeOr(cls, entry, rel.relatedModel)
    if (!target) return null
    if (rel.oneToOne) {
      ext.relations![entry.name] = {
        kind: 'o2o',
        lookup: entry.name,
        defaultQs: false,
        target: typeNameOf(target),
        connection: false,
      }
      return {
        type: this.output(target),
        resolve: (obj, _args, ctx, info) => resolveReverseOne(obj, rel, target, withContext(info, ctx)),
      }
    }
    if (rel.manyToMany) {
      return this.manyConfig(cls, entry.name, target, ext, 'm2m', (obj, info, opts) =>
        resolveManyToMany(obj, rel.field, true, target, info, opts),
      )
    }
    return this.manyConfig(cls, entry.name, target, ext, 'reverse', (obj, info, opts) =>
      resolveReverseMany(obj, rel, target, info, opts),
    )
  }

  private manyToManyConfig(
    cls: ModelTypeClass,
    entry: { name: string; field?: any; explicit: boolean },
    ext: TypeExtension,
  ): GraphQLFieldConfig<any, any> | null {
    const f = entry.field
    const target = this.targetTypeOr(cls, entry, f.relatedModel)
    if (!target) return null
    return this.manyConfig(cls, entry.name, target, ext, 'm2m', (obj, info, opts) =>
      resolveManyToMany(obj, f, false, target, info, opts),
    )
  }

  private manyConfig(
    _cls: ModelTypeClass,
    name: string,
    target: ModelTypeClass,
    ext: TypeExtension,
    kind: 'reverse' | 'm2m',
    load: (
      obj: any,
      info: ResolveInfo,
      opts: { transform?: (qs: QuerySet<any>) => QuerySet<any>; argsKey?: string },
    ) => Promise<unknown[]>,
  ): GraphQLFieldConfig<any, any> {
    const asConnection = this.implementsNode(target)
    ext.relations![name] = {
      kind,
      lookup: name,
      defaultQs: hasDefaultQueryset(target),
      target: typeNameOf(target),
      connection: asConnection,
    }
    if (!asConnection) {
      return {
        type: new GraphQLNonNull(new GraphQLList(nonNull(this.output(target)))),
        resolve: async (obj, _args, ctx, info) => {
          const i = withContext(info, ctx)
          await this.checkTypePermission(target, i)
          return this.visible(target, await load(obj, i, {}), i)
        },
      }
    }
    const typeName = typeNameOf(target)
    const filterSet = this.filterSetFor(target, typeName, target.Meta?.filterFields)
    const orderBy = target.Meta?.orderBy
    return {
      type: new GraphQLNonNull(this.connectionType(target)),
      args: this.connectionArgs(filterSet, orderBy),
      resolve: async (obj, args, ctx, info) => {
        const i = withContext(info, ctx)
        await this.checkTypePermission(target, i)
        const hasTransform = !!(args.filter || args.orderBy?.length)
        const transform = hasTransform
          ? (qs: QuerySet<any>) =>
              applyOrderBy(applyFilter(this, filterSet, qs, args.filter), args.orderBy, orderBy ?? [])
          : undefined
        const argsKey = hasTransform ? JSON.stringify([args.filter ?? null, args.orderBy ?? null]) : ''
        const items = await this.visible(target, await load(obj, i, { transform, argsKey }), i)
        return paginateArray(items, args, { maxLimit: this.maxLimit(i), name: `${typeName}Connection` })
      },
    }
  }

  maxLimit(info: ResolveInfo, override?: number): number {
    return override ?? graphqlSettings(info.context.c).RELAY_CONNECTION_MAX_LIMIT ?? 100
  }

  // ---- connections ---------------------------------------------------------------------------------------

  pageInfo(): GraphQLObjectType {
    this.pageInfoType ??= this.addNamed(
      new GraphQLObjectType({
        name: 'PageInfo',
        description: 'Information about pagination in a connection.',
        fields: {
          hasNextPage: { type: new GraphQLNonNull(GraphQLBoolean) },
          hasPreviousPage: { type: new GraphQLNonNull(GraphQLBoolean) },
          startCursor: { type: GraphQLString },
          endCursor: { type: GraphQLString },
        },
      }),
    )
    return this.pageInfoType
  }

  /** `<Type>Connection` (or the connection class) for a node type. */
  connectionType(nodeRef: TypeRef, connectionClass?: TypeRef): GraphQLObjectType {
    const nodeType = this.output(nodeRef) as GraphQLNamedType
    const nodeCls = typeExtension(nodeType)?.cls
    const connRef =
      connectionClass ?? (nodeCls && isModelTypeClass(nodeCls) ? nodeCls.Meta?.connectionClass : undefined)
    const connCls = connRef ? (normalize(connRef) as any).cls : undefined
    const name = connCls ? typeNameOf(connCls) : `${nodeType.name}Connection`
    const cached = this.connections.get(name)
    if (cached) {
      if (typeExtension(cached)?.connectionOf !== nodeType.name) {
        throw new GraphQLConfigurationError(`Connection "${name}" is used for two different node types.`)
      }
      return cached
    }
    const edgeName = `${name.replace(/Connection$/, '')}Edge`
    const edge = this.addNamed(
      new GraphQLObjectType({
        name: edgeName,
        description: `An edge of ${name}.`,
        fields: {
          node: { type: nodeType as GraphQLOutputType, description: 'The item at the end of the edge.' },
          cursor: { type: new GraphQLNonNull(GraphQLString), description: 'A cursor for use in pagination.' },
        },
      }),
    )
    const conn = new GraphQLObjectType({
      name,
      description: (connCls as any)?.Meta?.description ?? `A paginated list of ${nodeType.name}.`,
      fields: () => {
        const out: GraphQLFieldConfigMap<any, any> = {
          pageInfo: { type: new GraphQLNonNull(this.pageInfo()), description: 'Pagination data.' },
          edges: {
            type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(edge))),
            description: 'Contains the nodes.',
          },
          totalCount: {
            type: new GraphQLNonNull(GraphQLInt),
            description: 'Total number of items (all pages).',
            resolve: (c: ConnectionResult) => c.totalCount(),
          },
        }
        if (connCls)
          for (const [n, ref] of Object.entries(declaredFields(connCls)))
            out[n] = this.fieldConfig(n, ref, connCls)
        return out
      },
      extensions: { ghuri: { cls: connCls, connectionOf: nodeType.name } satisfies TypeExtension },
    })
    this.connections.set(name, this.addNamed(conn, connCls))
    return conn
  }

  filterSetFor(cls: ModelTypeClass, prefix: string, spec: any): FilterSet | null {
    if (!spec) return null
    const key = `${prefix}`
    if (this.filterSets.has(key)) return this.filterSets.get(key)!
    const set = buildFilterSet(this, prefix, modelOf(cls), spec)
    this.filterSets.set(key, set)
    return set
  }

  connectionArgs(filterSet: FilterSet | null, orderBy: unknown): GraphQLFieldConfigArgumentMap {
    const args: GraphQLFieldConfigArgumentMap = {
      first: { type: GraphQLInt, description: 'Return the first n items (after `after`).' },
      after: { type: GraphQLString, description: 'Cursor: return items after this one.' },
      last: { type: GraphQLInt, description: 'Return the last n items (before `before`).' },
      before: { type: GraphQLString, description: 'Cursor: return items before this one.' },
    }
    if (filterSet) args.filter = { type: filterSet.input, description: 'Filter the items.' }
    if (orderBy) {
      args.orderBy = {
        type: new GraphQLList(new GraphQLNonNull(GraphQLString)),
        description: 'Order by these fields (prefix with "-" for descending).',
      }
    }
    return args
  }

  private connectionFieldConfig(
    name: string,
    def: FieldDef,
    ref: any,
    owner: Function | undefined,
  ): GraphQLFieldConfig<any, any> {
    const nodeType = this.output(ref.node) as GraphQLNamedType
    const nodeCls = typeExtension(nodeType)?.cls
    const modelCls = nodeCls && isModelTypeClass(nodeCls) ? nodeCls : undefined
    const connType = this.connectionType(ref.node, ref.connectionClass)
    let filterSet: FilterSet | null = null
    if (modelCls && ref.filterFields !== false) {
      if (ref.filterFields) {
        const ownerName = owner ? (isSubclassOf(owner, Query) ? 'Query' : typeNameOf(owner)) : 'Query'
        filterSet = this.filterSetFor(modelCls, `${ownerName}${capitalize(name)}`, ref.filterFields)
      } else filterSet = this.filterSetFor(modelCls, typeNameOf(modelCls), modelCls.Meta?.filterFields)
    }
    const orderBy = ref.orderBy === false ? undefined : (ref.orderBy ?? modelCls?.Meta?.orderBy)
    const userResolve = def.options.resolve as Resolver | undefined
    const ownerResolver = owner ? (owner as any)[`resolve${capitalize(name)}`] : undefined
    const perms = def.options.permissionClasses
    const args = { ...this.connectionArgs(filterSet, orderBy), ...this.argsConfig(def.options.args) }
    return {
      type: new GraphQLNonNull(connType),
      args,
      description: def.options.description,
      deprecationReason: def.options.deprecationReason,
      resolve: async (parent, fieldArgs, ctx, info) => {
        const i = withContext(info, ctx)
        if (perms?.length) {
          await checkPermissions(
            perms,
            i.context.request.withMethod(this.methodOf(i), fieldArgs),
            this.viewFor(
              i,
              fieldArgs,
              modelCls
                ? {
                    model: modelOf(modelCls),
                    getQueryset: () => modelOf(modelCls)._defaultManager.getQueryset(),
                  }
                : {},
            ),
          )
        }
        let source: any
        if (userResolve) source = userResolve(parent, fieldArgs, i)
        else if (typeof ownerResolver === 'function') source = ownerResolver.call(owner, parent, fieldArgs, i)
        else if (parent && parent[name] !== undefined) source = parent[name]
        else if (modelCls) source = modelOf(modelCls)._defaultManager.getQueryset()
        // never await a QuerySet (it is thenable): it would run unpaginated
        if (!isQuerySet(source) && isPromiseLike(source)) source = await source
        if (isManager(source)) source = source.all()
        if (modelCls) await this.checkTypePermission(modelCls, i)
        if (modelCls && isQuerySet(source)) {
          let qs: QuerySet<any> = typeQueryset(modelCls, i, source)
          qs = applyFilter(this, filterSet, qs, fieldArgs.filter)
          qs = applyOrderBy(qs, fieldArgs.orderBy, orderBy ?? [])
          qs = ensureOrdered(qs)
          if (this.optimizeOptions || graphqlSettings(i.context.c).OPTIMIZE)
            qs = optimize(qs, i, this.optimizeOptions ?? {})
          source = qs
        }
        const result = await paginate(source, fieldArgs, {
          maxLimit: this.maxLimit(i, ref.maxLimit),
          name: connType.name,
        })
        if (modelCls?.Meta?.permissionClasses?.length) {
          const keep = await this.visible(
            modelCls,
            result.edges.map((e) => e.node),
            i,
          )
          const set = new Set(keep)
          result.edges = result.edges.filter((e) => set.has(e.node))
        }
        return result
      },
    }
  }

  // ---- node fields ----------------------------------------------------------------------------------------

  private nodeFieldConfig(def: FieldDef, ref: any): GraphQLFieldConfig<any, any> {
    const onlyName = ref.only ? (this.output(ref.only) as GraphQLNamedType).name : undefined
    const type = this.output(ref)
    if (ref.many) {
      return {
        type,
        description: def.options.description,
        args: { ids: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLID))) } },
        resolve: (_p, args, ctx, info) => {
          const i = withContext(info, ctx)
          return Promise.all((args.ids as string[]).map((id) => this.resolveNode(id, i, onlyName)))
        },
      }
    }
    return {
      type,
      description: def.options.description,
      args: { id: { type: new GraphQLNonNull(GraphQLID), description: 'The global ID of the object.' } },
      resolve: (_p, args, ctx, info) => this.resolveNode(args.id, withContext(info, ctx), onlyName),
    }
  }

  /** `node(id:)`: decode, find the type, `getNode()`, tag the object with its type. */
  async resolveNode(globalId: string, info: ResolveInfo, onlyName?: string): Promise<unknown> {
    const g = fromGlobalId(globalId)
    if (!g) {
      throw new GraphQLError(`Unable to parse global ID "${globalId}".`, {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }
    if (onlyName && g.type !== onlyName) {
      throw new GraphQLError(`Must receive a ${onlyName} id.`, { extensions: { code: 'BAD_USER_INPUT' } })
    }
    // only Node types of this schema (classByName is per builder; the schema check is a second guard)
    const cls = this.classByName.get(g.type)
    if (!cls || !this.implementsNode(cls) || !info.schema.getType(g.type)) {
      throw new GraphQLError(`Relay Node "${g.type}" not found in schema.`, {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }
    const getNode = (cls as any).getNode
    if (typeof getNode !== 'function') {
      throw new GraphQLConfigurationError(`${cls.name} implements Node but has no static getNode(id, info).`)
    }
    let obj: unknown
    if (isModelTypeClass(cls) && getNode === ModelType.getNode) {
      await this.checkTypePermission(cls, info)
      obj = await loadNode(cls, g.id, info)
    } else obj = await getNode.call(cls, g.id, info)
    if (obj === null || obj === undefined) return null
    if (isModelTypeClass(cls) && !(await this.objectVisible(cls, obj, info))) return null
    if (typeof obj === 'object') {
      const tags: WeakMap<object, string> = stateMap(info.context, NODE_TYPES, () => new WeakMap())
      tags.set(obj as object, g.type)
    }
    return obj
  }

  // ---- shared types for mutations ----------------------------------------------------------------------

  /** `ErrorType { field: String!, messages: [String!]! }` (graphene-django's). */
  errorType(): GraphQLObjectType {
    this.errorTypeCache ??= this.addNamed(
      new GraphQLObjectType({
        name: 'ErrorType',
        description:
          'A validation error of a mutation input field (`__all__` / `nonFieldErrors` for the whole input).',
        fields: {
          field: { type: new GraphQLNonNull(GraphQLString) },
          messages: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
        },
      }),
    )
    return this.errorTypeCache
  }

  /** Root type (`Query` / `Mutation`) merging the `static fields` of several classes. */
  rootType(name: string, classes: Function[]): GraphQLObjectType | undefined {
    if (!classes.length) return undefined
    const t = new GraphQLObjectType({
      name,
      fields: () => {
        const out: GraphQLFieldConfigMap<any, any> = {}
        const owners = new Map<string, Function>()
        for (const cls of classes) {
          for (const [field, ref] of Object.entries(declaredFields(cls))) {
            const prev = owners.get(field)
            if (prev && prev !== cls) {
              throw new GraphQLConfigurationError(
                `${name} field "${field}" is defined by both ${prev.name} and ${cls.name}.`,
              )
            }
            owners.set(field, cls)
            out[field] = this.fieldConfig(field, ref, cls)
          }
        }
        return out
      },
    })
    return this.addNamed(t)
  }
}

function defaultProp(parent: any, _args: unknown, _ctx: unknown, info: any): unknown {
  const v = parent?.[info.fieldName]
  return typeof v === 'function' ? v.call(parent) : v
}
