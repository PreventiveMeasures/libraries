// What scripts/record-pnpm-13.js records, by `<project>@<pnpm>`: each a
// lockfile of 13.0 pnpm wrote, `lockfile`, and what pnpm read it as,
// `read`, in one JSON object, brotli-compressed, in fixtures.json.br.
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'

const FIXTURES_FILE = new URL('fixtures.json.br', import.meta.url)

export const FIXTURES = JSON.parse(brotliDecompressSync(readFileSync(FIXTURES_FILE)).toString('utf8'))
