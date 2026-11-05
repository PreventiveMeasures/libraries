// The fixtures, in one file, fixtures.json.br, as scripts/record-swiftpm.js
// records them: by run, the Package.resolved SwiftPM wrote, as `resolved`,
// and the root's manifest it was written for, as `manifest`, each as its
// text.
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

export const FIXTURES = JSON.parse(brotliDecompressSync(readFileSync(new URL('fixtures.json.br', import.meta.url))).toString('utf8'))
