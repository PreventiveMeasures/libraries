// The typed contract for archive/compression.js, hand-written: keep it
// name for name with compression.js, and change it in the same commit as
// the signature.

// A format is what the platform's streams take: 'gzip', 'deflate' and
// 'deflate-raw' everywhere, 'brotli' where it was added. `supports` says
// whether this runtime has one both ways.
export function supports(format: string): boolean

// `limit` bounds the output in bytes; past it the call rejects with
// `limited` set rather than going on.
export interface Options {
  limit?: number
}

// The whole input through one stream, the whole output back.
export function compress(bytes: Uint8Array, format: string, options?: Options): Promise<Uint8Array>
export function decompress(bytes: Uint8Array, format: string, options?: Options): Promise<Uint8Array>

// `offset` is where in the archive the reader gave up; unset here.
export class ArchiveError extends Error {
  constructor(detail: string, offset?: number)
  offset: number | undefined
}

// What a stream refused: `bytes` is what it had put out by then, kept for a
// caller that wants it as gzip does; `limited` is true when the output
// bound stopped it rather than the data; `cause` is the platform's error.
export class CompressionError extends ArchiveError {
  bytes: Uint8Array
  limited: boolean
  cause: unknown
}
