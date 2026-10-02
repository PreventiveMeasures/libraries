// The fixtures scripts/record-composer.js records, in one file: a JSON
// object of each file's text by its name, compressed with brotli, as the
// lockfiles of one project are near alike and would be some ten thousand
// lines apart.
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

export const ARCHIVE = new URL('fixtures.json.br', import.meta.url)

const FILES = JSON.parse(brotliDecompressSync(readFileSync(ARCHIVE)).toString('utf8'))

export const fixtureNames = Object.keys(FILES)

export function fixture(name) {
  if (!Object.hasOwn(FILES, name)) throw new Error(`no fixture ${name}`)
  return FILES[name]
}
