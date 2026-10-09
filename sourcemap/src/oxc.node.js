import { createRequire } from 'node:module'

// Required on first use, as stasis does: reading a map never loads the
// native parser, only finding edges does. A missing one is the
// environment's error, not a file's, so it is thrown with an install hint
// rather than recorded as a file that would not parse.
let oxc
export function getParser() {
  if (oxc) return oxc
  try {
    oxc = createRequire(import.meta.url)('oxc-parser')
  } catch (cause) {
    throw new Error("@preventive/sourcemap/edges.js needs the optional 'oxc-parser' peer dependency; install it (e.g. `npm i oxc-parser`)", { cause })
  }
  return oxc
}
