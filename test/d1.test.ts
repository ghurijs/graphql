import { captureQueries } from '@ghuri/orm'
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
import { Member, Post, Tag } from './models'

class MemberNode extends ModelType {
  static override Meta = { model: Member, interfaces: [Node] }
}
class TagType extends ModelType {
  static override Meta = { model: Tag }
}
class PostNode extends ModelType {
  static override Meta = {
    model: Post,
    interfaces: [Node],
    filterFields: { title: ['icontains'] },
    orderBy: ['views'],
  }
}
class CreatePost extends ModelMutation {
  static override Meta = {
    model: Post,
    operation: 'create' as const,
    fields: ['title', 'slug', 'author', 'tags'],
  }
}
const schema = new Schema({
  query: class D1Query extends Query {
    static override fields = { posts: ConnectionField(PostNode), tags: List(TagType), node: Node.Field() }
  },
  mutation: class D1Mutation extends Mutation {
    static override fields = { createPost: CreatePost.field() }
  },
  types: [MemberNode],
})

describe('Cloudflare D1 smoke test', () => {
  useDatabase('d1')

  it('runs queries, connections, loaders and mutations on D1', async () => {
    const ann = await Member.objects.create({ username: 'ann' })
    const js = await Tag.objects.create({ name: 'js' })
    for (let i = 1; i <= 3; i++) {
      const r = await schema.execute(
        `mutation { createPost(input: { title: "D1 ${i}", slug: "d1-${i}", author: "${toGlobalId('MemberNode', ann.id)}", tags: ["${js.id}"] }) { post { title } errors { field messages } } }`,
      )
      expect(r.errors).toBeUndefined()
      expect((r.data as any).createPost.errors).toEqual([])
    }
    const [r, queries] = await captureQueries(() =>
      schema.execute(
        '{ posts(first: 2, filter: { title: { icontains: "d1" } }) { totalCount edges { node { title author { username } tags { name } } } pageInfo { hasNextPage } } }',
      ),
    )
    expect(r.errors).toBeUndefined()
    expect((r.data as any).posts).toEqual({
      totalCount: 3,
      edges: [
        { node: { title: 'D1 1', author: { username: 'ann' }, tags: [{ name: 'js' }] } },
        { node: { title: 'D1 2', author: { username: 'ann' }, tags: [{ name: 'js' }] } },
      ],
      pageInfo: { hasNextPage: true },
    })
    expect(queries.length).toBe(5)
    const node = await schema.execute(
      `{ node(id: "${toGlobalId('MemberNode', ann.id)}") { ... on MemberNode { username } } }`,
    )
    expect(node.data).toEqual({ node: { username: 'ann' } })
  })
})
