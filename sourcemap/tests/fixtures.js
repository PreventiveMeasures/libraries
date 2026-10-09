// The fixtures, in one file: a JSON object of each file's text by its name,
// <bundle>/index.js and <bundle>/index.js.map, compressed with brotli.
//
// One project bundled five ways, every file of it carried in the maps'
// sourcesContent: src/index.js imports ./a.js (which imports ./b.js),
// ./side.js for its side effects, ./dead.js whose export it never uses,
// `dep` (ESM, importing ./util.js), `cjsdep` (CommonJS, requiring
// ./inner.js), and `ext`, which esbuild and rollup were told to leave out.
// Built into out/<bundle>/ beside src/ and node_modules/, by:
//   esbuild 0.28.2   src/index.js --bundle --format=esm --external:ext --sourcemap [--minify]
//   rollup 4.64.3    output.format es, sourcemap, external ext; node-resolve 16.0.3, commonjs 29.0.3
//   metro 0.87.1     runBuild, dev true (unminified) and dev false (minified), platform ios,
//                    experimentalImportSupport; absolute paths then rewritten to /app/.
import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { readSourceMap } from '@preventive/sourcemap'

export const ARCHIVE = new URL('fixtures.json.br', import.meta.url)

const FILES = JSON.parse(brotliDecompressSync(readFileSync(ARCHIVE)).toString('utf8'))

export function fixture(name) {
  if (!Object.hasOwn(FILES, name)) throw new Error(`no fixture ${name}`)
  return FILES[name]
}

// A bundle's code, and its map read.
export const bundle = (name) => [fixture(`${name}/index.js`), readSourceMap(fixture(`${name}/index.js.map`))]
