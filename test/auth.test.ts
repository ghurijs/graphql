// End-to-end with @ghuri/auth: sessions (forceLogin + CSRF), token auth, decorators and type permissions.
import {
  AuthConfig,
  AuthenticationMiddleware,
  AuthTokenConfig,
  ContentType,
  ContentTypesConfig,
  createPermissions,
  PBKDF2PasswordHasher,
  Permission,
  SessionMiddleware,
  SessionsConfig,
  Token,
  User,
} from '@ghuri/auth'
import { SessionAuthentication, TokenAuthentication } from '@ghuri/auth/rest'
import { AppConfig, CsrfMiddleware, callCommand, createApp, defineSettings, path } from '@ghuri/core'
import { createTestClient, type TestClient } from '@ghuri/core/testing'
import { setupTestDatabase, type TestDatabase } from '@ghuri/orm/testing'
import { IsAuthenticated } from '@ghuri/rest'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  Field,
  GraphQLConfig,
  GraphQLView,
  String as GString,
  List,
  loginRequired,
  ModelType,
  Mutation,
  NonNull,
  permissionRequired,
  Query,
  type ResolveInfo,
  Schema,
  staffMemberRequired,
  superuserRequired,
} from '../src/index'
import { assertResponseHasErrors, assertResponseNoErrors, graphqlQuery } from '../src/testing'
import { Comment, Everything, Member, Post, Profile, Tag } from './models'

class BlogConfig extends AppConfig {
  name = 'blog'
  override models = { Member, Profile, Tag, Post, Comment, Everything }
}

class UserType extends ModelType {
  static override Meta = { model: User, fields: ['id', 'username', 'isStaff'] }
}

class OwnProfileOnly {
  hasPermission(request: any) {
    return request.user.isAuthenticated
  }
  hasObjectPermission(request: any, _view: unknown, obj: Profile) {
    return obj.bio.startsWith(request.user.username)
  }
}
class ProfileType extends ModelType {
  static override Meta = { model: Profile, fields: ['id', 'bio'], permissionClasses: [OwnProfileOnly] }
}
class MemberType extends ModelType {
  static override Meta = { model: Member, fields: ['id', 'username', 'profile'] }
}

class CreateTag extends Mutation {
  static override Meta = { permissionClasses: [IsAuthenticated] }
  static override Arguments = { name: NonNull(String) }
  static override fields = { name: GString }
  static override async mutate(_r: unknown, { name }: { name: string }) {
    const tag = await Tag.objects.create({ name })
    return { name: tag.name }
  }
}

class AuthQuery extends Query {
  static override fields = {
    me: Field(UserType, {
      resolve: loginRequired((_: unknown, _a: unknown, info: ResolveInfo) => info.context.user),
    }),
    staffOnly: Field(String, { resolve: staffMemberRequired(() => 'staff secret') }),
    superOnly: Field(String, { resolve: superuserRequired(() => 'root secret') }),
    canAddPost: Field(String, { resolve: permissionRequired('blog.add_post')(() => 'yes') }),
    authenticatedOnly: Field(String, { permissionClasses: [IsAuthenticated], resolve: () => 'in' }),
    profiles: List(ProfileType),
    profile: Field(ProfileType, { resolve: () => Profile.objects.first() }),
    members: List(MemberType),
  }
}
class AuthMutation extends Mutation {
  static override fields = { createTag: CreateTag.field() }
}

const schema = new Schema({ query: AuthQuery, mutation: AuthMutation })

describe('with @ghuri/auth', () => {
  let db: TestDatabase
  let client: TestClient
  let ann: User
  let boss: User

  beforeAll(async () => {
    const env: Record<string, unknown> = {}
    const settings = defineSettings(() => ({
      SECRET_KEY: 'test-secret',
      INSTALLED_APPS: [
        ContentTypesConfig,
        AuthConfig,
        SessionsConfig,
        AuthTokenConfig,
        BlogConfig,
        GraphQLConfig,
      ],
      MIDDLEWARE: [SessionMiddleware, CsrfMiddleware, AuthenticationMiddleware],
      ROOT_URLCONF: [
        path(
          'graphql/',
          GraphQLView.asView({ authenticationClasses: [SessionAuthentication, TokenAuthentication] }),
        ),
      ],
      PASSWORD_HASHERS: [new PBKDF2PasswordHasher({ iterations: 1000 })],
      GRAPHQL: { SCHEMA: schema },
    }))
    const app = createApp(settings, { checks: false })
    await app.setup(env)
    db = await setupTestDatabase({ using: 'sqlite' })
    client = createTestClient(app, { env })
  }, 60_000)
  afterAll(async () => {
    await db?.teardown()
  })
  beforeEach(async () => {
    ContentType.objects.clearCache()
    await db.flush()
    ContentType.objects.clearCache()
    await createPermissions()
    client.clearCookies()
    ann = await User.objects.createUser('ann', 'ann@example.com', 'pw')
    boss = await User.objects.createUser('boss', null, 'pw', { isStaff: true })
  })

  it('loginRequired: anonymous vs logged-in user (session)', async () => {
    const anon = await graphqlQuery(client, '{ me { username } }')
    expect(anon.status).toBe(200)
    assertResponseHasErrors(anon, { code: 'UNAUTHENTICATED' })
    expect(anon.data).toEqual({ me: null })
    await client.forceLogin(ann)
    const me = await graphqlQuery(client, '{ me { username isStaff } }')
    assertResponseNoErrors(me)
    expect(me.data).toEqual({ me: { username: 'ann', isStaff: false } })
  })

  it('staffMemberRequired / superuserRequired / permissionRequired / field permission classes', async () => {
    const q = '{ staffOnly superOnly canAddPost authenticatedOnly }'
    const anon = await graphqlQuery(client, q)
    expect(anon.errors?.map((e) => e.extensions?.code)).toEqual(Array(4).fill('UNAUTHENTICATED'))
    await client.forceLogin(ann)
    const user = await graphqlQuery(client, q)
    expect(user.data).toEqual({ staffOnly: null, superOnly: null, canAddPost: null, authenticatedOnly: 'in' })
    expect(user.errors?.map((e) => e.extensions?.code)).toEqual(Array(3).fill('PERMISSION_DENIED'))
    await ann.userPermissions.add(await Permission.objects.getByNaturalKey('add_post', 'blog', 'post'))
    const perm = await graphqlQuery(client, '{ canAddPost }')
    expect(perm.data).toEqual({ canAddPost: 'yes' })
    client.clearCookies()
    await client.forceLogin(boss)
    const staff = await graphqlQuery(client, '{ staffOnly superOnly }')
    expect(staff.data).toEqual({ staffOnly: 'staff secret', superOnly: null })
  })

  it('session-authenticated mutations need the CSRF token; token-authenticated ones do not', async () => {
    const m = 'mutation { createTag(name: "js") { name } }'
    const anon = await graphqlQuery(client, m)
    expect(anon.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED')
    await client.forceLogin(ann)
    const noCsrf = await graphqlQuery(client, m, { csrf: false })
    expect(noCsrf.status).toBe(403)
    expect(noCsrf.errors?.[0].message).toContain('CSRF')
    const withCsrf = await graphqlQuery(client, m)
    expect(withCsrf.data).toEqual({ createTag: { name: 'js' } })
    client.clearCookies()
    const token = await Token.objects.create({ user: boss })
    const viaToken = await graphqlQuery(client, 'mutation { createTag(name: "ts") { name } }', {
      csrf: false,
      headers: { authorization: `Token ${token.key}` },
    })
    expect(viaToken.status).toBe(200)
    expect(viaToken.data).toEqual({ createTag: { name: 'ts' } })
    const me = await graphqlQuery(client, '{ me { username } }', {
      headers: { authorization: `Token ${token.key}` },
    })
    expect(me.data).toEqual({ me: { username: 'boss' } })
    const bad = await graphqlQuery(client, '{ me { username } }', {
      headers: { authorization: 'Token nope' },
    })
    expect(bad.status).toBe(401)
    expect(bad.response.headers.get('www-authenticate')).toBe('Token')
    expect(bad.errors?.[0]).toMatchObject({
      message: 'Invalid token.',
      extensions: { code: 'UNAUTHENTICATED' },
    })
  })

  it('type permission classes: hasPermission per request, hasObjectPermission per object', async () => {
    const a = await Member.objects.create({ username: 'ann' })
    const b = await Member.objects.create({ username: 'bob' })
    await Profile.objects.create({ member: a, bio: 'ann: hello' })
    await Profile.objects.create({ member: b, bio: 'bob: hi' })
    const anon = await graphqlQuery(client, '{ profiles { bio } }')
    expect(anon.errors?.[0].extensions?.code).toBe('UNAUTHENTICATED')
    await client.forceLogin(ann)
    const lists = await graphqlQuery(client, '{ profiles { bio } members { username profile { bio } } }')
    expect(lists.errors?.map((e) => e.path?.join('.'))).toEqual(['members.1.profile'])
    expect(lists.data?.profiles).toEqual([{ bio: 'ann: hello' }])
    expect(lists.data?.members).toEqual([
      { username: 'ann', profile: { bio: 'ann: hello' } },
      { username: 'bob', profile: null },
    ])
    const single = await graphqlQuery(client, '{ profile { bio } }')
    expect(single.data).toEqual({ profile: { bio: 'ann: hello' } })
  })

  it('graphql_schema command prints the SDL from settings', async () => {
    const io = {
      out: [] as string[],
      err: [] as string[],
      stdout: (m: string) => io.out.push(m),
      stderr: (m: string) => io.err.push(m),
      style: {
        success: (s: string) => s,
        warning: (s: string) => s,
        error: (s: string) => s,
        notice: (s: string) => s,
        bold: (s: string) => s,
      },
    }
    await client.withContext(() => callCommand('graphql_schema', {}, io))
    expect(io.out[0]).toContain('type Query {')
    expect(io.out[0]).toContain('me: UserType')
    const json = { ...io, out: [] as string[] }
    json.stdout = (m: string) => json.out.push(m)
    await client.withContext(() => callCommand('graphql_schema', { json: true, sort: true }, json))
    expect(JSON.parse(json.out[0]).data.__schema.queryType.name).toBe('Query')
  })
})
