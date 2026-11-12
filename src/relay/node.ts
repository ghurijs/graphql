// Relay `Node` interface and global IDs.
import { ID } from '../scalars'
import { FieldDef, Interface, NonNull, type TypeRef } from '../types/definitions'
import { base64Decode, base64Encode } from '../utils'

/** `toGlobalId('PostType', 1)` → base64 of `PostType:1` (graphql-relay format). */
export function toGlobalId(typeName: string, id: unknown): string {
  return base64Encode(`${typeName}:${String(id)}`)
}

export interface ResolvedGlobalId {
  type: string
  id: string
}

/** Decode a global ID; returns null for anything that isn't `base64(Type:id)`. */
export function fromGlobalId(globalId: unknown): ResolvedGlobalId | null {
  if (typeof globalId !== 'string' || !globalId || !/^[A-Za-z0-9+/=_-]+$/.test(globalId)) return null
  let decoded: string
  try {
    decoded = base64Decode(globalId.replace(/-/g, '+').replace(/_/g, '/'))
  } catch {
    return null
  }
  const idx = decoded.indexOf(':')
  if (idx <= 0) return null
  const type = decoded.slice(0, idx)
  if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(type)) return null
  return { type, id: decoded.slice(idx + 1) }
}

/**
 * The Relay `Node` interface (`id: ID!` holding a global ID). Add it to `Meta.interfaces` of a type and expose
 * `node` / `nodes` root fields with `Node.Field()` / `Node.ListField()`:
 *
 * ```ts
 * class PostType extends ModelType { static Meta = { model: Post, interfaces: [Node] } }
 * class RelayQuery extends Query { static fields = { node: Node.Field(), nodes: Node.ListField() } }
 * ```
 */
export class Node extends Interface {
  static override Meta = { name: 'Node', description: 'An object with a globally unique ID.' }
  static override fields = { id: NonNull(ID, { description: 'The globally unique ID of the object.' }) }

  /** Root `node(id: ID!): Node` field. Pass a type to restrict (and type) the result: `Node.Field(PostType)`. */
  static Field(only?: TypeRef, opts: { description?: string } = {}): FieldDef {
    return new FieldDef(
      { __ghuriWrapper: 'node', many: false, only },
      {
        description: opts.description ?? 'Fetches an object given its global ID.',
      },
    )
  }

  /** Root `nodes(ids: [ID!]!): [Node]!` field (batched per type). */
  static ListField(only?: TypeRef, opts: { description?: string } = {}): FieldDef {
    return new FieldDef(
      { __ghuriWrapper: 'node', many: true, only },
      {
        description: opts.description ?? 'Fetches objects given their global IDs.',
      },
    )
  }
}
