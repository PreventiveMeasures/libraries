// tar 7.5.19 on gives up once what it has inflated is over 1000 times what
// it has read, checked at each piece of output, so where depends on how the
// bytes arrive: a tarball is refused if any prefix inflates 900 times. Such
// a prefix is no longer than 1/900 of what all of it, or any longer prefix,
// inflates to: a bound that shrinks each time it is taken again.

import { decompress } from '@preventive/archive/compression.js'
import { DeptreeError } from '../error.js'

const RATIO = 900
const STEPS = 32

async function inflatedFrom(bytes, length) {
  try {
    return (await decompress(bytes.subarray(0, length), 'gzip')).length
  } catch (error) {
    if (error?.bytes instanceof Uint8Array && !error.limited) return error.bytes.length
    throw error
  }
}

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
