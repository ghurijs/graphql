import {
  BigIntegerField,
  BinaryField,
  BooleanField,
  CASCADE,
  CharField,
  DateField,
  DateTimeField,
  DecimalField,
  DurationField,
  EmailField,
  FloatField,
  ForeignKey,
  GenericIPAddressField,
  IntegerField,
  JSONField,
  type Manager,
  ManyToManyField,
  Model,
  OneToOneField,
  PositiveIntegerField,
  PositiveSmallIntegerField,
  type RelatedManager,
  registerFieldClass,
  SET_NULL,
  SlugField,
  SmallIntegerField,
  TextField,
  TimeField,
  URLField,
  UUIDField,
} from '@ghuri/orm'

/** Stand-in for @ghuri/storage's FileField: stores a name, exposes `{ name, url }`. */
export class FakeFileField extends CharField<{ maxLength: number; blank: true }> {
  static override readonly internalType: string = 'FileField'
  constructor() {
    super({ maxLength: 100, blank: true })
  }
  override fromDb(value: unknown): any {
    if (!value) return { name: null, isEmpty: true }
    return { name: value, isEmpty: false, url: `https://cdn.example.com/${value}` }
  }
  override toDb(value: any): any {
    return value && typeof value === 'object' ? value.name : value
  }
}

// migrations state (used when an app with migrations, e.g. auth, is installed) needs to know the type
if (!(globalThis as any).__ghuriFakeFile) {
  ;(globalThis as any).__ghuriFakeFile = true
  registerFieldClass(FakeFileField as any)
}

export class Member extends Model({
  username: new CharField({ maxLength: 50, unique: true }),
  isStaff: new BooleanField({ default: false }),
}) {
  declare static objects: Manager<Member>
  static Meta = { appLabel: 'blog', ordering: ['id'] }
  declare posts: RelatedManager<Post>
  toString(): string {
    return this.username
  }
}

export class Profile extends Model({
  member: new OneToOneField(() => Member, { onDelete: CASCADE, relatedName: 'profile' }),
  bio: new TextField({ blank: true }),
}) {
  declare static objects: Manager<Profile>
  static Meta = { appLabel: 'blog' }
}

export class Tag extends Model({
  name: new CharField({ maxLength: 30, unique: true }),
}) {
  declare static objects: Manager<Tag>
  static Meta = { appLabel: 'blog', ordering: ['name'] }
}

export class Post extends Model({
  title: new CharField({ maxLength: 100, helpText: 'Headline' }),
  slug: new SlugField({ unique: true }),
  body: new TextField({ blank: true }),
  published: new BooleanField({ default: false }),
  status: new CharField({
    maxLength: 10,
    choices: [
      ['draft', 'Draft'],
      ['in-review', 'In review'],
      ['live', 'Live'],
    ],
    default: 'draft',
  }),
  rating: new DecimalField({ maxDigits: 4, decimalPlaces: 2, null: true, blank: true }),
  views: new PositiveIntegerField({ default: 0 }),
  author: new ForeignKey(() => Member, { onDelete: CASCADE, relatedName: 'posts' }),
  editor: new ForeignKey(() => Member, {
    onDelete: SET_NULL,
    null: true,
    blank: true,
    relatedName: 'edited',
  }),
  tags: new ManyToManyField(() => Tag, { blank: true, relatedName: 'posts' }),
  createdAt: new DateTimeField({ autoNowAdd: true }),
}) {
  declare static objects: Manager<Post>
  static Meta = { appLabel: 'blog', ordering: ['id'] }
  declare comments: RelatedManager<Comment>
  toString(): string {
    return this.title
  }
}

export class Comment extends Model({
  post: new ForeignKey(() => Post, { onDelete: CASCADE, relatedName: 'comments' }),
  text: new CharField({ maxLength: 200 }),
  approved: new BooleanField({ default: true }),
}) {
  declare static objects: Manager<Comment>
  static Meta = { appLabel: 'blog', ordering: ['id'] }
}

/** Every scalar field type. */
export class Everything extends Model({
  char: new CharField({ maxLength: 10 }),
  text: new TextField({ null: true }),
  slug: new SlugField({ null: true }),
  email: new EmailField({ null: true }),
  url: new URLField({ null: true }),
  uuid: new UUIDField({ null: true }),
  ip: new GenericIPAddressField({ null: true }),
  integer: new IntegerField({ null: true }),
  bigInteger: new BigIntegerField({ null: true }),
  smallInteger: new SmallIntegerField({ null: true }),
  positiveInteger: new PositiveIntegerField({ null: true }),
  positiveSmallInteger: new PositiveSmallIntegerField({ null: true }),
  float: new FloatField({ null: true }),
  decimal: new DecimalField({ maxDigits: 8, decimalPlaces: 3, null: true }),
  boolean: new BooleanField({ default: false }),
  date: new DateField({ null: true }),
  dateTime: new DateTimeField({ null: true }),
  time: new TimeField({ null: true }),
  duration: new DurationField({ null: true }),
  json: new JSONField({ null: true }),
  binary: new BinaryField({ null: true }),
  file: new FakeFileField(),
  level: new IntegerField({
    choices: [
      [1, 'Low'],
      [2, 'High'],
    ],
    default: 1,
  }),
}) {
  declare static objects: Manager<Everything>
  static Meta = { appLabel: 'blog' }
}

export const allModels = [Member, Profile, Tag, Post, Comment, Everything]
