// `filter:` arguments generated from `filterFields`, mapped to ORM lookups.
//
// Design: one nested input per type — `filter: { title: { icontains: "ghuri" }, published: { exact: true },
// author: { in: ["1", "2"] }, or: [{ …}, { …}], not: { … } }` — instead of graphene-django-filter's flat
// `title_Icontains` arguments: it is typed per lookup, composes with and/or/not, and keeps argument lists short.
import { FieldError, type ModelClass, Q, type QNode, type QuerySet } from '@ghuri/orm'
import {
  GraphQLBoolean,
  GraphQLError,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLInputType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql'
import { DateScalar, Time } from '../scalars'
import type { FilterFieldsSpec } from '../types/modeltype'
import { camelize, capitalize } from '../utils'
import { fromGlobalId } from './node'

const TEXT_LOOKUPS = new Set([
  'iexact',
  'contains',
  'icontains',
  'startswith',
  'istartswith',
  'endswith',
  'iendswith',
  'regex',
  'iregex',
])
const INT_TRANSFORMS = new Set(['year', 'month', 'day', 'hour', 'minute', 'second', 'week_day', 'quarter'])

/** What the filter builder needs from the schema builder. */
export interface FilterTypeSource {
  /** GraphQL input type for values of an ORM field (scalar, enum for choices, `ID` for relations). */
  fieldInputType(field: any): GraphQLInputType
  /** Names of `Node` types registered for a model (their global IDs are accepted for pk / relation lookups). */
  nodeTypeNamesFor(model: ModelClass): Set<string>
  /** Register a named type (uniqueness check). */
  addNamed<T extends GraphQLInputObjectType>(type: T): T
}

export interface FilterEntry {
  /** ORM path (`author__username`). */
  path: string
  /** GraphQL field name (`authorUsername`). */
  name: string
  lookups: string[]
  /** GraphQL lookup name → ORM lookup. */
  lookupNames: Map<string, string>
  /** Values are ids of this model (pk / relation): global IDs are decoded. */
  idModel?: ModelClass
  /** The path crosses a multi-valued relation (reverse FK / M2M): results need `distinct()`. */
  multi: boolean
}

export interface FilterSet {
  input: GraphQLInputObjectType
  entries: FilterEntry[]
  model: ModelClass
}

/** `['a', 'b']` → `{ a: ['exact'], b: ['exact'] }`. */
export function normalizeFilterFields(spec: FilterFieldsSpec): Array<[string, string[]]> {
  if (Array.isArray(spec)) return (spec as readonly string[]).map((n) => [n, ['exact']])
  return Object.entries(spec as Record<string, readonly string[]>).map(([k, v]) => [
    k,
    v.length ? [...v] : ['exact'],
  ])
}

interface ResolvedPath {
  field: any
  /** The model the final field belongs to. */
  model: ModelClass
  /** The value is an id of this model (pk, FK, reverse / M2M relation). */
  idModel?: ModelClass
  multi: boolean
}

/** Walk `author__username` through relations to the final field. */
export function resolveFilterPath(model: ModelClass, path: string): ResolvedPath {
  const parts = path.split('__')
  let current = model
  let multi = false
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const f: any = current._meta.findField(part)
    if (!f)
      throw new FieldError(`Cannot filter ${model._meta.objectName} on '${path}': unknown field '${part}'.`)
    const last = i === parts.length - 1
    if (f.isRelation) {
      const target: ModelClass = f.internalType === 'RelatedObject' ? f.relatedModel : f.relatedModel
      multi ||= !!(f.manyToMany || f.oneToMany)
      if (last) return { field: f, model: current, idModel: target, multi }
      current = target
      continue
    }
    if (!last)
      throw new FieldError(
        `Cannot filter ${model._meta.objectName} on '${path}': '${part}' is not a relation.`,
      )
    return { field: f, model: current, idModel: f.primaryKey ? current : undefined, multi }
  }
  throw new FieldError(`Invalid filter path '${path}'.`)
}

function lookupType(src: FilterTypeSource, resolved: ResolvedPath, lookup: string): GraphQLInputType {
  const base = src.fieldInputType(resolved.field)
  if (lookup === 'isnull') return GraphQLBoolean
  if (lookup === 'in' || lookup === 'range') return new GraphQLList(new GraphQLNonNull(base as any))
  if (TEXT_LOOKUPS.has(lookup)) return GraphQLString
  if (INT_TRANSFORMS.has(lookup)) return GraphQLInt
  if (lookup === 'date') return DateScalar
  if (lookup === 'time') return Time
  return base
}

/**
 * Build the `<TypeName>Filter` input for a type (null when there are no filter fields). Each entry becomes a
 * `<TypeName><Field>Filter` input with one field per lookup.
 */
export function buildFilterSet(
  src: FilterTypeSource,
  typeName: string,
  model: ModelClass,
  spec: FilterFieldsSpec,
): FilterSet | null {
  const pairs = normalizeFilterFields(spec)
  if (!pairs.length) return null
  const entries: FilterEntry[] = []
  const fields: GraphQLInputFieldConfigMap = {}
  for (const [path, lookups] of pairs) {
    const resolved = resolveFilterPath(model, path)
    const name = camelize(path)
    const lookupNames = new Map<string, string>()
    const lookupFields: GraphQLInputFieldConfigMap = {}
    for (const lookup of lookups) {
      const gqlName = camelize(lookup)
      lookupNames.set(gqlName, lookup)
      lookupFields[gqlName] = { type: lookupType(src, resolved, lookup) }
    }
    const entryInput = src.addNamed(
      new GraphQLInputObjectType({
        name: `${typeName}${capitalize(name)}Filter`,
        description: `Lookups on \`${path}\`.`,
        fields: lookupFields,
      }),
    )
    fields[name] = { type: entryInput }
    entries.push({ path, name, lookups, lookupNames, idModel: resolved.idModel, multi: resolved.multi })
  }
  let input: GraphQLInputObjectType
  input = src.addNamed(
    new GraphQLInputObjectType({
      name: `${typeName}Filter`,
      description: `Filters for ${typeName}. Conditions are combined with AND.`,
      fields: () => ({
        ...fields,
        and: { type: new GraphQLList(new GraphQLNonNull(input)), description: 'All of these.' },
        or: { type: new GraphQLList(new GraphQLNonNull(input)), description: 'Any of these.' },
        not: { type: input, description: 'None of this.' },
      }),
    }),
  )
  return { input, entries, model }
}

function decodeId(src: FilterTypeSource, model: ModelClass | undefined, v: unknown): unknown {
  if (!model || typeof v !== 'string') return v
  const g = fromGlobalId(v)
  if (g && src.nodeTypeNamesFor(model).has(g.type)) return g.id
  return v
}

/** Turn a `filter:` argument value into a Q object. */
export function filterToQ(
  src: FilterTypeSource,
  set: FilterSet,
  value: Record<string, any> | null | undefined,
): QNode {
  let q = Q({})
  if (!value) return q
  for (const entry of set.entries) {
    const lookups = value[entry.name]
    if (!lookups) continue
    for (const [gqlName, raw] of Object.entries(lookups as Record<string, unknown>)) {
      if (raw === undefined) continue
      const lookup = entry.lookupNames.get(gqlName) ?? gqlName
      let v: unknown = raw
      if (entry.idModel && lookup !== 'isnull') {
        v = Array.isArray(raw)
          ? raw.map((x) => decodeId(src, entry.idModel, x))
          : decodeId(src, entry.idModel, raw)
      }
      if (lookup === 'range' && (!Array.isArray(v) || v.length !== 2)) {
        throw new GraphQLError(`"${entry.name}.range" expects exactly two values.`, {
          extensions: { code: 'BAD_USER_INPUT' },
        })
      }
      if (v === null && lookup !== 'exact') continue
      const key =
        lookup === 'exact' ? (v === null ? `${entry.path}__isnull` : entry.path) : `${entry.path}__${lookup}`
      q = q.and(Q({ [key]: v === null ? true : v }))
    }
  }
  if (Array.isArray(value.and)) for (const sub of value.and) q = q.and(filterToQ(src, set, sub))
  if (Array.isArray(value.or) && value.or.length) {
    const ors = value.or.map((sub: any) => filterToQ(src, set, sub))
    q = q.and(ors.reduce((acc: QNode, o: QNode) => acc.or(o)))
  }
  if (value.not) q = q.and(filterToQ(src, set, value.not).not())
  return q
}

/** Apply a `filter:` value to a QuerySet. */
export function applyFilter<T>(
  src: FilterTypeSource,
  set: FilterSet | null | undefined,
  qs: QuerySet<T>,
  value: Record<string, any> | null | undefined,
): QuerySet<T> {
  if (!set || !value) return qs
  const q = filterToQ(src, set, value)
  if (q.isEmpty) return qs
  const filtered = qs.filter(q)
  // relation spans (reverse FK / M2M) can duplicate rows
  return set.entries.some((e) => e.multi) ? filtered.distinct() : filtered
}

// ---- orderBy --------------------------------------------------------------------------------------------

/** Concrete fields (and FK names) usable in `orderBy` for `'__all__'`. */
export function allOrderableFields(model: ModelClass): string[] {
  return model._meta.concreteFields.map((f: any) => f.name)
}

/** Validate and apply `orderBy: ["-createdAt", "title"]`. */
export function applyOrderBy<T>(
  qs: QuerySet<T>,
  values: readonly string[] | null | undefined,
  allowed: readonly string[] | '__all__',
): QuerySet<T> {
  if (!values?.length) return qs
  const allow = new Set(allowed === '__all__' ? allOrderableFields(qs.model) : allowed)
  const ordering = values.map((raw) => {
    const desc = raw.startsWith('-')
    const name = (desc ? raw.slice(1) : raw.startsWith('+') ? raw.slice(1) : raw).trim()
    const path = name.replace(/\./g, '__')
    if (!allow.has(path) && !allow.has(name)) {
      throw new GraphQLError(
        `Cannot order by "${raw}". Allowed: ${[...allow].map((a) => JSON.stringify(a)).join(', ')} (prefix "-" for descending).`,
        { extensions: { code: 'BAD_USER_INPUT' } },
      )
    }
    return desc ? `-${path}` : path
  })
  return qs.orderBy(...ordering)
}

/** Make sure a QuerySet has a deterministic order (pagination needs one): append the pk. */
export function ensureOrdered<T>(qs: QuerySet<T>): QuerySet<T> {
  const pk = qs.model._meta.pk.name
  const state: any = (qs as any).state
  const ordering: Array<string | unknown> | null = state?.ordering ?? null
  const effective = ordering ?? qs.model._meta.ordering
  if (!effective.length) return qs.orderBy(pk)
  const names = effective.map((o: any) => (typeof o === 'string' ? o.replace(/^-/, '') : null))
  if (names.includes(pk) || names.includes('pk') || names.includes('id')) return qs
  return qs.orderBy(...(effective as any[]), pk)
}
