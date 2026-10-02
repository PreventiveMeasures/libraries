// The tar of npm 10.9.9 and 11.18 on gives up on a gzipped tarball once
// what it has inflated is more than 1000 times what it has read, which it
// checks as each piece of output comes: a tarball that inflates that far
// from some prefix fails npm, though it inflates less in all. Where the
// pieces it reads end, and so where it checks, is not known here; so a
// tarball is refused that inflates 900 times any prefix found below.
//
// No prefix that inflates so far is longer than 1/900 of what all of it
// inflates to; and none longer than 1/900 of what the longest such prefix
// could be inflates to, a bound that shrinks each time it is taken again.

import { decompress } from '@preventive/archive/compression.js'
import { DeptreeError } from '../error.js'

const RATIO = 900
const STEPS = 32

// What the first `length` bytes inflate to, as far as they go.
async function inflatedFrom(bytes, length) {
  try {
    return (await decompress(bytes.subarray(0, length), 'gzip')).length
  } catch (error) {
    if (error?.bytes instanceof Uint8Array && !error.limited) return error.bytes.length
    throw error
  }
}

// `inflated` is what all of `bytes` inflates to.
export async function checkRatio(bytes, inflated, where) {
  const refuse = (detail) => {
    throw new DeptreeError(`the tarball ${detail}, which npm's tar may give up at`, where)
  }
  if (inflated >= RATIO * bytes.length) refuse(`inflates ${Math.floor(inflated / bytes.length)} times its length`)
  let bound = Math.min(Math.floor(inflated / RATIO), bytes.length - 1)
  for (let step = 0; bound > 0; step++) {
    if (step === STEPS) refuse('inflates close to as far from some prefix')
    const out = await inflatedFrom(bytes, bound)
    if (out >= RATIO * bound) refuse(`inflates ${Math.floor(out / bound)} times its first ${bound} bytes`)
    bound = Math.min(Math.floor(out / RATIO), bound - 1)
  }
}
