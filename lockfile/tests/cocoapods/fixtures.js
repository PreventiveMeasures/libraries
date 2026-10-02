// The fixtures, in one file, fixtures.json.br, as
// scripts/record-cocoapods.js records them: by run, the Podfile.lock
// CocoaPods wrote, as `lock`, and the Podfile it was written for, as
// `podfile`, each as its text.
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

export const FIXTURES = JSON.parse(brotliDecompressSync(readFileSync(new URL('fixtures.json.br', import.meta.url))).toString('utf8'))
