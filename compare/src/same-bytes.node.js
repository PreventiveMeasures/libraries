// same-bytes.js on Node, by its memcmp: three or four times as fast again
// past a few hundred bytes. The one module here only Node runs, as
// package.json imports picks it under the `node` condition.

import { Buffer } from 'node:buffer'

export const sameBytes = (x, y) => x.length === y.length && Buffer.compare(x, y) === 0
