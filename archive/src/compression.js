// Bytes through the platform's compression streams, both ways: the zip
// half's deflate, and a front door of its own for anything else with bytes
// to compress. What came out before a stream failed travels with the
// error, for a caller that keeps it as gzip does.

import { concat } from './bytes.js'
import { ArchiveError } from './error.js'

export class CompressionError extends ArchiveError {
  constructor(detail, { bytes, limited = false, cause }) {
    super(detail)
    this.name = 'CompressionError'
    this.bytes = bytes
    this.limited = limited
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

// A stream's chunks, through async iteration where the platform has it on
// streams, and a reader where it does not.
async function* chunksOf(stream) {
  if (Symbol.asyncIterator in stream) return yield* stream
  const reader = stream.getReader()
  for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value
}

// Output past `limit` is refused where it is, not after it has all been
// made: erroring the bound cancels the stream behind it. A bound that is
// no number (NaN) refuses everything, not nothing.
function bounded(limit) {
  let total = 0
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.length
      if (total <= limit) controller.enqueue(chunk)
      else controller.error(new RangeError(`output past ${limit} bytes`))
    },
  })
}

// The stream is made here, so a format the runtime lacks rejects with the
// platform's own error, as a bad argument rather than bad data.
async function through(bytes, Stream, format, limit, verb) {
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('the data is not a Uint8Array')
  const transform = new Stream(format)
  const chunks = []
  try {
    for await (const chunk of chunksOf(new Blob([bytes]).stream().pipeThrough(transform).pipeThrough(bounded(limit)))) chunks.push(chunk)
  } catch (cause) {
    const limited = cause instanceof RangeError
    throw new CompressionError(limited ? `the data ${verb}es past ${limit} bytes` : `the data does not ${verb}`, { bytes: concat(chunks), limited, cause })
  }
  return chunks.length === 1 ? chunks[0] : concat(chunks)
}

export const compress = (bytes, format, { limit = Infinity } = {}) => through(bytes, CompressionStream, format, limit, 'compress')
export const decompress = (bytes, format, { limit = Infinity } = {}) => through(bytes, DecompressionStream, format, limit, 'decompress')
