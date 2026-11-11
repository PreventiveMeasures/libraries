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

export function supports(format) {
  try {
    return [CompressionStream, DecompressionStream].every((Stream) => new Stream(format))
  } catch {
    return false
  }
}

function checkBytes(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new ArchiveError('the data is not a Uint8Array')
}

// A reader rather than async iteration, which not every platform has; cancels the stream if left early
async function* chunksOf(stream) {
  const reader = stream.getReader()
  try {
    for (let next = await reader.read(); !next.done; next = await reader.read()) yield next.value
  } finally {
    reader.cancel().catch(() => {})
  }
}

// Output past `limit` is refused as it comes (NaN refuses all). Given `target`, output is written
// into it while it fits, rather than gathered in pieces and joined, which holds it twice.
async function through(bytes, Stream, format, limit, verb, target) {
  const transform = new Stream(format) // a format the runtime lacks rejects with the platform's error
  const writer = transform.writable.getWriter()
  writer.write(bytes).catch(() => {}) // the stream's failure is read from its output
  writer.close().catch(() => {})
  const chunks = []
  let length = 0
  const made = () => (target ? target.subarray(0, length) : chunks.length === 1 ? chunks[0] : concat(chunks))
  try {
    for await (const chunk of chunksOf(transform.readable)) {
      if (!(length + chunk.length <= limit)) throw new RangeError(`output past ${limit} bytes`)
      if (target && length + chunk.length > target.length) {
        chunks.push(target.subarray(0, length))
        target = undefined
      }
      if (target) target.set(chunk, length)
      else chunks.push(chunk)
      length += chunk.length
    }
  } catch (cause) {
    const limited = cause instanceof RangeError
    throw new CompressionError(limited ? `the data ${verb}es past ${limit} bytes` : `the data does not ${verb}`, { bytes: made(), limited, cause })
  }
  return made()
}

export async function compress(bytes, format, { limit = Infinity } = {}) {
  checkBytes(bytes)
  return await through(bytes, CompressionStream, format, limit, 'compress')
}

// gzip's last 4 bytes are its last member's size mod 2^32. Trusted only within `limit` and RATIO times
// the input (tarballs come to 2 to 13), so a lying trailer costs no more than that.
const RATIO = 16
function trailerSize(bytes, limit) {
  if (bytes.length < 18) return 0
  const said = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true)
  return said <= limit && said <= bytes.length * RATIO ? said : 0
}

const inflate = (bytes, format, limit, size = 0) => through(bytes, DecompressionStream, format, limit, 'decompress', size ? new Uint8Array(size) : undefined)

// gzip(1) and zlib take zeros after the last member as padding, which the platform refuses. A member ends
// in its size, so within 3 zeros past the last nonzero byte, or 9 for an empty one: each end is tried.
export async function decompress(bytes, format, { limit = Infinity } = {}) {
  checkBytes(bytes)
  const gzip = format === 'gzip'
  try {
    return await inflate(bytes, format, limit, gzip ? trailerSize(bytes, limit) : 0)
  } catch (error) {
    if (!gzip || !(error instanceof CompressionError) || error.limited || bytes.at(-1) !== 0) throw error
    const last = bytes.findLastIndex((byte) => byte !== 0)
    for (let end = last + 1; end <= Math.min(last + 10, bytes.length - 1); end++) {
      try {
        return await inflate(bytes.subarray(0, end), format, limit)
      } catch (retry) {
        if (!(retry instanceof CompressionError) || retry.limited) throw retry // past the bound at any end
      }
    }
    throw error
  }
}

// Bounded by and made into `into`, for zip's entries, which declare their size
export const decompressInto = (bytes, format, into) => through(bytes, DecompressionStream, format, into.length, 'decompress', into)
