// The npm registry's token from the user's ~/.npmrc, for `bin/deptree.js`
// alone. Not part of the published package: the library reads no .npmrc
// but the project's, and takes the token from NPM_TOKEN.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// A line that is nothing but the registry's token, as `npm login` writes
// it: no other key, no other registry, no placeholder for one, and nothing
// around it.
const TOKEN_LINE = /^\/\/registry\.npmjs\.org\/:_authToken=(npm_[\dA-Za-z]+)$/u

// The last such line's token, as npm takes the last of a key; or undefined.
export const tokenIn = (text) => text.split(/\r?\n/u).map((line) => TOKEN_LINE.exec(line)?.[1]).findLast((token) => token !== undefined)

// From `home`/.npmrc, where there is one to read.
export function userToken(home = homedir()) {
  if (!isAbsolute(home)) return undefined
  try {
    return tokenIn(readFileSync(join(home, '.npmrc'), 'utf8'))
  } catch {
    return undefined
  }
}
