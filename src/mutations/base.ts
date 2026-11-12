// `Mutation` (graphene's `Mutation`) and `ClientIDMutation` (Relay, with `clientMutationId`).
import {
  type GraphQLFieldConfig,
  type GraphQLFieldConfigArgumentMap,
  type GraphQLFieldConfigMap,
  type GraphQLInputFieldConfigMap,
  GraphQLInputObjectType,
  type GraphQLNamedType,
  GraphQLNonNull,
  GraphQLObjectType,
  type GraphQLOutputType,
  GraphQLString,
} from 'graphql'
import { declaredFields, type TypeBuilder, withContext } from '../builder'
import { GraphQLConfigurationError } from '../errors'
import { checkPermissions, type PermissionClassLike } from '../permissions'
import {
  type ArgsInput,
  FieldDef,
  type FieldOptions,
  ObjectType,
  type ObjectTypeMeta,
  type ResolveInfo,
  type TypeRef,
} from '../types/definitions'
import { isPlainObject, lowerFirst } from '../utils'

export interface MutationMeta extends ObjectTypeMeta {
  /** REST permission classes (`hasPermission` with method `POST`) checked before `mutate()`. */
  permissionClasses?: PermissionClassLike[]
  /** Return this type instead of a generated `<Name>Payload`. */
  output?: TypeRef
}

function thunked<T>(v: T | (() => T) | undefined): T | undefined {
  return typeof v === 'function' ? (v as () => T)() : v
}

/** Base name of a mutation class (own `Meta.name` or the class name). */
export function mutationName(cls: Function): string {
  const own = Object.hasOwn(cls, 'Meta') ? (cls as any).Meta : undefined
  return own?.name ?? cls.name
}

/** Build (once per schema) a named type owned by `cls`. */
export function ownedType<T extends GraphQLNamedType>(
  b: TypeBuilder,
  cls: Function,
  name: string,
  make: () => T,
): T {
  const existing = b.named.get(name)
  if (existing && b.classByName.get(name) === cls) return existing as T
  return b.addNamed(make(), cls)
}

/**
 * A mutation field class, and the base of root mutation classes:
 *
 * ```ts
 * class PublishPost extends Mutation {
 *   static Arguments = { id: NonNull(ID) }
 *   static fields = { post: Field(PostType), ok: Boolean }   // payload fields
 *   static async mutate(_root, { id }, info) {
 *     const post = await Post.objects.get({ id })
 *     post.published = true
 *     await post.save()
 *     return { post, ok: true }
 *   }
 * }
 * class BlogMutation extends Mutation { static fields = { publishPost: PublishPost.field() } }  // root fields
 * ```
 * Used with `.field()`, `static fields` are the payload fields (`PublishPostPayload`); listed in
 * `Schema({ mutation: [...] })`, they are root mutation fields.
 */
export class Mutation extends ObjectType {
  static override Meta?: MutationMeta
  /** Arguments of the mutation field. */
  static Arguments?: ArgsInput | (() => ArgsInput)
  /** Return this type instead of the generated payload. */
  static Output?: TypeRef
  /** Perform the mutation; return the payload (a plain object with the payload fields). */
  static mutate?(root: unknown, args: any, info: ResolveInfo): unknown

  /** The root field for this mutation: `createPost: CreatePost.field()`. */
  static field(
    this: typeof Mutation,
    options: Pick<FieldOptions, 'description' | 'deprecationReason'> = {},
  ): FieldDef {
    return new FieldDef({ __ghuriWrapper: 'mutation', mutation: this }, options)
  }

  /** @internal type references reachable from this mutation (schema discovery). */
  static discoverRefs(): TypeRef[] {
    const refs: TypeRef[] = [
      ...Object.values(thunked(this.Arguments) ?? {}),
      ...Object.values(declaredFields(this)),
    ]
    const out = this.Output ?? this.Meta?.output
    if (out) refs.push(out)
    return refs
  }

  /** Name of the generated payload type. */
  static payloadName(): string {
    const own = Object.hasOwn(this, 'Meta') ? this.Meta : undefined
    return own?.name ?? `${this.name}Payload`
  }

  /** @internal extra payload fields added by subclasses (errors, clientMutationId…). */
  static extraPayloadFields(_b: TypeBuilder): GraphQLFieldConfigMap<any, any> {
    return {}
  }

  /** @internal */
  static buildOutputType(b: TypeBuilder): GraphQLOutputType {
    const out = this.Output ?? this.Meta?.output
    if (out) return b.output(out)
    return ownedType(
      b,
      this,
      this.payloadName(),
      () =>
        new GraphQLObjectType({
          name: this.payloadName(),
          description: this.Meta?.description ? `Payload of ${mutationName(this)}.` : undefined,
          fields: () => {
            const fields: GraphQLFieldConfigMap<any, any> = { ...this.extraPayloadFields(b) }
            for (const [n, ref] of Object.entries(declaredFields(this)))
              fields[n] = b.fieldConfig(n, ref, this)
            return fields
          },
          extensions: { ghuri: { cls: this } },
        }),
    )
  }

  /** @internal */
  static buildArgs(b: TypeBuilder): GraphQLFieldConfigArgumentMap {
    return b.argsConfig(thunked(this.Arguments))
  }

  /** @internal the root field config. */
  static buildField(b: TypeBuilder, _name: string, def: FieldDef): GraphQLFieldConfig<any, any> {
    return {
      type: this.buildOutputType(b),
      args: this.buildArgs(b),
      description: def.options.description ?? this.Meta?.description,
      deprecationReason: def.options.deprecationReason,
      resolve: (root, args, ctx, info) => this.resolveMutation(root, args, withContext(info, ctx), b),
    }
  }

  /** Permission checks then `mutate()`. Override to customize the whole flow. */
  static async resolveMutation(
    root: unknown,
    args: any,
    info: ResolveInfo,
    _b: TypeBuilder,
  ): Promise<unknown> {
    await this.checkPermissions(info, 'POST', args)
    if (typeof this.mutate !== 'function') {
      throw new GraphQLConfigurationError(`${this.name} must implement static mutate(root, args, info).`)
    }
    return this.mutate(root, args, info)
  }

  /** `hasPermission` of `Meta.permissionClasses` with the given method. */
  static async checkPermissions(
    info: ResolveInfo,
    method: string,
    data: unknown,
    view: Record<string, unknown> = {},
  ): Promise<void> {
    const perms = this.Meta?.permissionClasses
    if (!perms?.length) return
    await checkPermissions(perms, info.context.request.withMethod(method, data), {
      action: lowerFirst(mutationName(this)),
      info,
      kwargs: (data ?? {}) as Record<string, unknown>,
      mutation: this,
      ...view,
    })
  }
}

/** Add `clientMutationId` to a payload without losing its prototype. */
export function withClientMutationId(payload: unknown, clientMutationId: unknown): unknown {
  if (clientMutationId === undefined) return payload
  if (payload === null || payload === undefined) return { clientMutationId }
  if (isPlainObject(payload)) return { ...payload, clientMutationId }
  return Object.create(payload as object, { clientMutationId: { value: clientMutationId, enumerable: true } })
}

/**
 * Relay mutation: a single `input: <Name>Input!` argument carrying `clientMutationId`, echoed in the payload.
 *
 * ```ts
 * class IntroduceShip extends ClientIDMutation {
 *   static Input = { shipName: NonNull(String), factionId: NonNull(ID) }
 *   static fields = { ship: Field(ShipType) }
 *   static async mutateAndGetPayload(_root, input, info) { return { ship: await createShip(input) } }
 * }
 * ```
 */
export class ClientIDMutation extends Mutation {
  /** Fields of the `<Name>Input` input type. */
  static Input?: ArgsInput | (() => ArgsInput)
  static mutateAndGetPayload?(root: unknown, input: any, info: ResolveInfo): unknown

  static inputName(): string {
    return `${mutationName(this)}Input`
  }

  static override discoverRefs(): TypeRef[] {
    return [...super.discoverRefs(), ...Object.values(thunked(this.Input) ?? {})]
  }

  /** @internal input fields (without `clientMutationId`). */
  static inputFields(b: TypeBuilder): GraphQLInputFieldConfigMap {
    return b.inputFieldsConfig(thunked(this.Input) ?? {})
  }

  static override extraPayloadFields(b: TypeBuilder): GraphQLFieldConfigMap<any, any> {
    return { ...super.extraPayloadFields(b), clientMutationId: { type: GraphQLString } }
  }

  static override buildArgs(b: TypeBuilder): GraphQLFieldConfigArgumentMap {
    const input = ownedType(
      b,
      this,
      this.inputName(),
      () =>
        new GraphQLInputObjectType({
          name: this.inputName(),
          fields: () => ({ ...this.inputFields(b), clientMutationId: { type: GraphQLString } }),
        }),
    )
    return { input: { type: new GraphQLNonNull(input) } }
  }

  static override async resolveMutation(
    root: unknown,
    args: any,
    info: ResolveInfo,
    b: TypeBuilder,
  ): Promise<unknown> {
    const { clientMutationId, ...input } = (args.input ?? {}) as Record<string, unknown>
    const payload = await this.resolveInput(root, input, info, b)
    return withClientMutationId(payload, clientMutationId ?? null)
  }

  /** @internal permission checks then `mutateAndGetPayload()`. */
  static async resolveInput(
    root: unknown,
    input: Record<string, unknown>,
    info: ResolveInfo,
    _b: TypeBuilder,
  ): Promise<unknown> {
    await this.checkPermissions(info, 'POST', input)
    if (typeof this.mutateAndGetPayload !== 'function') {
      throw new GraphQLConfigurationError(
        `${this.name} must implement static mutateAndGetPayload(root, input, info).`,
      )
    }
    return this.mutateAndGetPayload(root, input, info)
  }
}

/** One validation error in a mutation payload. */
export interface ErrorEntry {
  field: string
  messages: string[]
}

/**
 * Flatten REST / model validation errors into `[{ field, messages }]` (nested errors use dotted paths:
 * `tags.0`, `address.city`).
 */
export function errorsToList(errors: unknown, nonFieldKey = '__all__', prefix = ''): ErrorEntry[] {
  if (errors === null || errors === undefined) return []
  if (typeof errors === 'string') return [{ field: prefix || nonFieldKey, messages: [errors] }]
  if (Array.isArray(errors)) {
    if (
      errors.every(
        (e) =>
          typeof e === 'string' ||
          (e && typeof e === 'object' && 'message' in e && !Array.isArray(e)) ||
          typeof (e as any)?.toJSON === 'function',
      )
    ) {
      const messages = errors.map((e) => (typeof e === 'string' ? e : String((e as any).message ?? e)))
      return messages.length ? [{ field: prefix || nonFieldKey, messages }] : []
    }
    return errors.flatMap((e, i) => errorsToList(e, nonFieldKey, prefix ? `${prefix}.${i}` : String(i)))
  }
  if (typeof errors === 'object') {
    return Object.entries(errors as Record<string, unknown>).flatMap(([k, v]) =>
      errorsToList(v, nonFieldKey, prefix ? `${prefix}.${k}` : k),
    )
  }
  return [{ field: prefix || nonFieldKey, messages: [String(errors)] }]
}
