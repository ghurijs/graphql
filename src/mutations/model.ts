// `ModelMutation`: create / update / delete a model (optionally through a REST serializer).
import { Http404, ValidationError } from '@ghuri/core'
import type { ModelClass, QuerySet } from '@ghuri/orm'
import {
  GraphQLBoolean,
  type GraphQLFieldConfigMap,
  GraphQLID,
  type GraphQLInputFieldConfigMap,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql'
import { nonNull, type TypeBuilder } from '../builder'
import { GraphQLConfigurationError } from '../errors'
import { checkObjectPermissions } from '../permissions'
import type { ResolveInfo, TypeRef } from '../types/definitions'
import { typeQueryset } from '../types/modeltype'
import { lowerFirst } from '../utils'
import { ClientIDMutation, errorsToList, type MutationMeta, mutationName } from './base'
import { decodeSerializerInput, type SerializerClassLike, serializerInputFields } from './serializer'

export type ModelMutationOperation = 'create' | 'update' | 'delete'

export interface ModelMutationMeta extends MutationMeta {
  model: ModelClass
  operation: ModelMutationOperation
  /** Field identifying the object for update / delete (default: pk name). Accepts global IDs of Node types. */
  lookupField?: string
  /** Model fields accepted as input (default `'__all__'` editable fields). Ignored with `serializerClass`. */
  fields?: readonly string[] | '__all__'
  exclude?: readonly string[]
  /** Validate and save through this REST serializer instead of `fullClean()` + `save()`. */
  serializerClass?: SerializerClassLike
  /** Payload field holding the object (default: model name, `post`). */
  returnField?: string
  /** Type of the payload object (default: the schema's ModelType for the model). */
  type?: TypeRef
}

const METHOD: Record<ModelMutationOperation, string> = { create: 'POST', update: 'PATCH', delete: 'DELETE' }

/**
 * Model mutations without boilerplate (graphene-django-cud style):
 *
 * ```ts
 * class CreatePost extends ModelMutation { static Meta = { model: Post, operation: 'create', fields: ['title', 'body', 'tags'] } }
 * class UpdatePost extends ModelMutation { static Meta = { model: Post, operation: 'update', permissionClasses: [IsOwner] } }
 * class DeletePost extends ModelMutation { static Meta = { model: Post, operation: 'delete', permissionClasses: [ModelPermissions] } }
 * ```
 * Input: `input: { …fields, clientMutationId }` (update / delete also take `id`). Create and update return
 * `{ post, errors, clientMutationId }`, delete `{ ok, deletedId, errors, clientMutationId }`. Permission classes
 * see `request.method` `POST` / `PATCH` / `DELETE`, so `ModelPermissions` checks `add_` / `change_` /
 * `delete_` permissions; `hasObjectPermission` runs on the looked-up object.
 */
export class ModelMutation extends ClientIDMutation {
  static override Meta?: ModelMutationMeta

  protected static mmeta(): ModelMutationMeta {
    const meta = this.Meta
    if (!meta?.model || !meta.operation) throw new TypeError(`${this.name}.Meta needs model and operation.`)
    return meta
  }

  static lookupField(): string {
    const meta = this.mmeta()
    return meta.lookupField ?? meta.model._meta.pk.name
  }

  static returnField(): string {
    const meta = this.mmeta()
    return meta.returnField ?? lowerFirst(meta.model._meta.objectName)
  }

  static override discoverRefs(): TypeRef[] {
    const t = this.Meta?.type
    return t ? [...super.discoverRefs(), t] : super.discoverRefs()
  }

  /** Editable model fields accepted as input. */
  static inputModelFields(): any[] {
    const meta = this.mmeta()
    const opts = meta.model._meta
    const exclude = new Set(meta.exclude ?? [])
    const candidates = (opts.forwardFields as any[]).filter(
      (f) => f.editable && !f.isAutoField && !(f.primaryKey && f.internalType.includes('Auto')) && !f.hidden,
    )
    let fields = candidates
    if (Array.isArray(meta.fields)) {
      const byName = new Map(candidates.map((f) => [f.name, f]))
      fields = (meta.fields as readonly string[]).map((n) => {
        const f = byName.get(n)
        if (!f)
          throw new GraphQLConfigurationError(
            `${this.name}.Meta.fields: "${n}" is not an editable field of ${opts.objectName}.`,
          )
        return f
      })
    }
    return fields.filter((f) => !exclude.has(f.name) && !['FileField', 'ImageField'].includes(f.internalType))
  }

  static override inputFields(b: TypeBuilder): GraphQLInputFieldConfigMap {
    const meta = this.mmeta()
    const op = meta.operation
    const out: GraphQLInputFieldConfigMap = {}
    if (op === 'update' || op === 'delete') {
      out[this.lookupField()] = { type: new GraphQLNonNull(GraphQLID), description: 'The object to change.' }
    }
    if (op === 'delete') return out
    if (meta.serializerClass) {
      const fields = serializerInputFields(
        b,
        meta.serializerClass,
        meta as any,
        mutationName(this),
        op === 'create',
      )
      for (const [k, v] of Object.entries(fields)) if (!(k in out)) out[k] = v
      return out
    }
    for (const f of this.inputModelFields()) {
      if (f.manyToMany) {
        out[f.name] = {
          type: new GraphQLList(new GraphQLNonNull(GraphQLID)),
          description: f.helpText || undefined,
        }
        continue
      }
      const base = b.fieldInputType(f)
      const required = op === 'create' && !f.blank && !f.null && !f.hasDefault()
      out[f.name] = { type: required ? nonNull(base) : base, description: f.helpText || undefined }
    }
    return out
  }

  static override extraPayloadFields(b: TypeBuilder): GraphQLFieldConfigMap<any, any> {
    const meta = this.mmeta()
    const errors = {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(b.errorType()))),
      description: 'Validation errors (empty on success).',
    }
    if (meta.operation === 'delete') {
      return {
        ok: { type: new GraphQLNonNull(GraphQLBoolean), description: 'True when the object was deleted.' },
        deletedId: { type: GraphQLID, description: 'The id (as sent) of the deleted object.' },
        errors,
        ...super.extraPayloadFields(b),
      }
    }
    const typeRef = meta.type ?? b.typeForModel(meta.model)
    if (!typeRef) {
      throw new GraphQLConfigurationError(
        `${this.name}: no ModelType for ${meta.model._meta.label}; set Meta.type.`,
      )
    }
    return { [this.returnField()]: { type: b.output(typeRef) }, errors, ...super.extraPayloadFields(b) }
  }

  /** QuerySet for update / delete lookups (the model's ModelType `getQueryset` applies). */
  static getQueryset(info: ResolveInfo, b: TypeBuilder): QuerySet<any> {
    const model = this.mmeta().model
    const type = b.typeForModel(model)
    return type ? typeQueryset(type, info) : (model._defaultManager.getQueryset() as QuerySet<any>)
  }

  static async getObject(info: ResolveInfo, b: TypeBuilder, value: unknown): Promise<any> {
    const model = this.mmeta().model
    const qs = this.getQueryset(info, b)
    const obj = await qs.filter({ [this.lookupField()]: b.decodeId(model, value) }).first()
    if (!obj) throw new Http404(`No ${model._meta.verboseName} matches the given query.`)
    return obj
  }

  static override async resolveInput(
    _root: unknown,
    input: Record<string, unknown>,
    info: ResolveInfo,
    b: TypeBuilder,
  ): Promise<unknown> {
    const meta = this.mmeta()
    const op = meta.operation
    const method = METHOD[op]
    const model = meta.model
    const view = { action: op, model, getQueryset: () => model._defaultManager.getQueryset() }
    await this.checkPermissions(info, method, input, view)
    let instance: any
    if (op !== 'create') {
      instance = await this.getObject(info, b, input[this.lookupField()])
      if (meta.permissionClasses?.length) {
        await checkObjectPermissions(
          meta.permissionClasses,
          info.context.request.withMethod(method, input),
          { ...view, info, kwargs: input, mutation: this },
          instance,
        )
      }
    }
    if (op === 'delete') {
      await this.performDelete(instance, info)
      info.context.loaders.clear()
      return { ok: true, deletedId: input[this.lookupField()], errors: [] }
    }
    const data = { ...input }
    if (op === 'update') delete data[this.lookupField()]
    const result = meta.serializerClass
      ? await this.saveWithSerializer(instance, data, info, b, method)
      : await this.saveModel(instance, data, info, b)
    info.context.loaders.clear()
    return result
  }

  static async performDelete(instance: any, _info: ResolveInfo): Promise<void> {
    await instance.delete()
  }

  private static async saveWithSerializer(
    instance: any,
    input: Record<string, unknown>,
    info: ResolveInfo,
    b: TypeBuilder,
    method: string,
  ): Promise<unknown> {
    const meta = this.mmeta()
    const Serializer = meta.serializerClass!
    const data = decodeSerializerInput(b, Serializer, input)
    const context = {
      request: info.context.request.withMethod(method, input),
      view: { action: meta.operation, info, mutation: this },
      info,
      c: info.context.c,
    }
    const serializer = new Serializer(
      instance ? { instance, data, partial: true, context } : { data, context },
    )
    if (!(await serializer.isValid()))
      return { [this.returnField()]: null, errors: errorsToList(serializer.errors, 'nonFieldErrors') }
    const saved = await serializer.save()
    return { [this.returnField()]: saved, errors: [] }
  }

  /** Assign input to the instance, `fullClean()`, save, then set many-to-many relations. */
  static async saveModel(
    instance: any,
    input: Record<string, unknown>,
    _info: ResolveInfo,
    b: TypeBuilder,
  ): Promise<unknown> {
    const meta = this.mmeta()
    const model = meta.model
    const obj = instance ?? new (model as any)()
    const m2m: Array<[any, unknown[]]> = []
    for (const f of this.inputModelFields()) {
      if (!(f.name in input)) continue
      const v = input[f.name]
      if (f.manyToMany) {
        m2m.push([f, ((v as unknown[] | null) ?? []).map((x) => b.decodeId(f.relatedModel, x))])
      } else if (f.isRelation) {
        obj[f.attname] = v === null || v === undefined ? null : b.decodeId(f.relatedModel, v)
      } else obj[f.attname] = v
    }
    try {
      await obj.fullClean()
    } catch (err) {
      if (err instanceof ValidationError)
        return { [this.returnField()]: null, errors: errorsToList(err.toDict('__all__')) }
      throw err
    }
    await obj.save()
    for (const [f, ids] of m2m) await obj[f.name].set(ids)
    return { [this.returnField()]: obj, errors: [] }
  }
}
