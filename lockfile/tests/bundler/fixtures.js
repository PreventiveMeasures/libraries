// The lockfiles scripts/record-bundler.js records, by name, `bundler-4.0.22`:
// one JSON object of their texts, brotli-compressed, in fixtures.json.br.
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

const FIXTURES_FILE = new URL('fixtures.json.br', import.meta.url)

export const FIXTURES = JSON.parse(brotliDecompressSync(readFileSync(FIXTURES_FILE)).toString('utf8'))
