// Per-request DataLoaders for relations: one batched `__in` query per relation and nesting level (no N+1).
import type { ModelClass, QuerySet } from '@ghuri/orm'
import type { ResolveInfo } from './types/definitions'
import { hasDefaultQueryset, type ModelTypeClass, typeQueryset } from './types/modeltype'
import { idKey, isModelInstance } from './utils'

type QsTransform = (qs: QuerySet<any>) => QuerySet<any>

function typeKey(cls: ModelTypeClass): string {
  const own = Object.hasOwn(cls, 'Meta') ? cls.Meta : undefined
  return own?.name ?? cls.name
}

/** Load one object of `cls` by primary key (batched per type and request; `getQueryset` applies). */
export function loadNode(cls: ModelTypeClass, id: unknown, info: ResolveInfo): Promise<unknown> {
  const loader = info.context.loaders.get<unknown, unknown, string>(
    `node:${typeKey(cls)}`,
    async (ids) => {
      const qs = typeQueryset(cls, info)
      const pk = qs.model._meta.pk
      const rows = (await qs.filter({ [`${pk.attname}__in`]: ids as unknown[] })) as any[]
      const map = new Map(rows.map((r) => [idKey(r[pk.attname]), r]))
      return ids.map((k) => map.get(idKey(k)) ?? null)
    },
    { cacheKeyFn: idKey },
  )
  return loader.load(id)
}

/** Forward ForeignKey / OneToOneField. Uses `selectRelated` results when present. */
export async function resolveForeignKey(
  parent: any,
  field: any,
  target: ModelTypeClass,
  info: ResolveInfo,
): Promise<unknown> {
  if (!isModelInstance(parent)) return (await parent?.[field.name]) ?? null
  const id = parent[field.attname]
  if (id === null || id === undefined) return null
  const defaultQs = hasDefaultQueryset(target)
  if (defaultQs && parent._state.fieldsCache.has(field.name))
    return parent._state.fieldsCache.get(field.name) ?? null
  const tf = field.targetField
  const loader = info.context.loaders.get<unknown, unknown, string>(
    `fk:${typeKey(target)}:${tf.attname}`,
    async (ids) => {
      const qs = typeQueryset(target, info)
      const rows = (await qs.filter({ [`${tf.attname}__in`]: ids as unknown[] })) as any[]
      const map = new Map(rows.map((r) => [idKey(r[tf.attname]), r]))
      return ids.map((k) => map.get(idKey(k)) ?? null)
    },
    { cacheKeyFn: idKey },
  )
  return loader.load(id)
}

/** Reverse one-to-one (`user.profile`). */
export async function resolveReverseOne(
  parent: any,
  rel: any,
  target: ModelTypeClass,
  info: ResolveInfo,
): Promise<unknown> {
  const accessor = rel.getAccessorName()
  if (!isModelInstance(parent)) return (await parent?.[accessor]) ?? null
  const fk = rel.field
  const value = parent[fk.targetField.attname]
  if (value === null || value === undefined) return null
  const loader = info.context.loaders.get<unknown, unknown, string>(
    `o2o:${typeKey(target)}:${fk.model._meta.label}.${fk.name}`,
    async (values) => {
      const qs = typeQueryset(target, info)
      const rows = (await qs.filter({ [`${fk.attname}__in`]: values as unknown[] })) as any[]
      const map = new Map(rows.map((r) => [idKey(r[fk.attname]), r]))
      return values.map((k) => map.get(idKey(k)) ?? null)
    },
    { cacheKeyFn: idKey },
  )
  return loader.load(value)
}

export interface ManyOptions {
  /** Extra QuerySet transformation (filters / ordering from field arguments). */
  transform?: QsTransform
  /** Distinguishes loaders of the same relation with different arguments. */
  argsKey?: string
}

/** Reverse ForeignKey (`member.posts`). */
export async function resolveReverseMany(
  parent: any,
  rel: any,
  target: ModelTypeClass,
  info: ResolveInfo,
  opts: ManyOptions = {},
): Promise<unknown[]> {
  const accessor: string = rel.getAccessorName()
  if (!isModelInstance(parent)) return toList(await parent?.[accessor])
  if (!opts.transform && hasDefaultQueryset(target) && parent._state.prefetched.has(accessor)) {
    return parent._state.prefetched.get(accessor)
  }
  const fk = rel.field
  const value = parent[fk.targetField.attname]
  if (value === null || value === undefined) return []
  const loader = info.context.loaders.get<unknown, unknown[], string>(
    `rev:${typeKey(target)}:${fk.model._meta.label}.${fk.name}:${opts.argsKey ?? ''}`,
    async (values) => {
      let qs = typeQueryset(target, info)
      if (opts.transform) qs = opts.transform(qs)
      const rows = (await qs.filter({ [`${fk.attname}__in`]: values as unknown[] })) as any[]
      const groups = new Map<string, unknown[]>()
      for (const r of rows) {
        const k = idKey(r[fk.attname])
        let g = groups.get(k)
        if (!g) {
          g = []
          groups.set(k, g)
        }
        g.push(r)
      }
      return values.map((k) => groups.get(idKey(k)) ?? [])
    },
    { cacheKeyFn: idKey },
  )
  return loader.load(value)
}

/** Many-to-many, forward (`post.tags`) or reverse (`tag.posts`). Two queries per batch: links, then targets. */
export async function resolveManyToMany(
  parent: any,
  field: any,
  reverse: boolean,
  target: ModelTypeClass,
  info: ResolveInfo,
  opts: ManyOptions = {},
): Promise<unknown[]> {
  const accessor: string = reverse ? field.remoteField?.getAccessorName() : field.name
  if (!isModelInstance(parent)) return toList(await parent?.[accessor])
  if (!opts.transform && hasDefaultQueryset(target) && parent._state.prefetched.has(accessor)) {
    return parent._state.prefetched.get(accessor)
  }
  const through: ModelClass = field.through
  const [a, b] = field.throughFieldNames() as [string, string]
  const srcFk: any = through._meta.getForwardField(reverse ? b : a)
  const tgtFk: any = through._meta.getForwardField(reverse ? a : b)
  const value = parent[srcFk.targetField.attname]
  if (value === null || value === undefined) return []
  const loader = info.context.loaders.get<unknown, unknown[], string>(
    `m2m:${typeKey(target)}:${field.model._meta.label}.${field.name}:${reverse ? 'r' : 'f'}:${opts.argsKey ?? ''}`,
    async (values) => {
      const links = (await through._baseManager
        .getQueryset()
        .filter({ [`${srcFk.attname}__in`]: values as unknown[] })
        .valuesList(srcFk.attname, tgtFk.attname)) as Array<[unknown, unknown]>
      if (!links.length) return values.map(() => [])
      const parentsByTarget = new Map<string, string[]>()
      for (const [src, tgt] of links) {
        const k = idKey(tgt)
        let g = parentsByTarget.get(k)
        if (!g) {
          g = []
          parentsByTarget.set(k, g)
        }
        g.push(idKey(src))
      }
      let qs = typeQueryset(target, info)
      if (opts.transform) qs = opts.transform(qs)
      const tfAttname = tgtFk.targetField.attname
      const targets = (await qs.filter({
        [`${tfAttname}__in`]: [...new Set(links.map((l) => l[1]))],
      })) as any[]
      const groups = new Map<string, unknown[]>()
      for (const t of targets) {
        for (const p of parentsByTarget.get(idKey(t[tfAttname])) ?? []) {
          let g = groups.get(p)
          if (!g) {
            g = []
            groups.set(p, g)
          }
          g.push(t)
        }
      }
      return values.map((k) => groups.get(idKey(k)) ?? [])
    },
    { cacheKeyFn: idKey },
  )
  return loader.load(value)
}

async function toList(v: unknown): Promise<unknown[]> {
  if (v === null || v === undefined) return []
  if (Array.isArray(v)) return v
  if (typeof (v as any).all === 'function') return (await (v as any).all()) as unknown[]
  if (typeof (v as any)[Symbol.iterator] === 'function') return [...(v as Iterable<unknown>)]
  return [v]
}
