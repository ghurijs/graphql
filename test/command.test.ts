import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bufferIO, CommandError, callCommand, createContext, runWithContext } from '@ghuri/core'
import { describe, expect, it } from 'vitest'
import { Field, GraphQLConfig, GraphQLSchemaCommand, Query, Schema } from '../src/index'

class Q extends Query {
  static override fields = {
    zeta: Field(String, { resolve: () => 'z' }),
    alpha: Field(Int32Like(), { resolve: () => 1 }),
  }
}
function Int32Like() {
  return Number
}
const schema = new Schema({ query: Q })

function ctx(graphql?: Record<string, unknown>) {
  return createContext({
    env: {},
    settings: {
      SECRET_KEY: 'x',
      INSTALLED_APPS: [],
      ROOT_URLCONF: [],
      ...(graphql ? { GRAPHQL: graphql } : {}),
    } as any,
  })
}

describe('graphql_schema command', () => {
  it('is exposed by GraphQLConfig', () => {
    expect(new GraphQLConfig().commands.graphql_schema).toBe(GraphQLSchemaCommand)
  })

  it('prints SDL (optionally sorted) from GRAPHQL.SCHEMA', async () => {
    const io = bufferIO()
    await runWithContext(ctx({ SCHEMA: schema }), () => callCommand(GraphQLSchemaCommand, {}, io))
    expect(io.out[0]).toBe('type Query {\n  zeta: String\n  alpha: Float\n}')
    const sorted = bufferIO()
    await runWithContext(ctx({ SCHEMA: () => schema }), () =>
      callCommand(GraphQLSchemaCommand, { sort: true }, sorted),
    )
    expect(sorted.out[0]).toBe('type Query {\n  alpha: Float\n  zeta: String\n}')
  })

  it('writes SDL / introspection JSON to a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghuri-gql-'))
    try {
      const out = join(dir, 'schema.graphql')
      const io = bufferIO()
      await runWithContext(ctx({ SCHEMA: schema }), () => callCommand(GraphQLSchemaCommand, { out }, io))
      expect(readFileSync(out, 'utf8')).toContain('type Query')
      expect(io.out[0]).toContain('Successfully dumped GraphQL schema')
      const jsonOut = join(dir, 'schema.json')
      await runWithContext(ctx({ SCHEMA: schema }), () =>
        callCommand(GraphQLSchemaCommand, { out: jsonOut, json: true, indent: '0' }, bufferIO()),
      )
      expect(JSON.parse(readFileSync(jsonOut, 'utf8')).data.__schema.queryType.name).toBe('Query')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails without a schema', async () => {
    await expect(
      runWithContext(ctx(), () => callCommand(GraphQLSchemaCommand, {}, bufferIO())),
    ).rejects.toThrow(CommandError)
  })
})
