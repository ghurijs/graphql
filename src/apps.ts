import { AppConfig } from '@ghuri/core'
import { GraphQLSchemaCommand } from './commands'

/** Add to `INSTALLED_APPS` to get the `graphql_schema` command. */
export class GraphQLConfig extends AppConfig {
  name = 'graphql'
  override verboseName = 'GraphQL'
  override commands = { graphql_schema: GraphQLSchemaCommand }
}
