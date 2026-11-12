import { captureQueries, type QuerySet } from '@ghuri/orm'
import { describe, expect, it } from 'vitest'
import {
  Connection,
  type ConnectionResult,
  ConnectionField,
  cursorToOffset,
  Field,
  fromGlobalId,
  Int,
  ModelType,
  Node,
  ObjectType,
  offsetToCursor,
  Query,
  type ResolveInfo,
  Schema,
  String as GString,
  toGlobalId,
} from '../src/index'
import { backends, fakeUser, useDatabase } from './helpers'
import { Comment, Member, Post, Tag } from './models'

class MemberNode extends ModelType {
  static override Meta = {
    model: Member,
    interfaces: [Node],
    filterFields: { username: ['exact', 'istartswith'] },
  }
}
class TagNode extends ModelType {
  static override Meta = { model: Tag, interfaces: [Node], filterFields: ['name'] }
}
class CommentNode extends ModelType {
  static override Meta = { model: Comment, interfaces: [Node] }
}
class PostConnection extends Connection {
  static override fields = {
    publishedCount: Field(Int, {
      resolve: (c: ConnectionResult<Post>) => (c.iterable as QuerySet<Post>).filter({ published: true }).count(),
    }),
  }
}
class PostNode extends ModelType {
  static override Meta = {
    model: Post,
    interfaces: [Node],
    connectionClass: PostConnection,
    filterFields: {
      title: ['exact', 'icontains', 'istartswith'],
      published: ['exact'],
      views: ['gt', 'gte', 'lt', 'range'],
      status: ['exact', 'in'],
      author: ['exact', 'in'],
      author__username: ['exact'],
      tags__name: ['exact'],
      editor: ['isnull'],
      createdAt: ['year'],
    },
    orderBy: ['title', 'views', 'createdAt', 'author__username'],
  }
  static override getQueryset(qs: QuerySet<Post>, info: ResolveInfo) {
    return info.context.user.isStaff ? qs : qs.exclude({ status: 'in-review' })
  }
}

class Ship extends ObjectType {
  static override Meta = { interfaces: [Node] }
  static override fields = { name: GString }
  static getNode(id: string) {
    return id === '1' ? { id: 1, name: 'X-Wing' } : null
  }
}

class RelayQuery extends Query {
  static override fields = {
    node: Node.Field(),
    nodes: Node.ListField(),
    post: Node.Field(PostNode),
    allPosts: ConnectionField(PostNode),
    publishedPosts: ConnectionField(PostNode, {
      resolve: () => Post.objects.filter({ published: true }),
      filterFields: { title: ['icontains'] },
      orderBy: false,
      maxLimit: 2,
    }),
    members: ConnectionField(MemberNode),
    tagList: ConnectionField(TagNode, { resolve: () => [] }),
  }
}

const schema = new Schema({ query: RelayQuery, types: [Ship, CommentNode] })
const staff = fakeUser({ isStaff: true })

async function seed() {
  const ann = await Member.objects.create({ username: 'ann' })
  const bob = await Member.objects.create({ username: 'bob' })
  const js = await Tag.objects.create({ name: 'js' })
  const posts: Post[] = []
  for (let i = 1; i <= 7; i++) {
    const p = await Post.objects.create({
      title: `Post ${i}`,
      slug: `post-${i}`,
      author: i <= 4 ? ann : bob,
      views: i * 10,
      published: i % 2 === 1,
      status: i === 7 ? 'in-review' : 'live',
      editor: i === 1 ? bob : null,
    })
    if (i <= 2) await p.tags.add(js)
    posts.push(p)
  }
  await Comment.objects.create({ post: posts[0], text: 'first!' })
  return { ann, bob, js, posts }
}

async function run(query: string, variables?: Record<string, unknown>, user = staff) {
  const r = await schema.execute(query, { variables, user })
  return r
}

function titles(r: any, field = 'allPosts'): string[] {
  return r.data[field].edges.map((e: any) => e.node.title)
}

describe('global ids and cursors', () => {
  it('round-trips', () => {
    const gid = toGlobalId('PostNode', 42)
    expect(gid).toBe(btoa('PostNode:42'))
    expect(fromGlobalId(gid)).toEqual({ type: 'PostNode', id: '42' })
    expect(fromGlobalId('42')).toBeNull()
    expect(fromGlobalId('not base64!')).toBeNull()
    expect(cursorToOffset(offsetToCursor(5))).toBe(5)
    expect(() => cursorToOffset('garbage')).toThrow(/Invalid cursor/)
  })
})

describe.each(backends)('relay on %s', (backend) => {
  useDatabase(backend)

  it('fetches nodes by global id (batched) and respects getQueryset', async () => {
    const { posts, ann } = await seed()
    const ids = [posts[0], posts[6]].map((p) => toGlobalId('PostNode', p.id))
    const memberId = toGlobalId('MemberNode', ann.id)
    const [r, queries] = await captureQueries(() =>
      run(
        `query ($ids: [ID!]!, $m: ID!) {
          nodes(ids: $ids) { __typename id ... on PostNode { title author { username } } }
          node(id: $m) { __typename ... on MemberNode { username } }
          ship: node(id: "${toGlobalId('Ship', 1)}") { ... on Ship { name id } }
        }`,
        { ids, m: memberId },
      ),
    )
    expect(r.errors).toBeUndefined()
    expect(r.data).toEqual({
      nodes: [
        { __typename: 'PostNode', id: ids[0], title: 'Post 1', author: { username: 'ann' } },
        { __typename: 'PostNode', id: ids[1], title: 'Post 7', author: { username: 'bob' } },
      ],
      node: { __typename: 'MemberNode', username: 'ann' },
      ship: { name: 'X-Wing', id: toGlobalId('Ship', 1) },
    })
    // posts (one batched query) + members (one batched query for node + authors)
    expect(queries.length).toBeLessThanOrEqual(3)
    const anon = await run(`{ node(id: "${ids[1]}") { id } }`, undefined, fakeUser())
    expect(anon.data).toEqual({ node: null })
    const typed = await run(`{ post(id: "${ids[0]}") { title } }`)
    expect(typed.data).toEqual({ post: { title: 'Post 1' } })
    const wrong = await run(`{ post(id: "${memberId}") { title } }`)
    expect(wrong.errors?.[0].message).toBe('Must receive a PostNode id.')
    const bad = await run('{ node(id: "nope") { id } }')
    expect(bad.errors?.[0].message).toContain('Unable to parse global ID')
  })

  it('paginates forward with first / after', async () => {
    await seed()
    const q = `query ($after: String) { allPosts(first: 3, after: $after) {
      totalCount edges { cursor node { title } } pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    } }`
    const page1 = (await run(q)) as any
    expect(page1.errors).toBeUndefined()
    expect(titles(page1)).toEqual(['Post 1', 'Post 2', 'Post 3'])
    expect(page1.data.allPosts.totalCount).toBe(7)
    expect(page1.data.allPosts.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: false })
    const page2 = (await run(q, { after: page1.data.allPosts.pageInfo.endCursor })) as any
    expect(titles(page2)).toEqual(['Post 4', 'Post 5', 'Post 6'])
    const page3 = (await run(q, { after: page2.data.allPosts.pageInfo.endCursor })) as any
    expect(titles(page3)).toEqual(['Post 7'])
    expect(page3.data.allPosts.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true })
  })

  it('paginates backward with last / before', async () => {
    await seed()
    const q = `query ($before: String) { allPosts(last: 2, before: $before) {
      edges { node { title } } pageInfo { hasNextPage hasPreviousPage startCursor }
    } }`
    const last = (await run(q)) as any
    expect(titles(last)).toEqual(['Post 6', 'Post 7'])
    expect(last.data.allPosts.pageInfo).toMatchObject({ hasNextPage: false, hasPreviousPage: true })
    const prev = (await run(q, { before: last.data.allPosts.pageInfo.startCursor })) as any
    expect(titles(prev)).toEqual(['Post 4', 'Post 5'])
    expect(prev.data.allPosts.pageInfo).toMatchObject({ hasNextPage: true, hasPreviousPage: true })
    const between = (await run(`{ allPosts(after: "${offsetToCursor(1)}", before: "${offsetToCursor(5)}") { edges { node { title } } } }`)) as any
    expect(titles(between)).toEqual(['Post 3', 'Post 4', 'Post 5'])
  })

  it('enforces RELAY_CONNECTION_MAX_LIMIT and per-field maxLimit', async () => {
    await seed()
    const tooMany = await run('{ allPosts(first: 101) { totalCount } }')
    expect(tooMany.errors?.[0].message).toContain('exceeds the `first` limit of 100 records')
    expect(tooMany.errors?.[0].extensions?.code).toBe('BAD_USER_INPUT')
    const negative = await run('{ allPosts(last: -1) { totalCount } }')
    expect(negative.errors?.[0].message).toContain('non-negative')
    const capped = (await run('{ publishedPosts { edges { node { title } } pageInfo { hasNextPage } } }')) as any
    expect(titles(capped, 'publishedPosts')).toEqual(['Post 1', 'Post 3'])
    expect(capped.data.publishedPosts.pageInfo.hasNextPage).toBe(true)
    expect((await run('{ publishedPosts(first: 3) { totalCount } }')).errors?.[0].message).toContain('limit of 2')
  })

  it('filters with lookups, relations, global ids and and / or / not', async () => {
    const { ann, bob } = await seed()
    const f = async (filter: string) => titles(await run(`{ allPosts(filter: ${filter}) { edges { node { title } } } }`))
    expect(await f('{ title: { icontains: "post 1" } }')).toEqual(['Post 1'])
    expect(await f('{ published: { exact: true }, views: { gte: 30 } }')).toEqual(['Post 3', 'Post 5', 'Post 7'])
    expect(await f('{ views: { range: [20, 40] } }')).toEqual(['Post 2', 'Post 3', 'Post 4'])
    expect(await f('{ status: { in: [IN_REVIEW] } }')).toEqual(['Post 7'])
    expect(await f(`{ author: { exact: "${toGlobalId('MemberNode', bob.id)}" } }`)).toEqual(['Post 5', 'Post 6', 'Post 7'])
    expect(await f(`{ author: { in: ["${ann.id}"] } }`)).toEqual(['Post 1', 'Post 2', 'Post 3', 'Post 4'])
    expect(await f('{ authorUsername: { exact: "bob" }, views: { lt: 60 } }')).toEqual(['Post 5'])
    expect(await f('{ tagsName: { exact: "js" } }')).toEqual(['Post 1', 'Post 2'])
    expect(await f('{ editor: { isnull: false } }')).toEqual(['Post 1'])
    expect(await f('{ or: [{ views: { lt: 20 } }, { views: { gt: 60 } }] }')).toEqual(['Post 1', 'Post 7'])
    expect(await f('{ not: { authorUsername: { exact: "ann" } }, and: [{ published: { exact: true } }] }')).toEqual([
      'Post 5',
      'Post 7',
    ])
    const year = new Date().getUTCFullYear()
    expect(await f(`{ createdAt: { year: ${year} } }`)).toHaveLength(7)
    const bad = await run('{ allPosts(filter: { views: { range: [1] } }) { totalCount } }')
    expect(bad.errors?.[0].message).toContain('expects exactly two values')
    const unknown = await run('{ allPosts(filter: { body: { exact: "x" } }) { totalCount } }')
    expect(unknown.errors?.[0].message).toContain('unknown field "body"')
  })

  it('orders with orderBy and validates the fields', async () => {
    await seed()
    const desc = await run('{ allPosts(first: 3, orderBy: ["-views"]) { edges { node { title } } } }')
    expect(titles(desc)).toEqual(['Post 7', 'Post 6', 'Post 5'])
    const two = await run('{ allPosts(orderBy: ["-author__username", "title"], first: 4) { edges { node { title } } } }')
    expect(titles(two)).toEqual(['Post 5', 'Post 6', 'Post 7', 'Post 1'])
    const bad = await run('{ allPosts(orderBy: ["body"]) { totalCount } }')
    expect(bad.errors?.[0].message).toContain('Cannot order by "body"')
    expect(schema.printSchema()).not.toMatch(/publishedPosts\([^)]*orderBy/)
  })

  it('supports custom connection classes, array sources and nested connections on Node types', async () => {
    const { ann } = await seed()
    const r = (await run(`{
      allPosts(first: 1) { publishedCount totalCount }
      tagList { totalCount edges { node { name } } }
      members(filter: { username: { exact: "ann" } }) {
        edges { node { username posts(first: 2, orderBy: ["-views"]) { totalCount edges { node { title tags { edges { node { name } } } } } pageInfo { hasNextPage } } } }
      }
    }`)) as any
    expect(r.errors).toBeUndefined()
    expect(r.data.allPosts).toEqual({ publishedCount: 4, totalCount: 7 })
    const anon = (await run('{ allPosts(first: 1) { publishedCount totalCount } }', undefined, fakeUser())) as any
    expect(anon.data.allPosts).toEqual({ publishedCount: 3, totalCount: 6 })
    expect(r.data.tagList).toEqual({ totalCount: 0, edges: [] })
    const member = r.data.members.edges[0].node
    expect(member.username).toBe(ann.username)
    expect(member.posts.totalCount).toBe(4)
    expect(member.posts.edges.map((e: any) => e.node.title)).toEqual(['Post 4', 'Post 3'])
    expect(member.posts.pageInfo.hasNextPage).toBe(true)
  })

  it('batches nested connections (no N+1)', async () => {
    await seed()
    const q = '{ members { edges { node { username posts { totalCount edges { node { title comments { totalCount } } } } } } } }'
    const [r, queries] = await captureQueries(() => run(q))
    expect(r.errors).toBeUndefined()
    // members count is not needed (no last / totalCount); members, posts, comments
    expect(queries.length).toBe(3)
  })
})
