import { CASCADE, CharField, DecimalField, ForeignKey, Model } from '@ghuri/orm'
import { GraphQLInt, GraphQLString } from 'graphql'
import { describe, expect, it } from 'vitest'
import {
  Argument,
  BigIntScalar,
  ConnectionField,
  Enum,
  Field,
  Boolean as GBoolean,
  GraphQLConfigurationError,
  String as GString,
  ID,
  InputObjectType,
  Int,
  Interface,
  List,
  ModelType,
  Node,
  NonNull,
  ObjectType,
  Query,
  registerFieldConverter,
  Schema,
  Union,
} from '../src/index'
import { Comment, Everything, Member, Post, Profile, Tag } from './models'

class LabelField extends CharField<{ maxLength: 10 }> {
  static override readonly internalType: string = 'LabelField'
  constructor() {
    super({ maxLength: 10 })
  }
}

class MemberType extends ModelType {
  static override Meta = { model: Member, fields: ['id', 'username', 'isStaff', 'posts', 'profile'] }
}
class TagType extends ModelType {
  static override Meta = { model: Tag }
}
class ProfileType extends ModelType {
  static override Meta = { model: Profile }
}
class CommentType extends ModelType {
  static override Meta = { model: Comment, exclude: ['approved'] }
}
class PostType extends ModelType {
  static override Meta = { model: Post, exclude: ['editor'] }
  static override fields = {
    excerpt: Field(String, { resolve: (post: Post) => post.body.slice(0, 10) }),
    shout: GString,
  }
  static resolveShout(post: Post) {
    return post.title.toUpperCase()
  }
}
class EverythingType extends ModelType {
  static override Meta = { model: Everything }
}

class TypesQuery extends Query {
  static override fields = {
    posts: List(PostType),
    everything: List(EverythingType),
    member: Field(MemberType, {
      args: { id: NonNull(ID) },
      resolve: (_: unknown, { id }) => Member.objects.get({ id }),
    }),
    tags: List(TagType),
    comments: List(CommentType),
    profiles: List(ProfileType),
  }
}

function typeBlock(sdl: string, name: string): string {
  const m = new RegExp(`(type|input|enum|interface|union) ${name}\\b[^{=]*(\\{[^}]*\\}|=[^\\n]*)`).exec(sdl)
  if (!m) throw new Error(`type ${name} not in SDL:\n${sdl}`)
  return m[0]
}

describe('ModelType generation', () => {
  const schema = new Schema({ query: [TypesQuery] })
  const sdl = schema.printSchema()

  it('maps every ORM field type to a scalar', () => {
    const t = typeBlock(sdl, 'EverythingType')
    for (const line of [
      'id: ID!',
      'char: String!',
      'text: String',
      'slug: String',
      'email: String',
      'url: String',
      'uuid: UUID',
      'ip: String',
      'integer: Int',
      'bigInteger: BigInt',
      'smallInteger: Int',
      'positiveInteger: Int',
      'positiveSmallInteger: Int',
      'float: Float',
      'decimal: Decimal',
      'boolean: Boolean!',
      'date: Date',
      'dateTime: DateTime',
      'time: Time',
      'duration: Float',
      'json: JSON',
      'binary: Base64',
      'file: String',
      'level: EverythingLevel!',
    ]) {
      expect(t).toContain(line)
    }
    for (const scalar of ['UUID', 'BigInt', 'Decimal', 'Date', 'DateTime', 'Time', 'JSON', 'Base64']) {
      expect(sdl).toContain(`scalar ${scalar}`)
    }
  })

  it('turns choices into enums named after the model field', () => {
    expect(typeBlock(sdl, 'PostStatus')).toMatch(/DRAFT[\s\S]*IN_REVIEW[\s\S]*LIVE/)
    expect(typeBlock(sdl, 'EverythingLevel')).toMatch(/A_1[\s\S]*A_2/)
    expect(sdl).toContain('"""In review"""')
    expect(typeBlock(sdl, 'PostType')).toContain('status: PostStatus!')
  })

  it('maps relations: FK → object, reverse FK / M2M → lists, reverse one-to-one → nullable object', () => {
    const post = typeBlock(sdl, 'PostType')
    expect(post).toContain('author: MemberType!')
    expect(post).toContain('tags: [TagType!]!')
    expect(post).toContain('comments: [CommentType!]!')
    expect(post).not.toContain('editor')
    expect(post).toContain('excerpt: String')
    expect(post).toContain('shout: String')
    expect(post).toMatch(/"""Headline"""\s*title: String!/)
    const member = typeBlock(sdl, 'MemberType')
    expect(member).toContain('posts: [PostType!]!')
    expect(member).toContain('profile: ProfileType')
    expect(member).not.toContain('edited')
    expect(typeBlock(sdl, 'TagType')).toContain('posts: [PostType!]!')
    expect(typeBlock(sdl, 'ProfileType')).toContain('member: MemberType!')
    expect(typeBlock(sdl, 'CommentType')).not.toContain('approved')
  })

  it('finds related types through the registry, and skips relations to models without a type', () => {
    class Lonely extends ModelType {
      static override Meta = { model: Comment, name: 'Lonely' }
    }
    // PostType is not referenced by this schema, but it is registered (List(PostType) above) → used
    const s = new Schema({
      query: class extends Query {
        static override fields = { c: List(Lonely) }
      },
    })
    expect(typeBlock(s.printSchema(), 'Lonely')).toContain('post: PostType!')

    class Owner extends Model({ name: new CharField({ maxLength: 10 }) }) {
      static Meta = { appLabel: 'blog' }
    }
    class Pet extends Model({
      owner: new ForeignKey(() => Owner, { onDelete: CASCADE }),
      name: new CharField({ maxLength: 10 }),
    }) {
      static Meta = { appLabel: 'blog' }
    }
    class PetType extends ModelType {
      static override Meta = { model: Pet }
    }
    const s2 = new Schema({
      query: class extends Query {
        static override fields = { pets: List(PetType) }
      },
    })
    expect(typeBlock(s2.printSchema(), 'PetType')).not.toContain('owner')
  })

  it('raises for explicitly listed relations without a type and for unknown fields', () => {
    class Bad extends ModelType {
      static override Meta = { model: Comment, name: 'Bad', fields: ['id', 'nope'] }
    }
    expect(
      () =>
        new Schema({
          query: class extends Query {
            static override fields = { b: List(Bad) }
          },
        }),
    ).toThrow(/"nope" is not a field/)
  })

  it('rejects two types with the same name', () => {
    class A extends ObjectType {
      static override Meta = { name: 'Same' }
      static override fields = { a: GString }
    }
    class B extends ObjectType {
      static override Meta = { name: 'Same' }
      static override fields = { b: GString }
    }
    class Q extends Query {
      static override fields = { a: Field(A), b: Field(B) }
    }
    expect(() => new Schema({ query: Q })).toThrow(GraphQLConfigurationError)
  })

  it('supports custom field converters', () => {
    class MoneyField extends DecimalField<{ maxDigits: 8; decimalPlaces: 2 }> {
      static override readonly internalType: string = 'MoneyField'
    }
    class Wallet extends Model({
      balance: new MoneyField({ maxDigits: 8, decimalPlaces: 2 }),
      label: new LabelField(),
    }) {
      static Meta = { appLabel: 'blog' }
    }
    class LabelFieldType extends ModelType {
      static override Meta = { model: Wallet, name: 'WalletType' }
    }
    registerFieldConverter('MoneyField', () => GraphQLString)
    registerFieldConverter('LabelField', () => GraphQLInt)
    const s = new Schema({
      query: class extends Query {
        static override fields = { w: List(LabelFieldType) }
      },
    })
    const t = typeBlock(s.printSchema(), 'WalletType')
    expect(t).toContain('balance: String!')
    expect(t).toContain('label: Int!')
  })
})

describe('object types, interfaces, unions, enums and inputs', () => {
  class Named extends Interface {
    static override fields = { name: NonNull(String) }
  }
  class Dog extends ObjectType {
    static override Meta = { interfaces: [Named] }
    static override fields = { barks: GBoolean }
  }
  class Cat extends ObjectType {
    static override Meta = { interfaces: [Named] }
    static override fields = { lives: Int }
  }
  class Pet extends Union {
    static override Meta = { types: [Dog, Cat] }
    static override resolveType(value: any) {
      return value.lives === undefined ? Dog : 'Cat'
    }
  }
  class Episode extends Enum {
    static override values = { NEWHOPE: 4, EMPIRE: { value: 5, description: 'Best one' }, JEDI: 6 }
  }
  const Color = Enum.from('Color', { RED: 'r', GREEN: 'g' })
  class Filter extends InputObjectType {
    static override fields = { episode: Episode, limit: Argument(Int, { defaultValue: 2 }) }
  }
  class Person extends ObjectType {
    static override fields = () => ({
      firstName: String,
      lastName: String,
      fullName: String,
      best: Field(() => Person),
    })
    static resolveFullName(p: { firstName: string; lastName: string }) {
      return `${p.firstName} ${p.lastName}`
    }
  }

  class Q extends Query {
    static override fields = {
      pets: List(Pet, {
        resolve: () => [
          { name: 'Rex', barks: true },
          { name: 'Tom', lives: 9 },
        ],
      }),
      named: List(Named, {
        resolve: () => [
          Object.assign(new Dog(), { name: 'Rex', barks: true }),
          { __typename: 'Cat', name: 'Kit', lives: 7 },
        ],
      }),
      hero: Field(Episode, {
        args: { filter: Filter },
        resolve: (_: unknown, { filter }: any) => filter?.episode ?? 4,
      }),
      limit: Field(Int, {
        args: { filter: NonNull(Filter) },
        resolve: (_: unknown, { filter }: any) => filter.limit,
      }),
      color: Field(Color, { resolve: () => 'g' }),
      me: Field(Person, {
        resolve: () => ({ firstName: 'Ann', lastName: 'Lee', best: { firstName: 'Bo', lastName: 'Ng' } }),
      }),
      big: Field(BigIntScalar, { resolve: () => 2n ** 60n }),
      echo: Field(String, {
        args: { text: NonNull(String) },
        resolve: (_: unknown, { text }) => text.toUpperCase(),
      }),
      when: Field(Date, { resolve: () => new Date('2024-05-01T12:00:00Z') }),
    }
  }
  const schema = new Schema({ query: Q })

  it('builds the SDL', () => {
    const sdl = schema.printSchema()
    expect(sdl).toContain('union Pet = Dog | Cat')
    expect(sdl).toContain('type Dog implements Named')
    expect(sdl).toMatch(/enum Episode \{\s*NEWHOPE\s*"""Best one"""\s*EMPIRE\s*JEDI\s*\}/)
    expect(sdl).toMatch(/input Filter \{\s*episode: Episode\s*limit: Int = 2\s*\}/)
    expect(sdl).toContain('when: DateTime')
  })

  it('executes resolvers, resolveX methods, unions and interfaces', async () => {
    const r = await schema.execute(`{
      pets { __typename ... on Dog { name barks } ... on Cat { name lives } }
      named { __typename name }
      hero(filter: { episode: EMPIRE }) default: hero
      limit(filter: {})
      color
      me { fullName best { fullName } }
      big
      echo(text: "hi")
      when
    }`)
    expect(r.errors).toBeUndefined()
    expect(r.data).toEqual({
      pets: [
        { __typename: 'Dog', name: 'Rex', barks: true },
        { __typename: 'Cat', name: 'Tom', lives: 9 },
      ],
      named: [
        { __typename: 'Dog', name: 'Rex' },
        { __typename: 'Cat', name: 'Kit' },
      ],
      hero: 'EMPIRE',
      default: 'NEWHOPE',
      limit: 2,
      color: 'GREEN',
      me: { fullName: 'Ann Lee', best: { fullName: 'Bo Ng' } },
      big: '1152921504606846976',
      echo: 'HI',
      when: '2024-05-01T12:00:00.000Z',
    })
  })

  it('merges query classes of several apps and rejects clashes', () => {
    class A extends Query {
      static override fields = { a: Field(String, { resolve: () => 'a' }) }
    }
    class B extends Query {
      static override fields = { b: Field(String, { resolve: () => 'b' }) }
    }
    const s = new Schema({ query: [A, B] })
    expect(Object.keys(s.graphqlSchema.getQueryType()!.getFields())).toEqual(['a', 'b'])
    class C extends Query {
      static override fields = { a: String }
    }
    expect(() => new Schema({ query: [A, C] })).toThrow(/defined by both A and C/)
  })

  it('exposes Node + connections in SDL', () => {
    class N extends ModelType {
      static override Meta = {
        model: Tag,
        name: 'TagNode',
        interfaces: [Node],
        filterFields: { name: ['exact', 'icontains', 'in'] },
        orderBy: ['name'],
      }
    }
    class Q2 extends Query {
      static override fields = { node: Node.Field(), nodes: Node.ListField(), tags: ConnectionField(N) }
    }
    const sdl = new Schema({ query: Q2 }).printSchema()
    expect(sdl).toContain('type TagNode implements Node')
    expect(sdl).toContain('node(\n    """The global ID of the object."""\n    id: ID!\n  ): Node')
    expect(sdl).toContain('nodes(ids: [ID!]!): [Node]!')
    expect(sdl).toMatch(
      /tags\([\s\S]*first: Int[\s\S]*filter: TagNodeFilter[\s\S]*orderBy: \[String!\][\s\S]*\): TagNodeConnection!/,
    )
    expect(typeBlock(sdl, 'TagNodeConnection')).toMatch(
      /pageInfo: PageInfo![\s\S]*edges: \[TagNodeEdge!\]![\s\S]*totalCount: Int!/,
    )
    expect(typeBlock(sdl, 'TagNodeNameFilter')).toMatch(
      /exact: String[\s\S]*icontains: String[\s\S]*in: \[String!\]/,
    )
    expect(typeBlock(sdl, 'TagNodeFilter')).toMatch(
      /name: TagNodeNameFilter[\s\S]*and: \[TagNodeFilter!\][\s\S]*or: \[TagNodeFilter!\][\s\S]*not: TagNodeFilter/,
    )
  })
})
