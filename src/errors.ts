import {
  GhuriError,
  Http404,
  HttpError,
  ObjectDoesNotExist,
  PermissionDenied,
  ValidationError,
} from '@ghuri/core'
import { DatabaseError } from '@ghuri/orm'
import { GraphQLError, type GraphQLFormattedError } from 'graphql'

/** Raised by `loginRequired` & co. for anonymous users (`extensions.code: 'UNAUTHENTICATED'`). */
export class NotAuthenticated extends PermissionDenied {
  override status = 401
  constructor(message = 'Authentication credentials were not provided.') {
    super(message)
  }
}

/** Bad configuration of GraphQL types (unknown type reference, duplicate names, …). */
export class GraphQLConfigurationError extends GhuriError {}

export const DEFAULT_PERMISSION_MESSAGE = 'You do not have permission to perform this action.'
export const INTERNAL_ERROR_MESSAGE = 'Internal server error'

/** Status-like number of an error (core `HttpError.status`, REST `APIException.statusCode`). */
function statusOf(err: unknown): number | undefined {
  const e = err as any
  if (typeof e?.statusCode === 'number') return e.statusCode
  if (typeof e?.status === 'number') return e.status
  return undefined
}

/** `extensions.code` for an error thrown by a resolver. */
export function errorCode(err: unknown): string {
  if (err instanceof GraphQLError && typeof err.extensions?.code === 'string') return err.extensions.code
  if (err instanceof NotAuthenticated) return 'UNAUTHENTICATED'
  if (err instanceof ValidationError) return 'BAD_USER_INPUT'
  if (err instanceof Http404 || err instanceof ObjectDoesNotExist) return 'NOT_FOUND'
  if (err instanceof PermissionDenied) return 'PERMISSION_DENIED'
  const status = statusOf(err)
  if (status === 401) return 'UNAUTHENTICATED'
  if (status === 403) return 'PERMISSION_DENIED'
  if (status === 404) return 'NOT_FOUND'
  if (status !== undefined && status >= 400 && status < 500) return 'BAD_USER_INPUT'
  return 'INTERNAL_SERVER_ERROR'
}

/**
 * Is the message of `err` safe to show to API clients? `GraphQLError`s and `GhuriError` subclasses are
 * (they are written for users: `PermissionDenied`, `ValidationError`, `Post.DoesNotExist`, REST
 * `APIException`s, …) except database errors and 5xx HTTP errors. Anything else is masked unless DEBUG.
 */
export function isSafeError(err: unknown): boolean {
  if (err instanceof GraphQLError) return true
  if (err instanceof DatabaseError) return false
  if (err instanceof HttpError) return err.status < 500
  if (err instanceof GhuriError) {
    const status = statusOf(err)
    return status === undefined || status < 500
  }
  return false
}

export interface FormatErrorOptions {
  debug?: boolean
  /** Called for every masked (unexpected) error, default `console.error`. */
  log?: (err: unknown) => void
}

/**
 * Format a GraphQL error for the response: adds `extensions.code`, masks unexpected errors as
 * "Internal server error" (unless `debug`, which adds `extensions.exception` with the stack).
 */
export function formatError(error: GraphQLError, opts: FormatErrorOptions = {}): GraphQLFormattedError {
  let original: unknown = error.originalError
  while (original instanceof GraphQLError && original.originalError) original = original.originalError
  const formatted = error.toJSON() as { message: string; extensions?: Record<string, unknown> } & Record<
    string,
    unknown
  >
  if (original === undefined || original === null) {
    // syntax / validation / coercion errors created by graphql-js
    return formatted
  }
  const extensions: Record<string, unknown> = { ...(formatted.extensions ?? {}) }
  if (extensions.code === undefined) extensions.code = errorCode(original)
  if (original instanceof ValidationError && original.messageDict) {
    extensions.fields = original.messageDict
  }
  const safe = isSafeError(original)
  if (!safe) (opts.log ?? console.error)(original)
  if (!safe && !opts.debug) {
    return {
      ...formatted,
      message: INTERNAL_ERROR_MESSAGE,
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    }
  }
  if (opts.debug && original instanceof Error) {
    extensions.exception = {
      name: original.name,
      stack: (original.stack ?? '').split('\n').map((l) => l.trim()),
    }
  }
  const message =
    original instanceof ValidationError && original.messages.length
      ? original.messages.join(' ')
      : formatted.message
  return { ...formatted, message, extensions }
}

/** Copy of `error` with `extensions.code` set (unmasked: for `schema.execute()` / tests). */
export function withErrorCode(error: GraphQLError): GraphQLError {
  if (error.extensions?.code !== undefined || !error.originalError) return error
  return new GraphQLError(error.message, {
    nodes: error.nodes,
    source: error.source,
    positions: error.positions,
    path: error.path,
    originalError: error.originalError,
    extensions: { ...error.extensions, code: errorCode(error.originalError) },
  })
}
