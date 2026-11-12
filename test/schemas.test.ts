// Several schemas in one process (e.g. a merchant "admin" API and a public "storefront" API): every schema only
// exposes its own types. Relations generated from the models never borrow a ModelType of another schema.
import { describe, expect, it } from 'vitest'
import {
  ConnectionField,
  List,
  ModelMutation,
  ModelType,
  Mutation,
  Node,
  Query,
  Schema,
  toGlobalId,
} from '../src/index'
import { useDatabase } from './helpers'
import { Comment, Member, Post } from './models'

// ---- admin schema: every field, defined (and referenced) first ------------------------------------------------

class AdminMemberType extends ModelType {
  static override Meta = { model: Member, name: 'AdminMemberType', interfaces: [Node] }
}
class AdminPostType extends ModelType {
  static override Meta = { model: Post, name: 'AdminPostType', interfaces: [Node] }
}
class AdminCommentType extends ModelType {
  static override Meta = { model: Comment, name: 'AdminCommentType' }
}
class AdminQuery extends Query {
  static override fields = {
    node: Node.Field(),
    posts: ConnectionField(AdminPostType),
    members: List(AdminMemberType),
    comments: List(AdminCommentType),
  }
}
const admin = new Schema({ query: AdminQuery })

// ---- storefront schema: its own, smaller types ----------------------------------------------------------------

/** The storefront's Post type, not reachable from the storefront's root fields (not in `types` either). */
class PublicPostType extends ModelType {
  static override Meta = {
    model: Post,
    name: 'PublicPostType',
    // author / editor (→ Member) are generated but have no Member type in the storefront
    exclude: ['body', 'published', 'status', 'rating', 'views', 'createdAt', 'tags'],
    interfaces: [Node],
  }
}
class PublicCommentType extends ModelType {
  static override Meta = { model: Comment, name: 'PublicCommentType', exclude: ['approved'] }
}
class StorefrontQuery extends Query {
  static override fields = {
    node: Node.Field(),
    nodes: Node.ListField(),
    comments: List(PublicCommentType),
  }
}
const storefront = new Schema({ query: StorefrontQuery })
/** The same storefront, with its relation-only type listed in `types`. */
const storefrontWithPosts = new Schema({ query: StorefrontQuery, types: [PublicPostType] })

function typeNames(schema: Schema): string[] {
  return Object.keys(schema.graphqlSchema.getTypeMap()).filter((n) => !n.startsWith('__'))
}

describe('several schemas in one process', () => {
  it('does not resolve a generated relation to the ModelType of another schema', () => {
    const sdl = storefront.printSchema()
    // Comment.post / Post.author have no type in the storefront → the relations are skipped
    expect(sdl).not.toMatch(/AdminPostType|AdminMemberType|AdminCommentType/)
    expect(sdl).not.toMatch(/\bpost\b/)
    expect(storefront.getType('AdminPostType')).toBeUndefined()
    expect(storefront.getType('AdminPostTypeConnection')).toBeUndefined()
  })

  it('uses its own ModelType for a relation once it is part of the schema', () => {
    const sdl = storefrontWithPosts.printSchema()
    expect(sdl).toContain('post: PublicPostType!')
    expect(sdl).not.toMatch(/Admin/)
    // PublicPostType.author / editor → Member: no Member type in this schema → skipped, not borrowed
    const post = storefrontWithPosts.getType('PublicPostType') as any
    expect(Object.keys(post.getFields()).sort()).toEqual(['comments', 'id', 'slug', 'title'])
  })

  it('prints only its own types in each schema', () => {
    const adminTypes = typeNames(admin)
    expect(adminTypes).toEqual(
      expect.arrayContaining(['AdminPostType', 'AdminMemberType', 'AdminCommentType']),
    )
    expect(adminTypes.filter((n) => n.startsWith('Public'))).toEqual([])
    expect(typeNames(storefront).filter((n) => n.startsWith('Admin'))).toEqual([])
    expect(typeNames(storefrontWithPosts).filter((n) => n.startsWith('Admin'))).toEqual([])
    // the admin's relations still use the admin's types
    const adminSdl = admin.printSchema()
    expect(adminSdl).toContain('post: AdminPostType!')
    expect(adminSdl).toContain('author: AdminMemberType!')
  })

  it('accepts global IDs only of its own Node types', () => {
    expect([...storefront.builder.nodeTypeNamesFor(Post)]).toEqual([])
    expect([...storefrontWithPosts.builder.nodeTypeNamesFor(Post)]).toEqual(['PublicPostType'])
    expect([...admin.builder.nodeTypeNamesFor(Post)]).toEqual(['AdminPostType'])
  })

  it('raises when a relation listed in Meta.fields has no type in the schema', () => {
    class ListedComment extends ModelType {
      static override Meta = { model: Comment, name: 'ListedComment', fields: ['id', 'text', 'post'] }
    }
    const s = new Schema({
      query: class extends Query {
        static override fields = { comments: List(ListedComment) }
      },
    })
    expect(() => s.validate()).toThrow(
      /ListedComment\.post: no ModelType for blog\.Post is part of this schema/,
    )
    // fine in a schema that has one
    const ok = new Schema({
      query: class extends Query {
        static override fields = { comments: List(ListedComment) }
      },
      types: [PublicPostType],
    })
    expect(ok.printSchema()).toContain('post: PublicPostType!')
  })

  it('does not use the type of another schema for ModelMutation payloads', () => {
    class CreatePost extends ModelMutation {
      static override Meta = { model: Post, operation: 'create' as const, fields: ['title', 'slug'] }
    }
    class M extends Mutation {
      static override fields = { createPost: CreatePost.field() }
    }
    expect(() => new Schema({ query: StorefrontQuery, mutation: M }).validate()).toThrow(
      /CreatePost: no ModelType for blog\.Post; set Meta\.type/,
    )
    const own = new Schema({ query: StorefrontQuery, mutation: M, types: [PublicPostType] })
    expect(own.printSchema()).toMatch(/type CreatePostPayload \{\s*post: PublicPostType/)
  })
})

describe('node / nodes across schemas', () => {
  useDatabase('sqlite')

  async function seed() {
    const ann = await Member.objects.create({ username: 'ann', isStaff: true })
    const post = await Post.objects.create({ title: 'One', slug: 'one', body: 'secret body', author: ann })
    await Comment.objects.create({ post, text: 'nice' })
    return { ann, post }
  }

  it('cannot query admin-only fields through a storefront relation', async () => {
    await seed()
    const r = await storefront.execute('{ comments { text post { title body author { isStaff } } } }')
    expect(r.data).toBeUndefined()
    expect(r.errors?.[0]?.message).toMatch(/Cannot query field "post" on type "PublicCommentType"/)
    const own = await storefrontWithPosts.execute('{ comments { text post { title body } } }')
    expect(own.errors?.[0]?.message).toMatch(/Cannot query field "body" on type "PublicPostType"/)
    const ok = await storefrontWithPosts.execute('{ comments { text post { title } } }')
    expect(ok.errors).toBeUndefined()
    expect(ok.data).toEqual({ comments: [{ text: 'nice', post: { title: 'One' } }] })
  })

  it('does not resolve global IDs of another schema’s types', async () => {
    const { ann, post } = await seed()
    const q = 'query ($id: ID!) { node(id: $id) { __typename id } }'
    for (const [schema, id] of [
      [storefront, toGlobalId('AdminPostType', post.pk)],
      [storefront, toGlobalId('AdminMemberType', ann.pk)],
      [storefrontWithPosts, toGlobalId('AdminPostType', post.pk)],
      [admin, toGlobalId('PublicPostType', post.pk)],
    ] as const) {
      const r = await schema.execute(q, { variables: { id } })
      expect(r.data).toEqual({ node: null })
      expect(r.errors?.[0]?.message).toMatch(/Relay Node "\w+" not found in schema/)
    }
    const many = await storefront.execute('query ($ids: [ID!]!) { nodes(ids: $ids) { id } }', {
      variables: { ids: [toGlobalId('AdminPostType', post.pk)] },
    })
    expect(many.errors?.[0]?.message).toMatch(/Relay Node "AdminPostType" not found in schema/)
    // each schema resolves its own
    const own = await storefrontWithPosts.execute(q, {
      variables: { id: toGlobalId('PublicPostType', post.pk) },
    })
    expect(own.errors).toBeUndefined()
    expect(own.data).toEqual({
      node: { __typename: 'PublicPostType', id: toGlobalId('PublicPostType', post.pk) },
    })
    const adm = await admin.execute(q, { variables: { id: toGlobalId('AdminPostType', post.pk) } })
    expect(adm.data).toEqual({
      node: { __typename: 'AdminPostType', id: toGlobalId('AdminPostType', post.pk) },
    })
  })
})
