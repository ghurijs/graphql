// `SerializerMutation`: create / update through a @ghuri/rest serializer (graphene-django's). REST is used
// structurally (the serializer class is passed in), so this module never imports @ghuri/rest.
import { Http404 } from '@ghuri/core'
import type { ModelClass, QuerySet } from '@ghuri/orm'
import {
  GraphQLBoolean,
  GraphQLEnumType,
  type GraphQLEnumValueConfigMap,
  GraphQLError,
  type GraphQLFieldConfigMap,
  GraphQLFloat,
  GraphQLID,
  type GraphQLInputFieldConfigMap,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  type GraphQLScalarType,
  GraphQLString,
} from 'graphql'
import { enumValueName, type TypeBuilder } from '../builder'
import { checkObjectPermissions } from '../permissions'
import { DateScalar, DateTime, Decimal, JSONScalar, Time, UUID } from '../scalars'
import type { ResolveInfo, TypeRef } from '../types/definitions'
import { typeQueryset } from '../types/modeltype'
import { capitalize } from '../utils'
import { ClientIDMutation, errorsToList, type MutationMeta, mutationName } from './base'

/** A REST serializer class (`ModelSerializer` subclass or any `Serializer`). */
export type SerializerClassLike = (new (opts?: any) => any) & { Meta?: { model?: any; [k: string]: unknown } }

export type ModelOperation = 'create' | 'update'

export interface SerializerMutationMeta extends MutationMeta {
  serializerClass: SerializerClassLike
  /** Allowed operations (default both): input with `lookupField` → update, without → create. */
  modelOperations?: readonly ModelOperation[]
  /** Field identifying the instance to update (default: the model's pk name). */
  lookupField?: string
  /** Turn `ChoiceField`s into GraphQL enums (default false: their values are strings). */
  convertChoicesToEnum?: boolean
  /** Only these serializer fields (input and payload). */
  fields?: readonly string[]
  /** Hide these serializer fields. */
  exclude?: readonly string[]
}

export interface SerializerKwargs {
  instance?: unknown
  data: Record<string, unknown>
  partial?: boolean
  context: Record<string, unknown>
}

function isRelatedField(f: any): boolean {
  return (
    !!f &&
    typeof f === 'object' &&
    ('queryset' in f || typeof f.getQueryset === 'function') &&
    !f.childRelation
  )
}

function isNestedSerializer(f: any): boolean {
  return !!f && typeof f.isValid === 'function' && typeof f.getData === 'function'
}

function relatedModelOf(f: any): ModelClass | undefined {
  try {
    return (f.queryset ?? f.getQueryset?.())?.model
  } catch {
    return undefined
  }
}

const FORMAT_SCALARS: Record<string, GraphQLScalarType> = {
  'date-time': DateTime,
  date: DateScalar,
  time: Time,
  uuid: UUID,
  decimal: Decimal,
}

/** GraphQL type (nullable) of a REST serializer field, derived from its JSON Schema. */
export function serializerFieldType(
  b: TypeBuilder,
  field: any,
  opts: { enumName?: string; convertChoices?: boolean },
): any {
  if (field.childRelation) {
    return new GraphQLList(new GraphQLNonNull(isSlugField(field.childRelation) ? GraphQLString : GraphQLID))
  }
  if (isRelatedField(field)) return isSlugField(field) || field.readOnly ? GraphQLString : GraphQLID
  if (isNestedSerializer(field)) return JSONScalar
  let schema: Record<string, any> = {}
  try {
    schema = field.jsonSchema?.() ?? {}
  } catch {}
  return schemaType(b, schema, field, opts)
}

function isSlugField(f: any): boolean {
  return typeof f?.slugField === 'string'
}

function schemaType(
  b: TypeBuilder,
  schema: Record<string, any>,
  field: any,
  opts: { enumName?: string; convertChoices?: boolean },
): any {
  const type = Array.isArray(schema.type) ? schema.type.find((t: string) => t !== 'null') : schema.type
  if (Array.isArray(schema.enum) && opts.convertChoices && opts.enumName) {
    const name = opts.enumName
    const existing = b.named.get(name)
    if (existing instanceof GraphQLEnumType) return existing
    const values: GraphQLEnumValueConfigMap = {}
    const labels: string[] = schema['x-enum-descriptions'] ?? []
    schema.enum.forEach((v: unknown, i: number) => {
      if (v === '' || v === null) return
      let n = enumValueName(v)
      while (values[n]) n = `${n}_`
      values[n] = { value: v, description: labels[i] }
    })
    return b.addNamed(new GraphQLEnumType({ name, values }))
  }
  if (type === 'array') {
    const child = field?.child
    const item = child ? serializerFieldType(b, child, {}) : schemaType(b, schema.items ?? {}, undefined, {})
    return new GraphQLList(new GraphQLNonNull(item))
  }
  if (typeof schema.format === 'string' && FORMAT_SCALARS[schema.format]) return FORMAT_SCALARS[schema.format]
  if (type === 'string') return GraphQLString
  if (type === 'integer') return GraphQLInt
  if (type === 'number') return GraphQLFloat
  if (type === 'boolean') return GraphQLBoolean
  return JSONScalar
}

/** Serializer fields as `[name, field]`, honoring Meta.fields / Meta.exclude of the mutation. */
export function serializerFields(
  cls: SerializerClassLike,
  meta: { fields?: readonly string[]; exclude?: readonly string[] },
): Array<[string, any]> {
  const serializer = new cls()
  const fields = Object.entries((serializer.fields ?? {}) as Record<string, any>)
  const only = meta.fields ? new Set(meta.fields) : null
  const exclude = new Set(meta.exclude ?? [])
  return fields.filter(([n]) => (!only || only.has(n)) && !exclude.has(n))
}

/** Input fields of a serializer (writable, non-hidden). */
export function serializerInputFields(
  b: TypeBuilder,
  cls: SerializerClassLike,
  meta: { fields?: readonly string[]; exclude?: readonly string[]; convertChoicesToEnum?: boolean },
  baseName: string,
  requiredAllowed: boolean,
): GraphQLInputFieldConfigMap {
  const out: GraphQLInputFieldConfigMap = {}
  for (const [name, f] of serializerFields(cls, meta)) {
    if (f.readOnly) continue
    if (isHidden(f)) continue
    const t = serializerFieldType(b, f, {
      enumName: `${baseName}${capitalize(name)}`,
      convertChoices: meta.convertChoicesToEnum,
    })
    const required = requiredAllowed && f.required && !f.allowNull
    out[name] = { type: required ? new GraphQLNonNull(t) : t, description: f.helpText || undefined }
  }
  return out
}

/** `HiddenField`s (value from `default`, never from input). */
function isHidden(f: any): boolean {
  for (let c = f?.constructor; c && c !== Object; c = Object.getPrototypeOf(c)) {
    if (c.name === 'HiddenField') return true
  }
  return false
}

/** Decode global IDs in relation fields of serializer input. */
export function decodeSerializerInput(
  b: TypeBuilder,
  cls: SerializerClassLike,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...data }
  let fields: Record<string, any>
  try {
    fields = new cls().fields ?? {}
  } catch {
    return out
  }
  for (const [name, f] of Object.entries(fields)) {
    if (!(name in out)) continue
    if (f.childRelation && Array.isArray(out[name])) {
      const model = relatedModelOf(f.childRelation)
      out[name] = (out[name] as unknown[]).map((v) => b.decodeId(model, v))
    } else if (isRelatedField(f)) {
      out[name] = b.decodeId(relatedModelOf(f), out[name])
    }
  }
  return out
}

/** Non-field errors key of a serializer's errors (REST default `nonFieldErrors`). */
const NON_FIELD = 'nonFieldErrors'

/**
 * Create / update mutations powered by a REST serializer — validation, `create()` / `update()`, field
 * validators, `CurrentUserDefault` and permission classes all come from REST:
 *
 * ```ts
 * class CreatePost extends SerializerMutation {
 *   static Meta = { serializerClass: PostSerializer, permissionClasses: [IsAuthenticated] }
 * }
 * // mutation { createPost(input: { title: "Hi", clientMutationId: "1" }) { id title errors { field messages } } }
 * ```
 * The payload exposes the serializer's readable fields, `errors: [ErrorType!]` (validation errors, like
 * graphene-django) and `clientMutationId`. An input containing `lookupField` (default `id`) updates
 * (`partial: true`), otherwise creates.
 */
export class SerializerMutation extends ClientIDMutation {
  static override Meta?: SerializerMutationMeta

  protected static smeta(): SerializerMutationMeta {
    const meta = this.Meta
    if (!meta?.serializerClass) throw new TypeError(`${this.name}.Meta.serializerClass is required.`)
    return meta
  }

  static model(): ModelClass | undefined {
    return this.smeta().serializerClass.Meta?.model
  }

  static operations(): readonly ModelOperation[] {
    return this.smeta().modelOperations ?? ['create', 'update']
  }

  static lookupField(): string {
    return this.smeta().lookupField ?? this.model()?._meta.pk.name ?? 'id'
  }

  static override discoverRefs(): TypeRef[] {
    return [...super.discoverRefs()]
  }

  static override inputFields(b: TypeBuilder): GraphQLInputFieldConfigMap {
    const meta = this.smeta()
    const ops = this.operations()
    const out = serializerInputFields(
      b,
      meta.serializerClass,
      meta,
      mutationName(this),
      !ops.includes('update'),
    )
    if (ops.includes('update')) {
      const lookup = this.lookupField()
      if (!out[lookup])
        out[lookup] = { type: GraphQLID, description: 'Set to update this object; omit to create one.' }
    }
    return out
  }

  static override extraPayloadFields(b: TypeBuilder): GraphQLFieldConfigMap<any, any> {
    const meta = this.smeta()
    const out: GraphQLFieldConfigMap<any, any> = {}
    for (const [name, f] of serializerFields(meta.serializerClass, meta)) {
      if (f.writeOnly) continue
      out[name] = {
        type: serializerFieldType(b, f, {
          enumName: `${mutationName(this)}${capitalize(name)}`,
          convertChoices: meta.convertChoicesToEnum,
        }),
        description: f.helpText || undefined,
      }
    }
    return {
      ...out,
      ...super.extraPayloadFields(b),
      errors: {
        type: new GraphQLList(new GraphQLNonNull(b.errorType())),
        description: 'Validation errors (empty on success).',
      },
    }
  }

  /** QuerySet used to find the instance to update (the model's ModelType `getQueryset` applies). */
  static getQueryset(info: ResolveInfo, b: TypeBuilder): QuerySet<any> {
    const model = this.model()
    if (!model) throw new TypeError(`${this.name}: updates need a ModelSerializer (Meta.model).`)
    const type = b.typeForModel(model)
    return type ? typeQueryset(type, info) : (model._defaultManager.getQueryset() as QuerySet<any>)
  }

  /** Look up the object to update; raises NOT_FOUND. */
  static async getObject(info: ResolveInfo, b: TypeBuilder, lookupValue: unknown): Promise<unknown> {
    const model = this.model()
    const qs = this.getQueryset(info, b)
    const obj = await qs.filter({ [this.lookupField()]: b.decodeId(model, lookupValue) }).first()
    if (!obj) throw new Http404(`No ${model?._meta.verboseName ?? 'object'} matches the given query.`)
    return obj
  }

  /** Arguments of the serializer (graphene-django's `get_serializer_kwargs`). */
  static async getSerializerKwargs(
    _root: unknown,
    info: ResolveInfo,
    input: Record<string, unknown>,
    b: TypeBuilder,
  ): Promise<SerializerKwargs> {
    const lookup = this.lookupField()
    const value = input[lookup]
    const isUpdate = value !== undefined && value !== null && this.operations().includes('update')
    const method = isUpdate ? 'PATCH' : 'POST'
    const request = info.context.request.withMethod(method, input)
    const data = decodeSerializerInput(b, this.smeta().serializerClass, input)
    if (isUpdate) delete data[lookup]
    const context = {
      request,
      view: { action: isUpdate ? 'update' : 'create', info, mutation: this },
      info,
      c: info.context.c,
    }
    if (!isUpdate) return { data, context }
    return { instance: await this.getObject(info, b, value), data, partial: true, context }
  }

  /** Save a valid serializer and build the payload (graphene-django's `perform_mutate`). */
  static async performMutate(serializer: any, _info: ResolveInfo): Promise<Record<string, unknown>> {
    await serializer.save()
    const data = await serializer.getData()
    return { ...data, errors: [] }
  }

  static override async resolveInput(
    root: unknown,
    input: Record<string, unknown>,
    info: ResolveInfo,
    b: TypeBuilder,
  ): Promise<unknown> {
    const lookup = this.lookupField()
    const ops = this.operations()
    const isUpdate = input[lookup] !== undefined && input[lookup] !== null && ops.includes('update')
    if (!isUpdate && !ops.includes('create')) {
      throw new GraphQLError(`Invalid update operation. Input parameter "${lookup}" required.`, {
        extensions: { code: 'BAD_USER_INPUT' },
      })
    }
    const method = isUpdate ? 'PATCH' : 'POST'
    const model = this.model()
    const view = model
      ? {
          action: isUpdate ? 'update' : 'create',
          model,
          getQueryset: () => model._defaultManager.getQueryset(),
        }
      : { action: isUpdate ? 'update' : 'create' }
    await this.checkPermissions(info, method, input, view)
    const kwargs = await this.getSerializerKwargs(root, info, input, b)
    if (kwargs.instance && this.Meta?.permissionClasses?.length) {
      await checkObjectPermissions(
        this.Meta.permissionClasses,
        info.context.request.withMethod(method, input),
        { ...view, info, kwargs: input, mutation: this },
        kwargs.instance,
      )
    }
    const serializer = new (this.smeta().serializerClass)(kwargs)
    if (!(await serializer.isValid())) {
      return { errors: errorsToList(serializer.errors, NON_FIELD) }
    }
    const payload = await this.performMutate(serializer, info)
    info.context.loaders.clear()
    return payload
  }
}
