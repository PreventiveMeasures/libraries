// An .npmrc as the `ini` package reads it for npm and pnpm, as far as a key
// and the text after its `=` go; each settings.js refuses a value ini would
// unquote, unescape, cut at a `;` or `#`, or fill in from the environment. A
// section, which npm reads under a prefix no setting here has, is refused.

import { DeptreeError } from './error.js'

export function parseNpmrc(text) {
  const settings = []
  const lines = text.split(/\r\n|\r|\n/u)
  for (const [index, raw] of lines.entries()) {
    const line = raw.trim()
    const where = `.npmrc:${index + 1}`
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    if (line.startsWith('[')) throw new DeptreeError('a section is not supported', where)
    const eq = line.indexOf('=')
    let key = (eq === -1 ? line : line.slice(0, eq)).trim()
    const value = eq === -1 ? 'true' : line.slice(eq + 1).trim()
    const list = key.length > 2 && key.endsWith('[]')
    if (list) key = key.slice(0, -2)
    if (key === '') throw new DeptreeError('a setting has no name', where)
    settings.push({ key, value, list, line: index + 1 })
  }
  return settings
}
