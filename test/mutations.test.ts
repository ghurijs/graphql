import { Field as RestField, IsAuthenticated, ModelPermissions, ModelSerializer, ValidationError } from '@ghuri/rest'
import { describe, expect, it } from 'vitest'
import {
  Boolean as GBoolean,
  ClientIDMutation,
  Field,
  ID,
  List,
  loginRequired,
  ModelMutation,
  ModelType,
  Mutation,
  Node,
  NonNull,
  Query,
  type ResolveInfo,
  Schema,
  SerializerMutation,
  String as GString,
  toGlobalId,
} from '../src/index'
import { backends, fakeUser, useDatabase } from './helpers'
import { Member, Post, Tag } from './models'

void RestField

class MemberType extends ModelType {
  static override Meta = { model: Member, interfaces: [Node] }
}
class TagType extends ModelType {
  static override Meta = { model: Tag }
}
class PostType extends ModelType {
  static override Meta = { model: Post, interfaces: [Node], fields: ['id', 'title', 'slug', 'author', 'tags', 'status', 'published'] as const }
}

class PostSerializer extends ModelSerializer {
  static override Meta = {
    model: Post,
    fields: ['id', 'title', 'slug', 'body', 'author', 'tags', 'status', 'published', 'createdAt'],
  }
  validateTitle(value: string) {
    if (value.toLowerCase().includes('spam')) throw new ValidationError('No spam, please.')
    return value
  }
}

class SavePost extends SerializerMutation {
  static override Meta = { serializerClass: PostSerializer, permissionClasses: [IsAuthenticated] }
}
class CreateOnlyPost extends SerializerMutation {
  static override Meta = { serializerClass: PostSerializer, modelOperations: ['create'] as const, name: 'CreateOnlyPost' }
}

class IsAuthor {
  hasPermission() {
    return true
  }
  hasObjectPermission(request: any, _view: unknown, obj: Post) {
    return request.method === 'DELETE' ? true : obj.authorId === request.user.pk
  }
}

class CreatePost extends ModelMutation {
  static override Meta = {
    model: Post,
    operation: 'create' as const,
    fields: ['title', 'slug', 'body', 'author', 'tags', 'status'],
    permissionClasses: [ModelPermissions],
  }
}
class UpdatePost extends ModelMutation {
  static override Meta = { model: Post, operation: 'update' as const, exclude: ['author', 'editor'], permissionClasses: [IsAuthor] }
}
class DeletePost extends ModelMutation {
  static override Meta = { model: Post, operation: 'delete' as const, permissionClasses: [ModelPermissions] }
}
class SerializedUpdate extends ModelMutation {
  static override Meta = { model: Post, operation: 'update' as const, serializerClass: PostSerializer }
}

class Publish extends Mutation {
  static override Arguments = { id: NonNull(ID) }
  static override fields = { post: Field(PostType), ok: GBoolean }
  static mutate = loginRequired(async (_root: unknown, { id }: { id: string }, _info: ResolveInfo) => {
    const post = await Post.objects.get({ id })
    post.published = true
    await post.save()
    return { post, ok: true }
  })
}

class AddTag extends ClientIDMutation {
  static override Input = { name: NonNull(String) }
  static override fields = { tag: Field(TagType), count: List(GString) }
  static override async mutateAndGetPayload(_root: unknown, input: { name: string }) {
    const tag = await Tag.objects.create({ name: input.name })
    return { tag, count: (await Tag.objects.valuesList('name', { flat: true })) as string[] }
  }
}

class BlogMutation extends Mutation {
  static override fields = {
    savePost: SavePost.field(),
    createOnlyPost: CreateOnlyPost.field(),
    createPost: CreatePost.field(),
    updatePost: UpdatePost.field(),
    deletePost: DeletePost.field(),
    serializedUpdate: SerializedUpdate.field(),
    publish: Publish.field({ description: 'Publish a post' }),
    addTag: AddTag.field(),
  }
}
class Q extends Query {
  static override fields = { posts: List(PostType), members: List(MemberType) }
}

const schema = new Schema({ query: Q, mutation: BlogMutation })
const ann = fakeUser({ pk: 1, username: 'ann' })

describe('mutation schema', () => {
  it('generates inputs and payloads', () => {
    const sdl = schema.printSchema()
    if (process.env.PRINT_SDL) console.log(sdl)
    expect(sdl).toMatch(/savePost\(input: SavePostInput!\): SavePostPayload/)
    expect(sdl).toMatch(/input SavePostInput \{[^}]*title: String[^}]*tags: \[ID!\][^}]*id: ID[^}]*clientMutationId: String/)
    expect(sdl).toMatch(/type SavePostPayload \{[^}]*createdAt: DateTime[^}]*errors: \[ErrorType!\][^}]*clientMutationId: String/)
    expect(sdl).toMatch(/input CreateOnlyPostInput \{[^}]*title: String![^}]*slug: String!/)
    expect(sdl).toMatch(/input CreatePostInput \{[^}]*title: String![^}]*body: String\n[^}]*author: ID![^}]*tags: \[ID!\][^}]*status: PostStatus/)
    expect(sdl).toMatch(/input UpdatePostInput \{[^}]*id: ID![^}]*title: String\n[^}]*tags: \[ID!\]/)
    expect(sdl).toMatch(/input DeletePostInput \{\s*"""[^"]*"""\s*id: ID!\s*clientMutationId: String\s*\}/)
    expect(sdl).toMatch(/type DeletePostPayload \{[^}]*ok: Boolean![^}]*deletedId: ID[^}]*errors: \[ErrorType!\]!/)
    expect(sdl).toMatch(/type CreatePostPayload \{\s*post: PostType/)
    expect(sdl).toMatch(/type ErrorType \{[^}]*field: String![^}]*messages: \[String!\]!/)
    expect(sdl).toMatch(/"""Publish a post"""\s*publish\(id: ID!\): PublishPayload/)
  })
})

describe.each(backends)('mutations on %s', (backend) => {
  useDatabase(backend)

  async function seed() {
    const m = await Member.objects.create({ username: 'ann' })
    const other = await Member.objects.create({ username: 'bob' })
    const js = await Tag.objects.create({ name: 'js' })
    return { m, other, js }
  }

  it('SerializerMutation creates through the REST serializer and echoes clientMutationId', async () => {
    const { m, js } = await seed()
    const r = await schema.execute(
      `mutation ($input: SavePostInput!) { savePost(input: $input) { id title tags author status createdAt errors { field messages } clientMutationId } }`,
      { variables: { input: { title: 'Hello', slug: 'hello', author: String(m.id), tags: [String(js.id)], clientMutationId: 'abc' } }, user: ann },
    )
    expect(r.errors).toBeUndefined()
    const p = (r.data as any).savePost
    expect(p).toMatchObject({ title: 'Hello', tags: [String(js.id)], author: String(m.id), status: 'draft', errors: [], clientMutationId: 'abc' })
    expect(p.createdAt).toMatch(/T/)
    const saved = await Post.objects.get({ slug: 'hello' })
    expect(await saved.tags.valuesList('name', { flat: true })).toEqual(['js'])
  })

  it('SerializerMutation returns validation errors in the payload', async () => {
    const { m } = await seed()
    await Post.objects.create({ title: 'Taken', slug: 'taken', author: m })
    const r = await schema.execute(
      `mutation { savePost(input: { title: "Buy spam", slug: "taken", author: "${m.id}", clientMutationId: "x" }) { id errors { field messages } clientMutationId } }`,
      { user: ann },
    )
    expect(r.errors).toBeUndefined()
    const p = (r.data as any).savePost
    expect(p.id).toBeNull()
    expect(p.clientMutationId).toBe('x')
    const errors = Object.fromEntries(p.errors.map((e: any) => [e.field, e.messages]))
    expect(errors.title).toEqual(['No spam, please.'])
    expect(errors.slug[0]).toMatch(/already exists/)
    const missing = await schema.execute('mutation { savePost(input: {}) { errors { field messages } } }', { user: ann })
    const fields = (missing.data as any).savePost.errors.map((e: any) => e.field).sort()
    expect(fields).toEqual(['author', 'slug', 'title'])
  })

  it('SerializerMutation updates (partial) by id, accepting global ids', async () => {
    const { m } = await seed()
    const post = await Post.objects.create({ title: 'Old', slug: 'old', author: m })
    const gid = toGlobalId('PostType', post.id)
    const r = await schema.execute(`mutation { savePost(input: { id: "${gid}", title: "New" }) { id title slug errors { field } } }`, { user: ann })
    expect(r.errors).toBeUndefined()
    expect((r.data as any).savePost).toMatchObject({ id: String(post.id), title: 'New', slug: 'old', errors: [] })
    const missing = await schema.execute('mutation { savePost(input: { id: "999", title: "x" }) { id } }', { user: ann })
    expect(missing.errors?.[0].message).toBe('No post matches the given query.')
    expect(missing.errors?.[0].extensions?.code).toBe('NOT_FOUND')
    const createOnly = await schema.execute(`mutation { createOnlyPost(input: { title: "x", slug: "y", author: "${m.id}" }) { title } }`)
    expect((createOnly.data as any).createOnlyPost.title).toBe('x')
  })

  it('SerializerMutation enforces permission classes', async () => {
    const r = await schema.execute('mutation { savePost(input: { title: "x" }) { id } }')
    expect(r.data).toEqual({ savePost: null })
    expect(r.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED')
  })

  it('ModelMutation creates with fullClean validation, FK global ids and M2M', async () => {
    const { m, js } = await seed()
    const writer = fakeUser({ pk: m.id as number, perms: ['blog.add_post'] })
    const q = `mutation ($input: CreatePostInput!) { createPost(input: $input) { post { title status author { username } tags { name } } errors { field messages } clientMutationId } }`
    const ok = await schema.execute(q, {
      variables: { input: { title: 'Hi', slug: 'hi', author: toGlobalId('MemberType', m.id), tags: [String(js.id)], status: 'LIVE', clientMutationId: '1' } },
      user: writer,
    })
    expect(ok.errors).toBeUndefined()
    expect((ok.data as any).createPost).toEqual({
      post: { title: 'Hi', status: 'LIVE', author: { username: 'ann' }, tags: [{ name: 'js' }] },
      errors: [],
      clientMutationId: '1',
    })
    const dup = await schema.execute(q, { variables: { input: { title: 'Again', slug: 'hi', author: String(m.id) } }, user: writer })
    expect((dup.data as any).createPost.post).toBeNull()
    expect((dup.data as any).createPost.errors[0].field).toBe('slug')
    const denied = await schema.execute(q, { variables: { input: { title: 'x', slug: 'x', author: String(m.id) } }, user: fakeUser() })
    expect(denied.errors?.[0].extensions?.code).toBe('PERMISSION_DENIED')
    expect(await Post.objects.filter({ slug: 'x' }).exists()).toBe(false)
  })

  it('ModelMutation updates with object permissions', async () => {
    const { m, other } = await seed()
    const post = await Post.objects.create({ title: 'Mine', slug: 'mine', author: m })
    const q = `mutation { updatePost(input: { id: "${toGlobalId('PostType', post.id)}", title: "Changed" }) { post { title } errors { field } } }`
    const notAuthor = await schema.execute(q, { user: fakeUser({ pk: other.id as number }) })
    expect(notAuthor.errors?.[0].extensions?.code).toBe('PERMISSION_DENIED')
    const author = await schema.execute(q, { user: fakeUser({ pk: m.id as number }) })
    expect(author.errors).toBeUndefined()
    expect((author.data as any).updatePost).toEqual({ post: { title: 'Changed' }, errors: [] })
    const viaSerializer = await schema.execute(`mutation { serializedUpdate(input: { id: "${post.id}", title: "spam" }) { post { title } errors { field messages } } }`)
    expect((viaSerializer.data as any).serializedUpdate).toEqual({ post: null, errors: [{ field: 'title', messages: ['No spam, please.'] }] })
  })

  it('ModelMutation deletes with ModelPermissions (delete_ permission)', async () => {
    const { m } = await seed()
    const post = await Post.objects.create({ title: 'Bye', slug: 'bye', author: m })
    const gid = toGlobalId('PostType', post.id)
    const q = `mutation { deletePost(input: { id: "${gid}", clientMutationId: "d" }) { ok deletedId errors { field } clientMutationId } }`
    const anon = await schema.execute(q)
    expect(anon.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED')
    const noPerm = await schema.execute(q, { user: fakeUser({ perms: ['blog.add_post'] }) })
    expect(noPerm.errors?.[0].extensions?.code).toBe('PERMISSION_DENIED')
    expect(await Post.objects.filter({ id: post.id }).exists()).toBe(true)
    const ok = await schema.execute(q, { user: fakeUser({ perms: ['blog.delete_post'] }) })
    expect(ok.errors).toBeUndefined()
    expect((ok.data as any).deletePost).toEqual({ ok: true, deletedId: gid, errors: [], clientMutationId: 'd' })
    expect(await Post.objects.filter({ id: post.id }).exists()).toBe(false)
    const again = await schema.execute(q, { user: fakeUser({ perms: ['blog.delete_post'] }) })
    expect(again.errors?.[0].extensions?.code).toBe('NOT_FOUND')
  })

  it('plain Mutation with Arguments / mutate() and loginRequired; ClientIDMutation', async () => {
    const { m } = await seed()
    const post = await Post.objects.create({ title: 'Draft', slug: 'draft', author: m })
    const q = `mutation { publish(id: "${post.id}") { ok post { title published } } }`
    const anon = await schema.execute(q)
    expect(anon.errors?.[0].message).toBe('Authentication credentials were not provided.')
    expect(anon.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED')
    const r = await schema.execute(q, { user: ann })
    expect(r.data).toEqual({ publish: { ok: true, post: { title: 'Draft', published: true } } })
    const t = await schema.execute('mutation { addTag(input: { name: "ts", clientMutationId: "7" }) { tag { name } count clientMutationId } }')
    expect(t.data).toEqual({ addTag: { tag: { name: 'ts' }, count: ['js', 'ts'], clientMutationId: '7' } })
  })
})
