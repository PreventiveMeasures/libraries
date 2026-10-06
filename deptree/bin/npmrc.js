// The npm registry's token from ~/.npmrc, for bin/deptree.js alone: the
// library reads no .npmrc but the project's.

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'

// A line of nothing but the registry's token, as `npm login` writes it.
const TOKEN_LINE = /^\/\/registry\.npmjs\.org\/:_authToken=(npm_[\dA-Za-z]+)$/u

// The last such line's, as npm takes the last of a key.
export const tokenIn = (text) => text.split(/\r?\n/u).map((line) => TOKEN_LINE.exec(line)?.[1]).findLast((token) => token !== undefined)

export function userToken(home = homedir()) {
  if (!isAbsolute(home)) return undefined
  try {
    return tokenIn(readFileSync(join(home, '.npmrc'), 'utf8'))
  } catch {
    return undefined
  }
}
