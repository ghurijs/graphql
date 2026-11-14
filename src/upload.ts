// File uploads: the `Upload` scalar and the GraphQL multipart request spec
// (https://github.com/jaydenseric/graphql-multipart-request-spec).
import { GraphQLError, GraphQLScalarType } from 'graphql'

/** Default `maxFileSize`: 10 MiB per file. */
export const DEFAULT_UPLOAD_MAX_FILE_SIZE = 10 * 1024 * 1024
/** Default `maxUploadSize`: 25 MiB for the whole multipart body. */
export const DEFAULT_UPLOAD_MAX_SIZE = 25 * 1024 * 1024
/** Default `maxFiles`: 10 file parts per request. */
export const DEFAULT_UPLOAD_MAX_FILES = 10

/** A `Blob` (or `File`), checked structurally so Blobs from another realm / polyfill also count. */
export function isBlob(value: unknown): value is Blob {
  if (typeof Blob !== 'undefined' && value instanceof Blob) return true
  const v = value as any
  return (
    !!v &&
    typeof v === 'object' &&
    typeof v.size === 'number' &&
    typeof v.type === 'string' &&
    typeof v.arrayBuffer === 'function' &&
    typeof v.stream === 'function' &&
    typeof v.slice === 'function'
  )
}

function toFile(value: Blob): File {
  if (typeof (value as File).name === 'string') return value as File
  return new File([value], 'blob', { type: value.type })
}

/**
 * A file sent with a GraphQL multipart request (graphene-file-upload's / graphql-upload's `Upload`). Use it for
 * arguments and input fields: the resolver receives a web `File` (`name`, `type`, `size`, `arrayBuffer()`,
 * `stream()`), ready for `defaultStorage.save()` or a model's `FileField` / `ImageField`.
 *
 * ```ts
 * class UploadAvatar extends Mutation {
 *   static Arguments = { file: NonNull(Upload) }
 *   static fields = { url: String }
 *   static async mutate(_root, { file }, info) { … }     // file: File
 * }
 * ```
 *
 * Over HTTP the value comes from a `multipart/form-data` request (`GraphQLView`); in-process,
 * `schema.execute(source, { variables: { file } })` takes a `File` or `Blob` directly. Upload is input only: it
 * cannot be returned, and a literal in the query (`upload(file: "x")`) is an error.
 */
export const Upload: GraphQLScalarType<File, never> = new GraphQLScalarType<File, never>({
  name: 'Upload',
  description:
    'A file sent with a GraphQL multipart request (https://github.com/jaydenseric/graphql-multipart-request-spec).',
  specifiedByURL: 'https://github.com/jaydenseric/graphql-multipart-request-spec',
  coerceOutputValue() {
    throw new GraphQLError('Upload cannot be used as an output type.')
  },
  coerceInputValue(value) {
    if (isBlob(value)) return toFile(value)
    throw new GraphQLError(
      'Upload value invalid: send the file in a multipart request (GraphQL multipart request spec).',
    )
  },
})

// ---- the multipart request -----------------------------------------------------------------------------

/** A malformed or refused multipart request (the view maps it to an HTTP status). */
export class UploadError extends Error {
  constructor(
    readonly status: 400 | 413,
    message: string,
  ) {
    super(message)
    this.name = 'UploadError'
  }
}

export interface UploadLimits {
  /** Largest single file in bytes (default `DEFAULT_UPLOAD_MAX_FILE_SIZE`). */
  maxFileSize?: number
  /** Largest multipart body in bytes, files included (default `DEFAULT_UPLOAD_MAX_SIZE`). */
  maxUploadSize?: number
  /** Most file parts in one request (default `DEFAULT_UPLOAD_MAX_FILES`). */
  maxFiles?: number
}

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])
const INDEX_RE = /^(0|[1-9]\d*)$/

function parseJsonField(form: FormData, name: 'operations' | 'map'): unknown {
  const raw = form.get(name)
  if (raw === null) throw new UploadError(400, `Missing multipart field "${name}".`)
  if (typeof raw !== 'string') throw new UploadError(400, `The multipart field "${name}" must not be a file.`)
  try {
    return JSON.parse(raw)
  } catch {
    throw new UploadError(400, `The multipart field "${name}" is not valid JSON.`)
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Put `file` at `path` (`variables.file`, `0.variables.files.1`, …) of the operations. The path must lead to an
 * existing `null` inside an operation's `variables` (the spec's clients replace files with `null`).
 */
function placeFile(operations: unknown, path: string, key: string, file: File): void {
  const invalid = () => new UploadError(400, `Invalid object path "${path}" for map entry "${key}".`)
  const segments = path.split('.')
  if (segments.some((s) => s === '' || FORBIDDEN_SEGMENTS.has(s))) throw invalid()
  let target: unknown = operations
  let i = 0
  if (Array.isArray(operations)) {
    if (!INDEX_RE.test(segments[0]) || Number(segments[0]) >= operations.length) throw invalid()
    target = operations[Number(segments[0])]
    i = 1
  }
  if (segments[i] !== 'variables' || segments.length < i + 2) throw invalid()
  for (; i < segments.length - 1; i++) {
    const seg = segments[i]
    if (Array.isArray(target)) {
      if (!INDEX_RE.test(seg) || Number(seg) >= target.length) throw invalid()
      target = target[Number(seg)]
    } else if (isPlainObject(target)) {
      if (!Object.hasOwn(target, seg)) throw invalid()
      target = target[seg]
    } else {
      throw invalid()
    }
  }
  const last = segments[segments.length - 1]
  if (Array.isArray(target)) {
    if (!INDEX_RE.test(last) || Number(last) >= target.length || target[Number(last)] !== null)
      throw invalid()
    target[Number(last)] = file
  } else if (isPlainObject(target)) {
    if (!Object.hasOwn(target, last) || target[last] !== null) throw invalid()
    target[last] = file
  } else {
    throw invalid()
  }
}

/**
 * Turn a parsed multipart form (`operations`, `map`, file parts) into GraphQL params with the files in their
 * variables. Checks the spec's structure, the map paths and the per-file / file-count limits; throws
 * `UploadError` (400 malformed, 413 too large). Parts not named in `map` are ignored (e.g.
 * `csrfmiddlewaretoken`), but every file part counts toward `maxFiles`.
 */
export function processMultipartForm(
  form: FormData,
  limits: Pick<UploadLimits, 'maxFileSize' | 'maxFiles'> = {},
): Record<string, unknown> | Record<string, unknown>[] {
  const maxFileSize = limits.maxFileSize ?? DEFAULT_UPLOAD_MAX_FILE_SIZE
  const maxFiles = limits.maxFiles ?? DEFAULT_UPLOAD_MAX_FILES
  let files = 0
  for (const [, value] of form) {
    if (typeof value === 'string') continue
    files++
    if (files > maxFiles) throw new UploadError(413, `Too many files: at most ${maxFiles} per request.`)
    if (value.size > maxFileSize) {
      throw new UploadError(413, `File "${value.name}" is too large: at most ${maxFileSize} bytes per file.`)
    }
  }
  const operations = parseJsonField(form, 'operations')
  if (Array.isArray(operations)) {
    if (!operations.every(isPlainObject))
      throw new UploadError(400, 'Batch requests must be a list of objects.')
  } else if (!isPlainObject(operations)) {
    throw new UploadError(400, 'The multipart field "operations" must be a JSON object or array.')
  }
  const map = parseJsonField(form, 'map')
  if (!isPlainObject(map)) throw new UploadError(400, 'The multipart field "map" must be a JSON object.')
  for (const [key, paths] of Object.entries(map)) {
    if (!Array.isArray(paths) || !paths.length || !paths.every((p) => typeof p === 'string')) {
      throw new UploadError(400, `Map entry "${key}" must be a non-empty array of object paths.`)
    }
    const part = form.get(key)
    if (part === null) throw new UploadError(400, `File missing in the request for map entry "${key}".`)
    if (typeof part === 'string') throw new UploadError(400, `Map entry "${key}" is not a file.`)
    for (const path of paths) placeFile(operations, path, key, part)
  }
  return operations as Record<string, unknown> | Record<string, unknown>[]
}

/**
 * Read a `multipart/form-data` request body without buffering more than `maxUploadSize` bytes: a larger
 * `Content-Length` is refused before reading, and a body without one (chunked) is cut off once it passes the
 * limit. Throws `UploadError` 413 / 400.
 */
export async function readMultipartBody(request: Request, maxUploadSize: number): Promise<FormData> {
  const length = request.headers.get('content-length')
  if (length !== null && Number(length) > maxUploadSize) {
    throw new UploadError(413, `Request body too large: at most ${maxUploadSize} bytes.`)
  }
  if (!request.body) throw new UploadError(400, 'Multipart request without a body.')
  let total = 0
  let exceeded = false
  const counted = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > maxUploadSize) {
          exceeded = true
          controller.error(new UploadError(413, `Request body too large: at most ${maxUploadSize} bytes.`))
          return
        }
        controller.enqueue(chunk)
      },
    }),
  )
  const contentType = request.headers.get('content-type') ?? ''
  try {
    return await new Response(counted, { headers: { 'content-type': contentType } }).formData()
  } catch {
    if (exceeded) throw new UploadError(413, `Request body too large: at most ${maxUploadSize} bytes.`)
    throw new UploadError(400, 'Malformed multipart/form-data body.')
  }
}

// ---- the client side (tests, Node scripts) ------------------------------------------------------------

/**
 * Build the multipart body of a GraphQL request whose variables hold `File` / `Blob` values (what
 * apollo-upload-client's `extract-files` does): files are replaced by `null` in `operations`, listed in `map` and
 * appended as parts `1`, `2`, … Pass an array for a batch. A file used twice is sent once.
 *
 * ```ts
 * const body = uploadFormData({ query: 'mutation ($f: Upload!) { upload(file: $f) }', variables: { f: file } })
 * await fetch('/graphql/', { method: 'POST', body, headers: { 'GraphQL-Require-Preflight': '1' } })
 * ```
 */
export function uploadFormData(operations: Record<string, unknown> | Record<string, unknown>[]): FormData {
  const files = new Map<Blob, string[]>()
  const extract = (value: unknown, path: string): unknown => {
    if (isBlob(value)) {
      const paths = files.get(value) ?? []
      paths.push(path)
      files.set(value, paths)
      return null
    }
    if (Array.isArray(value)) return value.map((v, i) => extract(v, `${path}.${i}`))
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(value)) out[k] = extract(v, `${path}.${k}`)
      return out
    }
    return value
  }
  const strip = (op: Record<string, unknown>, prefix: string) =>
    op.variables === undefined ? op : { ...op, variables: extract(op.variables, `${prefix}variables`) }
  const ops = Array.isArray(operations)
    ? operations.map((op, i) => strip(op, `${i}.`))
    : strip(operations, '')
  const form = new FormData()
  form.append('operations', JSON.stringify(ops))
  const map: Record<string, string[]> = {}
  let n = 0
  for (const paths of files.values()) map[String(++n)] = paths
  form.append('map', JSON.stringify(map))
  n = 0
  for (const file of files.keys()) {
    n++
    form.append(String(n), file, typeof (file as File).name === 'string' ? (file as File).name : 'blob')
  }
  return form
}

/** Does any variable (deeply) hold a `File` / `Blob`? */
export function hasUploads(value: unknown): boolean {
  if (isBlob(value)) return true
  if (Array.isArray(value)) return value.some(hasUploads)
  if (isPlainObject(value)) return Object.values(value).some(hasUploads)
  return false
}
