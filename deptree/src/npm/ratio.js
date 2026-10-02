// The tar of npm 10.9.9 gives up on a gzipped tarball once what it has
// inflated is more than 1000 times what it has read, which it checks as
// each piece of output comes: so a tarball that inflates that far at any
// point fails npm, though it may inflate less in all. Where it reads the
// pieces from, and so where it checks, is not known here; so a tarball is
// refused that inflates 900 times its length at any prefix found below.
//
// The largest prefix that could inflate so far is no longer than 1/900 of
// all it inflates to, which the gzip trailer gives; and none can be longer
// than 1/900 of what that prefix inflates to, a bound that shrinks each
// time it is taken again, until it is too short to matter.

import { decompress } from '@preventive/archive/compression.js'
import { DeptreeError } from '../error.js'

const RATIO = 900
const STEPS = 64

// What the first `length` bytes inflate to, as far as they go.
async function inflated(bytes, length) {
  try {
    return (await decompress(bytes.subarray(0, length), 'gzip')).length
  } catch (error) {
    if (error?.bytes instanceof Uint8Array && !error.limited) return error.bytes.length
    throw error
  }
}

export async function checkRatio(bytes, where) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let bound = Math.floor(view.getUint32(bytes.length - 4, true) / RATIO)
  for (let step = 0; step < STEPS && bound > 0; step++) {
    const length = Math.min(bound, bytes.length)
    const out = await inflated(bytes, length)
    if (out >= RATIO * length) throw new DeptreeError(`the tarball inflates ${Math.floor(out / length)} times its first ${length} bytes, past what npm's tar gives up at`, where)
    const next = Math.floor(out / RATIO)
    if (next >= bound) break
    bound = next
  }
  if (bound > 0 && STEPS === 0) throw new DeptreeError('the tarball could not be held to what npm\'s tar gives up at', where)
}
