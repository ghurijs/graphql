// Validation rules: query depth and a simple complexity estimate.
import {
  type ASTVisitor,
  type FieldNode,
  type FragmentDefinitionNode,
  GraphQLError,
  Kind,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
  type ValidationRule,
  type ValueNode,
} from 'graphql'

function isIntrospection(node: FieldNode): boolean {
  return node.name.value.startsWith('__')
}

function selectionDepth(
  set: SelectionSetNode | undefined,
  fragments: (name: string) => FragmentDefinitionNode | null | undefined,
  visiting: Set<string>,
): number {
  if (!set) return 0
  let max = 0
  for (const sel of set.selections) {
    let d = 0
    if (sel.kind === Kind.FIELD) {
      if (isIntrospection(sel)) continue
      d = 1 + selectionDepth(sel.selectionSet, fragments, visiting)
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      d = selectionDepth(sel.selectionSet, fragments, visiting)
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const name = sel.name.value
      if (visiting.has(name)) continue
      const frag = fragments(name)
      if (!frag) continue
      visiting.add(name)
      d = selectionDepth(frag.selectionSet, fragments, visiting)
      visiting.delete(name)
    }
    if (d > max) max = d
  }
  return max
}

/** Depth of an operation (`{ posts { author { name } } }` is 3). Introspection fields are ignored. */
export function operationDepth(
  op: OperationDefinitionNode,
  fragments: (name: string) => FragmentDefinitionNode | null | undefined,
): number {
  return selectionDepth(op.selectionSet, fragments, new Set())
}

/** Reject operations nested deeper than `maxDepth` (`GRAPHQL.MAX_DEPTH`). */
export function depthLimit(maxDepth: number): ValidationRule {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(node) {
      const depth = operationDepth(node, (n) => context.getFragment(n))
      if (depth > maxDepth) {
        context.reportError(
          new GraphQLError(`Query depth ${depth} exceeds the maximum allowed depth of ${maxDepth}.`, {
            nodes: [node],
            extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
          }),
        )
      }
    },
  })
}

export interface ComplexityOptions {
  /** Variable values (so `first: $n` counts). */
  variables?: Record<string, unknown> | null
  /** Multiplier for list fields without `first` / `last` (default 1). */
  defaultListSize?: number
}

function intValue(
  node: ValueNode | undefined,
  variables: Record<string, unknown> | null | undefined,
): number | undefined {
  if (!node) return undefined
  if (node.kind === Kind.INT) return Number(node.value)
  if (node.kind === Kind.VARIABLE) {
    const v = variables?.[node.name.value]
    return typeof v === 'number' ? v : undefined
  }
  return undefined
}

function selectionCost(
  set: SelectionSetNode | undefined,
  fragments: (name: string) => FragmentDefinitionNode | null | undefined,
  opts: ComplexityOptions,
  visiting: Set<string>,
): number {
  if (!set) return 0
  let total = 0
  for (const sel of set.selections) {
    if (sel.kind === Kind.FIELD) {
      if (isIntrospection(sel)) continue
      const sizeArg = sel.arguments?.find((a) => a.name.value === 'first' || a.name.value === 'last')
      const multiplier = Math.max(
        1,
        intValue(sizeArg?.value, opts.variables) ?? (sel.selectionSet ? (opts.defaultListSize ?? 1) : 1),
      )
      total += 1 + multiplier * selectionCost(sel.selectionSet, fragments, opts, visiting)
    } else if (sel.kind === Kind.INLINE_FRAGMENT) {
      total += selectionCost(sel.selectionSet, fragments, opts, visiting)
    } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
      const name = sel.name.value
      if (visiting.has(name)) continue
      const frag = fragments(name)
      if (!frag) continue
      visiting.add(name)
      total += selectionCost(frag.selectionSet, fragments, opts, visiting)
      visiting.delete(name)
    }
  }
  return total
}

/**
 * Simple complexity: every field costs 1, and the cost of a field's selection is multiplied by its
 * `first` / `last` argument (literal or variable). `allPosts(first: 50) { edges { node { title } } }` costs
 * 1 + 50 × (1 + (1 + 1)) = 151.
 */
export function operationComplexity(
  op: OperationDefinitionNode,
  fragments: (name: string) => FragmentDefinitionNode | null | undefined,
  opts: ComplexityOptions = {},
): number {
  return selectionCost(op.selectionSet, fragments, opts, new Set())
}

/** Reject operations whose complexity exceeds `maxComplexity` (`GRAPHQL.MAX_COMPLEXITY`). */
export function complexityLimit(maxComplexity: number, opts: ComplexityOptions = {}): ValidationRule {
  return (context: ValidationContext): ASTVisitor => ({
    OperationDefinition(node) {
      const cost = operationComplexity(node, (n) => context.getFragment(n), opts)
      if (cost > maxComplexity) {
        context.reportError(
          new GraphQLError(
            `Query complexity ${cost} exceeds the maximum allowed complexity of ${maxComplexity}.`,
            {
              nodes: [node],
              extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
            },
          ),
        )
      }
    },
  })
}
