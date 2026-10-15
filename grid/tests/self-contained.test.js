import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// grid/ is built on @preventive/ai and nothing else: node builtins, that package, and its own
// modules. Nothing in it may reach into a sibling package by path -- a single `../` is all it
// takes, and it reads as harmless in a diff -- so the boundary is enforced here rather than left
// to review, the way ai/ enforces its own.
const GRID_DIR = new URL('../', import.meta.url)
const SRC_DIR = new URL('src/', GRID_DIR)

const sourced = (name) => name.endsWith('.js') || name.endsWith('.d.ts')

const files = [
  new URL('index.js', GRID_DIR),
  new URL('index.d.ts', GRID_DIR),
  ...readdirSync(SRC_DIR, { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter(sourced)
    .map((name) => new URL(name, SRC_DIR)),
]

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)['"]([^'"]+)['"]/gu

const allowed = (specifier) => specifier.startsWith('node:') || specifier === '@preventive/ai' || specifier.startsWith('./')

describe('grid is self-contained', () => {
  it('covers the surface and every module behind it', () => {
    assert.ok(files.length >= 12, `expected the surface and the modules, found ${files.length} files`)
  })

  for (const file of files) {
    it(`${file.pathname.slice(GRID_DIR.pathname.length)} imports only node:, @preventive/ai and its own modules`, () => {
      const source = readFileSync(file, 'utf8')
      const specifiers = [...source.matchAll(SPECIFIER)].map((match) => match[1])
      const outside = specifiers.filter((specifier) => !allowed(specifier))
      assert.deepEqual(outside, [], `reaches outside the package: ${outside.join(', ')}`)
      // One more thing a relative specifier can do: climb out of src/. index.js imports ./src/...,
      // src/ modules import ./sibling; neither may say `..`.
      assert.deepEqual(specifiers.filter((specifier) => specifier.includes('..')), [])
    })
  }
})
