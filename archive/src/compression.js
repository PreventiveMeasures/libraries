// Bytes through the platform's compression streams, both ways: the zip
// half's deflate, and a front door of its own for anything else with bytes
// to compress. What came out before a stream failed travels with the
// error, for a caller that keeps it as gzip does.

import { concat } from './bytes.js'
import { ArchiveError } from './error.js'

export class CompressionError extends ArchiveError {
  constructor(detail, { bytes, limited = false, cause }) {
    super(detail, undefined, { limited })
    this.name = 'CompressionError'
    this.bytes = bytes
    this.cause = cause
  }
}

// Whether this runtime's streams know a format both ways: gzip is
// everywhere they are, brotli only where it was added.
export function supports(format) {
  try {
    return [new CompressionStream(format), new DecompressionStream(format)].every(Boolean)
  } catch {
    return false
  }
}

// A stream's chunks: the stream itself where the platform iterates streams,
// and a reader's where it does not. Either cancels the stream when the loop
// reading it is left before its end.
async function* readerChunks(stream) {
  const reader = stream.getReader()
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value
  } finally {
    reader.cancel().catch(() => {})
  }
}
const chunksOf = (stream) => (Symbol.asyncIterator in stream ? stream : readerChunks(stream))

// The stream is made here, so a format the runtime lacks rejects with the
// platform's own error, as a bad argument rather than bad data. The bytes
// go in as one write, which the stream takes in as it can, rather than in
// a Blob's pieces, each a turn of its own. Output is gathered in the pieces
// the stream makes and joined at the end, or, given `into`, copied into it
// as each piece comes and the piece let go: joining holds the output twice
// at the end, which a caller who knows how much is coming need not pay.
// Output past `limit` is refused where it is, not after it has all been
// made: leaving the loop cancels the stream. A bound that is no number
// (NaN) refuses everything, not nothing.
async function through(bytes, Stream, format, limit, verb, into) {
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('the data is not a Uint8Array')
  const transform = new Stream(format)
  const chunks = []
  let length = 0
  // What has come out so far, as one array: handed back at the end, and
  // with the error if the stream fails first.
  const made = () => {
    if (into !== undefined) return into.subarray(0, length)
    return chunks.length === 1 ? chunks[0] : concat(chunks)
  }
  // The stream's own failure is read from its output; the writes fail with it.
  const writer = transform.writable.getWriter()
  writer.write(bytes).catch(() => {})
  writer.close().catch(() => {})
  try {
    for await (const chunk of chunksOf(transform.readable)) {
      if (!(length + chunk.length <= limit)) throw new RangeError(`output past ${limit} bytes`)
      if (into === undefined) chunks.push(chunk)
      else into.set(chunk, length)
      length += chunk.length
    }
  } catch (cause) {
    const limited = cause instanceof RangeError
    throw new CompressionError(limited ? `the data ${verb}es past ${limit} bytes` : `the data does not ${verb}`, { bytes: made(), limited, cause })
  }
  return made()
}

export const compress = (bytes, format, { limit = Infinity } = {}) => through(bytes, CompressionStream, format, limit, 'compress')

const inflate = (bytes, format, limit) => through(bytes, DecompressionStream, format, limit, 'decompress')

// gzip(1) and zlib take zero bytes after the last member as padding, as old
// tarballs run on in zeros to a whole 10240-byte record, the way npm 1.0
// packed them through the system's tar; the platform's stream refuses
// anything there. So gzip that ends in a zero and does not decompress is
// tried again ending sooner, at the one place it decompresses whole: its
// last member's last four bytes are the length it inflates to, mod 2^32,
// so where that is not 0 it ends within three zeros past the last byte that
// is not; where the member is empty, as zlib writes one, `03 00` and eight
// zeros, within nine. Only zeros are passed over, where zlib passes over
// whatever follows one; and each place tried inflates it all again, which
// only padded data pays for.
export async function decompress(bytes, format, { limit = Infinity } = {}) {
  try {
    return await inflate(bytes, format, limit)
  } catch (error) {
    if (format !== 'gzip' || !(error instanceof CompressionError) || error.limited || bytes.at(-1) !== 0) throw error
    const last = bytes.findLastIndex((byte) => byte !== 0)
    for (let end = last + 1; end <= Math.min(last + 10, bytes.length - 1); end++) {
      try {
        return await inflate(bytes.subarray(0, end), format, limit)
      } catch (retry) {
        // Output past the bound before the end is past it wherever the end is.
        if (!(retry instanceof CompressionError) || retry.limited) throw retry
      }
    }
    throw error
  }
}

// Into `into`, which bounds the output, and handed back as much of it as
// was filled. Not in the front door: the zip half's, whose entries each
// declare their size.
export const decompressInto = (bytes, format, into) => through(bytes, DecompressionStream, format, into.length, 'decompress', into)
