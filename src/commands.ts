// `graphql_schema`: print / write the schema as SDL (or introspection JSON).
import { type ArgumentParser, BaseCommand, CommandError, type CommandIO, tryGetContext } from '@ghuri/core'
import { introspectionFromSchema, lexicographicSortSchema, printSchema } from 'graphql'
import { toGraphQLSchema } from './schema'
import type { GraphQLSettings } from './settings'

/**
 * `ghuri graphql_schema [--out schema.graphql] [--json] [--sort] [--indent 2]` (graphene-django's command).
 * Uses `GRAPHQL.SCHEMA`; `--out` writes a file (Node only), otherwise the SDL goes to stdout.
 */
export class GraphQLSchemaCommand extends BaseCommand {
  static override help =
    'Prints the GraphQL schema (GRAPHQL.SCHEMA) as SDL, or as introspection JSON with --json.'

  /** Schema to print when not using settings (tests / programmatic use). */
  static schema?: unknown

  override addArguments(parser: ArgumentParser): void {
    parser
      .option('-o, --out <file>', { help: 'Write the schema to this file instead of stdout.' })
      .option('--json', { help: 'Output the introspection result as JSON instead of SDL.' })
      .option('--sort', { help: 'Sort types and fields alphabetically.' })
      .option('--indent <n>', { help: 'Indentation of the JSON output (default 2).' })
  }

  async handle(args: Record<string, unknown>, io: CommandIO): Promise<number> {
    const settings = (tryGetContext()?.settings?.GRAPHQL ?? {}) as GraphQLSettings
    const source = (this.constructor as typeof GraphQLSchemaCommand).schema ?? args.schema ?? settings.SCHEMA
    if (!source) throw new CommandError('Set GRAPHQL.SCHEMA in your settings (or pass a schema).')
    let schema = toGraphQLSchema(source)
    if (args.sort) schema = lexicographicSortSchema(schema)
    const indent = args.indent === undefined ? 2 : Number(args.indent)
    const output = args.json
      ? `${JSON.stringify({ data: introspectionFromSchema(schema) }, null, Number.isFinite(indent) ? indent : 2)}\n`
      : `${printSchema(schema)}\n`
    const out = (args.out ?? args.o) as string | undefined
    if (out) {
      const { writeFile } = await import('node:fs/promises')
      await writeFile(out, output, 'utf8')
      io.stdout(io.style.success(`Successfully dumped GraphQL schema to ${out}`))
      return 0
    }
    io.stdout(output.trimEnd())
    return 0
  }
}
