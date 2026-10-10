import { createRequire } from 'node:module'

// Required on first use, as stasis does. A missing one is the
// environment's error, not a file's that would not parse.
let oxc
export function getParser() {
  try {
    return (oxc ??= createRequire(import.meta.url)('oxc-parser'))
  } catch (cause) {
    throw new Error("@preventive/sourcemap/edges.js needs the optional 'oxc-parser' peer dependency; install it (e.g. `npm i oxc-parser`)", { cause })
  }
}
