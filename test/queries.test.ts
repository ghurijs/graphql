import { captureQueries, type QuerySet } from '@ghuri/orm'
import { describe, expect, it } from 'vitest'
import { Field, ID, List, ModelType, NonNull, optimize, Query, type ResolveInfo, Schema } from '../src/index'
import { backends, fakeUser, useDatabase } from './helpers'
import { Comment, Everything, Member, Post, Profile, Tag } from './models'

class MemberType extends ModelType {
  static override Meta = { model: Member }
}
class ProfileType extends ModelType {
  static override Meta = { model: Profile }
}
class TagType extends ModelType {
  static override Meta = { model: Tag }
}
class CommentType extends ModelType {
  static override Meta = { model: Comment }
  static override getQueryset(qs: QuerySet<Comment>) {
    return qs.filter({ approved: true })
  }
}
class PostType extends ModelType {
  static override Meta = { model: Post }
  static override getQueryset(qs: QuerySet<Post>, info: ResolveInfo) {
    return info.context.user.isStaff ? qs : qs.filter({ published: true })
  }
}
class EverythingType extends ModelType {
  static override Meta = { model: Everything }
}

class BlogQuery extends Query {
  static override fields = {
    posts: List(PostType),
    allPosts: List(PostType, { resolve: () => Post.objects.orderBy('-id') }),
    members: List(MemberType),
    tags: List(TagType),
    post: Field(PostType, { args: { id: NonNull(ID) }, resolve: (_: unknown, { id }) => Post.objects.get({ id }) }),
    optimizedPosts: List(PostType, { resolve: (_: unknown, _a: unknown, info: ResolveInfo) => optimize(Post.objects.all(), info) }),
    everything: List(EverythingType),
  }
}

const schema = new Schema({ query: [BlogQuery], types: [ProfileType, CommentType] })
const staff = fakeUser({ isStaff: true })

async function seed() {
  const ann = await Member.objects.create({ username: 'ann' })
  const bob = await Member.objects.create({ username: 'bob', isStaff: true })
  await Profile.objects.create({ member: ann, bio: 'Hi, Ann here' })
  const js = await Tag.objects.create({ name: 'js' })
  const ts = await Tag.objects.create({ name: 'ts' })
  const p1 = await Post.objects.create({ title: 'One', slug: 'one', author: ann, published: true, body: 'first body' })
  const p2 = await Post.objects.create({ title: 'Two', slug: 'two', author: ann, published: true })
  const p3 = await Post.objects.create({ title: 'Three', slug: 'three', author: bob, published: false })
  await p1.tags.set([js, ts])
  await p2.tags.add(js)
  await Comment.objects.create({ post: p1, text: 'nice' })
  await Comment.objects.create({ post: p1, text: 'spam', approved: false })
  await Comment.objects.create({ post: p3, text: 'hidden post' })
  return { ann, bob, js, ts, p1, p2, p3 }
}

const NESTED = `{
  posts {
    title
    author { username profile { bio } }
    tags { name posts { slug } }
    comments { text }
  }
}`

describe.each(backends)('queries on %s', (backend) => {
  useDatabase(backend)

  it('resolves FK, reverse FK, reverse one-to-one and M2M with batched loaders', async () => {
    await seed()
    const [r, queries] = await captureQueries(() => schema.execute(NESTED, { user: staff }))
    expect(r.errors).toBeUndefined()
    expect(r.data).toEqual({
      posts: [
        {
          title: 'One',
          author: { username: 'ann', profile: { bio: 'Hi, Ann here' } },
          tags: [
            { name: 'js', posts: [{ slug: 'one' }, { slug: 'two' }] },
            { name: 'ts', posts: [{ slug: 'one' }] },
          ],
          comments: [{ text: 'nice' }],
        },
        {
          title: 'Two',
          author: { username: 'ann', profile: { bio: 'Hi, Ann here' } },
          tags: [{ name: 'js', posts: [{ slug: 'one' }, { slug: 'two' }] }],
          comments: [],
        },
        { title: 'Three', author: { username: 'bob', profile: null }, tags: [], comments: [{ text: 'hidden post' }] },
      ],
    })
    // posts, members, profiles, post→tag links + tags, tag→post links + posts, comments
    expect(queries.length).toBe(8)
  })

  it('runs a constant number of queries however many rows there are (no N+1)', async () => {
    const { ann, js } = await seed()
    const [, before] = await captureQueries(() => schema.execute(NESTED, { user: staff }))
    for (let i = 0; i < 15; i++) {
      const m = await Member.objects.create({ username: `m${i}` })
      const p = await Post.objects.create({ title: `P${i}`, slug: `p${i}`, author: i % 2 ? ann : m, published: true })
      await p.tags.add(js)
      await Comment.objects.create({ post: p, text: `c${i}` })
    }
    const [r, after] = await captureQueries(() => schema.execute(NESTED, { user: staff }))
    expect(r.errors).toBeUndefined()
    expect((r.data as any).posts).toHaveLength(18)
    expect(after.length).toBe(before.length)
  })

  it('applies getQueryset to root lists, relations and custom resolvers', async () => {
    await seed()
    const anon = await schema.execute('{ posts { slug } allPosts { slug } members { username posts { slug } } }')
    expect(anon.errors).toBeUndefined()
    expect(anon.data).toEqual({
      posts: [{ slug: 'one' }, { slug: 'two' }],
      allPosts: [{ slug: 'two' }, { slug: 'one' }],
      members: [
        { username: 'ann', posts: [{ slug: 'one' }, { slug: 'two' }] },
        { username: 'bob', posts: [] },
      ],
    })
    const asStaff = await schema.execute('{ allPosts { slug } }', { user: staff })
    expect((asStaff.data as any).allPosts.map((p: any) => p.slug)).toEqual(['three', 'two', 'one'])
  })

  it('resolves single objects with arguments', async () => {
    const { p1 } = await seed()
    const r = await schema.execute('query ($id: ID!) { post(id: $id) { title status views rating createdAt } }', {
      variables: { id: String(p1.id) },
    })
    expect(r.errors).toBeUndefined()
    expect((r.data as any).post).toMatchObject({ title: 'One', status: 'DRAFT', views: 0, rating: null })
    expect((r.data as any).post.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('optimizes root QuerySets with selectRelated / prefetchRelated', async () => {
    await seed()
    const q = '{ optimizedPosts { title author { username } tags { name } comments { text } } }'
    const [plain, plainQueries] = await captureQueries(() => schema.execute(q.replace('optimizedPosts', 'posts'), { user: staff }))
    const [opt, optQueries] = await captureQueries(() => schema.execute(q, { user: staff }))
    expect(opt.errors).toBeUndefined()
    expect((opt.data as any).optimizedPosts).toEqual((plain.data as any).posts.map((p: any) => p))
    // author joined into the posts query; tags prefetched; comments stay on the loader (custom getQueryset)
    expect(optQueries.length).toBeLessThan(plainQueries.length)
    expect(optQueries[0].sql.toLowerCase()).toContain('join')
  })

  it('serializes every scalar type', async () => {
    await Everything.objects.create({
      char: 'abc',
      uuid: '0b6c1f6e-9a4c-4f3e-8a35-1d1f8d1b8c3a',
      integer: 42,
      bigInteger: 9007199254740993,
      float: 1.5,
      decimal: '12.345',
      boolean: true,
      date: '2024-05-01',
      dateTime: new Date('2024-05-01T12:30:00Z'),
      time: '13:45:00',
      duration: 90000,
      json: { a: [1, 2], b: null },
      binary: new Uint8Array([104, 105]),
      file: 'docs/a.pdf' as any,
      level: 2,
    })
    const r = await schema.execute(`{ everything {
      char uuid integer bigInteger float decimal boolean date dateTime time duration json binary file level text
    } }`)
    expect(r.errors).toBeUndefined()
    const row = (r.data as any).everything[0]
    expect(row).toMatchObject({
      char: 'abc',
      uuid: '0b6c1f6e-9a4c-4f3e-8a35-1d1f8d1b8c3a',
      integer: 42,
      float: 1.5,
      boolean: true,
      date: '2024-05-01',
      dateTime: '2024-05-01T12:30:00.000Z',
      time: '13:45:00',
      duration: 90000,
      json: { a: [1, 2], b: null },
      binary: 'aGk=',
      file: 'https://cdn.example.com/docs/a.pdf',
      level: 'A_2',
      text: null,
    })
    expect(Number(row.decimal)).toBe(12.345)
    expect(String(row.bigInteger)).toMatch(/^900719925474099[2-4]$/)
  })
})
