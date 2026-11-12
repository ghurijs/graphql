// AST-based query optimizer: turns the GraphQL selection into selectRelated / prefetchRelated / only.
import type { QuerySet } from '@ghuri/orm'
import {
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLNamedType,
  GraphQLObjectType,
  type GraphQLSchema,
  getNamedType,
  Kind,
  type SelectionSetNode,
} from 'graphql'
import type { ResolveInfo } from './types/definitions'

/** Relation metadata the schema builder stores on generated object types (`extensions.ghuri`). */
export interface RelationMeta {
  kind: 'fk' | 'o2o' | 'reverse' | 'm2m'
  /** Path segment for selectRelated / prefetchRelated (field name or reverse accessor). */
  lookup: string
  /** The related type has the default `getQueryset` (joins / prefetches are allowed). */
  defaultQs: boolean
  /** GraphQL name of the related object type. */
  target: string
  /** Field returns a connection (has pagination arguments) — never prefetched. */
  connection: boolean
}

export interface TypeExtension {
  cls?: Function
  model?: any
  /** GraphQL field name → model column name (for `only`). */
  columns?: Record<string, string>
  relations?: Record<string, RelationMeta>
  /** Set on connection types: name of the node type. */
  connectionOf?: string
}

export function typeExtension(type: GraphQLNamedType | null | undefined): TypeExtension | undefined {
  return (type?.extensions as any)?.ghuri as TypeExtension | undefined
}

export interface OptimizeOptions {
  /** Also restrict loaded columns with `only()` (opt-in: custom resolvers may need other columns). */
  only?: boolean
  /** Maximum relation depth followed (default 4). */
  maxDepth?: number
}

interface Plan {
  select: Set<string>
  prefetch: Set<string>
  columns: Set<string>
  onlySafe: boolean
}

function* fieldsOf(
  selectionSet: SelectionSetNode | undefined,
  fragments: Record<string, FragmentDefinitionNode>,
  typeName: string,
  schema: GraphQLSchema,
  seen = new Set<string>(),
): Generator<FieldNode> {
  if (!selectionSet) return
  for (const sel of selectionSet.selections) {
    if (sel.kind === Kind.FIELD) yield sel
    else if (sel.kind === Kind.INLINE_FRAGMENT) {
      const cond = sel.typeCondition?.name.value
      if (cond && !typeMatches(schema, cond, typeName)) continue
      yield* fieldsOf(sel.selectionSet, fragments, typeName, schema, seen)
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const name = sel.name.value
      if (seen.has(name)) continue
      seen.add(name)
      const frag = fragments[name]
      if (!frag || !typeMatches(schema, frag.typeCondition.name.value, typeName)) continue
      yield* fieldsOf(frag.selectionSet, fragments, typeName, schema, seen)
    }
  }
}

function typeMatches(schema: GraphQLSchema, condition: string, typeName: string): boolean {
  if (condition === typeName) return true
  const cond = schema.getType(condition)
  const type = schema.getType(typeName)
  if (!cond || !(type instanceof GraphQLObjectType)) return false
  try {
    return schema.isSubType(cond as any, type)
  } catch {
    return false
  }
}

function walk(
  info: ResolveInfo,
  type: GraphQLObjectType,
  selectionSet: SelectionSetNode | undefined,
  prefix: string,
  inPrefetch: boolean,
  depth: number,
  plan: Plan,
  opts: OptimizeOptions,
  root: boolean,
): void {
  const ext = typeExtension(type)
  if (!ext) return
  for (const node of fieldsOf(selectionSet, info.fragments, type.name, info.schema)) {
    const name = node.name.value
    if (name === '__typename') continue
    const rel = ext.relations?.[name]
    const column = ext.columns?.[name]
    if (root) {
      if (column) plan.columns.add(column)
      else if (!rel) plan.onlySafe = false
    }
    if (!rel) continue
    if (root && (rel.kind === 'fk' || rel.kind === 'o2o') && column === undefined)
      plan.columns.add(rel.lookup)
    if (!rel.defaultQs || depth >= (opts.maxDepth ?? 4)) continue
    const target = info.schema.getType(rel.target)
    if (!(target instanceof GraphQLObjectType)) continue
    const path = `${prefix}${rel.lookup}`
    if (rel.kind === 'fk') {
      if (inPrefetch) plan.prefetch.add(path)
      else plan.select.add(path)
      walk(info, target, node.selectionSet, `${path}__`, inPrefetch, depth + 1, plan, opts, false)
    } else if (!rel.connection && !node.arguments?.length) {
      plan.prefetch.add(path)
      walk(info, target, node.selectionSet, `${path}__`, true, depth + 1, plan, opts, false)
    }
  }
}

/**
 * Optimize a QuerySet for the current field's selection: forward foreign keys become `selectRelated`
 * joins, reverse / many-to-many lists `prefetchRelated` (when the related type has no custom `getQueryset`
 * and the field has no arguments), and with `{ only: true }` unselected columns are skipped.
 * Works for list fields and connection fields (it looks inside `edges { node { … } }`).
 *
 * ```ts
 * resolve: (_, args, info) => optimize(Post.objects.filter({ published: true }), info)
 * ```
 */
export function optimize<T>(qs: QuerySet<T>, info: ResolveInfo, opts: OptimizeOptions = {}): QuerySet<T> {
  let type = getNamedType(info.returnType) as GraphQLNamedType
  const fieldNodes = info.fieldNodes
  let selections: SelectionSetNode[] = fieldNodes
    .map((n) => n.selectionSet)
    .filter(Boolean) as SelectionSetNode[]
  const conn = typeExtension(type)?.connectionOf
  if (conn && type instanceof GraphQLObjectType) {
    const nodeType = info.schema.getType(conn)
    const nodeSelections: SelectionSetNode[] = []
    const edgeType = getNamedType(type.getFields().edges?.type) as GraphQLNamedType | undefined
    for (const sel of selections) {
      for (const edges of fieldsOf(sel, info.fragments, type.name, info.schema)) {
        if (edges.name.value !== 'edges' || !edgeType) continue
        for (const n of fieldsOf(edges.selectionSet, info.fragments, edgeType.name, info.schema)) {
          if (n.name.value === 'node' && n.selectionSet) nodeSelections.push(n.selectionSet)
        }
      }
    }
    if (!(nodeType instanceof GraphQLObjectType)) return qs
    type = nodeType
    selections = nodeSelections
  }
  if (!(type instanceof GraphQLObjectType) || !typeExtension(type)?.model) return qs
  const plan: Plan = { select: new Set(), prefetch: new Set(), columns: new Set(), onlySafe: true }
  for (const sel of selections) walk(info, type, sel, '', false, 0, plan, opts, true)
  let out = qs
  if (plan.select.size) out = out.selectRelated(...plan.select)
  if (plan.prefetch.size) out = out.prefetchRelated(...plan.prefetch)
  if (opts.only && plan.onlySafe && !plan.select.size && plan.columns.size) out = out.only(...plan.columns)
  return out
}
