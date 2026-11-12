// Minimal Worker: GraphQLView over a D1-backed model.
import { createApp, defineSettings, path } from '@ghuri/core'
import { CharField, d1, type Manager, Model } from '@ghuri/orm'
import { Field, GraphQLView, String as GString, List, ModelType, Query, Schema } from '../../src/index'

class Tag extends Model({ name: new CharField({ maxLength: 30 }) }) {
  declare static objects: Manager<Tag>
  static Meta = { appLabel: 'edge', ordering: ['id'] }
}
class TagType extends ModelType {
  static override Meta = { model: Tag }
}
class EdgeQuery extends Query {
  static override fields = {
    hello: Field(GString, { resolve: () => `hello from ${navigator.userAgent}` }),
    tags: List(TagType),
  }
}
const schema = new Schema({ query: EdgeQuery })

export default createApp(
  defineSettings((env) => ({
    SECRET_KEY: env.SECRET_KEY,
    INSTALLED_APPS: [],
    ROOT_URLCONF: [path('graphql/', GraphQLView.asView({ schema }))],
    DATABASES: { default: d1('DB') },
    GRAPHQL: { GRAPHIQL: true },
  })),
)
