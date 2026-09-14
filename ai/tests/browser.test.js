import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { sep } from 'node:path'
import { describe, it } from 'node:test'

// The three modules that exist twice: once for Node, once for a page, chosen by the `browser`
// condition on a `#` subpath import. What makes that work is not the files themselves but the
// agreement between them — same names exported, same specifier, both shipped — and none of it is
// visible at a call site, which imports `#env` and gets whichever one the build resolved.
//
// So this file checks the seam rather than the implementations: that the pairs are declared, that
// both halves are in the package, that everything a caller imports through a `#` specifier is
// exported by BOTH halves, and that the browser halves touch nothing a page does not have. A
// mismatch is otherwise invisible until a bundle is loaded in a browser, which is not where this
// repo's tests run.
const AI_DIR = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', AI_DIR), 'utf8'))
const shipped = new Set(manifest.files)

const specifiers = Object.keys(manifest.imports ?? {})

// Every module in the layer, plus the front door: where a `#` specifier can be imported from.
const sourceFiles = [
  new URL('index.js', AI_DIR),
  ...readdirSync(new URL('src/', AI_DIR), { recursive: true })
    .map((name) => name.split(sep).join('/'))
    .filter((name) => name.endsWith('.js'))
    .map((name) => new URL(`src/${name}`, AI_DIR)),
]

// `import { a, b } from '#spec'` — the names a build has to find on whichever half it resolved.
const IMPORTED_RE = /import\s*\{(?<names>[^}]*)\}\s*from\s*'(?<spec>#[^']+)'/gu

function importedNames() {
  const wanted = new Map(specifiers.map((spec) => [spec, new Set()]))
  for (const file of sourceFiles) {
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORTED_RE)) {
      const names = wanted.get(m.groups.spec)
      assert.ok(names, `${file.href} imports ${m.groups.spec}, which package.json declares no target for`)
      for (const name of m.groups.names.split(',')) {
        const bare = name.trim().split(/\s+as\s+/u)[0].trim()
        if (bare) names.add(bare)
      }
    }
  }
  return wanted
}

describe('the browser/Node module pairs are declared and shipped', () => {
  it('declares a pair for each swapped module', () => {
    assert.deepEqual(specifiers.toSorted(), ['#chrome', '#env', '#fetch', '#fs'])
  })

  for (const spec of specifiers) {
    const targets = manifest.imports[spec]

    it(`${spec} names a browser half and a default half`, () => {
      assert.deepEqual(Object.keys(targets).toSorted(), ['browser', 'default'])
    })

    for (const [condition, target] of Object.entries(targets)) {
      it(`${spec} (${condition}) -> ${target} exists and is shipped`, () => {
        const name = target.replace(/^\.\//u, '')
        // Readable, so a typo'd target is caught here rather than at a bundler.
        assert.ok(readFileSync(new URL(name, AI_DIR), 'utf8').length > 0, `${target} is empty`)
        assert.ok(shipped.has(name), `${name} is an import target but not in package.json files`)
      })
    }
  }
})

describe('both halves export what callers import through the specifier', () => {
  for (const [spec, names] of importedNames()) {
    it(`${spec} is imported for ${[...names].join(', ') || 'nothing'}`, () => {
      // A specifier nothing imports is dead wiring; the point of the pair is the call sites.
      assert.ok(names.size > 0, `${spec} is declared but imported nowhere`)
    })

    for (const [condition, target] of Object.entries(manifest.imports[spec])) {
      it(`${spec} (${condition}) exports every name`, async () => {
        const mod = await import(new URL(target.replace(/^\.\//u, ''), AI_DIR).href)
        for (const name of names) {
          assert.ok(name in mod, `${target} does not export ${name}, which a caller imports from ${spec}`)
        }
      })
    }
  }
})

// What makes a browser half a browser half. Comments are stripped first: these files EXPLAIN that
// `process` is absent and why, and a scan that reads prose as code would forbid saying so.
const withoutComments = (source) => source.replaceAll(/^\s*\/\/.*$/gmu, '')

const NODE_ONLY = /\b(?:process|Buffer|__dirname|__filename|require)\b/u

describe('the browser halves reach for nothing a page lacks', () => {
  for (const spec of specifiers) {
    const target = manifest.imports[spec].browser
    const source = withoutComments(readFileSync(new URL(target.replace(/^\.\//u, ''), AI_DIR), 'utf8'))

    it(`${target} imports no node: builtin`, () => {
      assert.doesNotMatch(source, /from\s*'node:/u, `${target} imports a node: builtin`)
    })

    it(`${target} names no Node-only global`, () => {
      assert.doesNotMatch(source, NODE_ONLY, `${target} names a Node-only global`)
    })
  }
})

describe('#env', () => {
  it('reads the environment under Node', async () => {
    const { env } = await import('#env')
    process.env.AI_ENV_SEAM_PROBE = 'set'
    try {
      assert.equal(env('AI_ENV_SEAM_PROBE'), 'set')
    } finally {
      delete process.env.AI_ENV_SEAM_PROBE
    }
  })

  it('resolves to the Node half here, not the browser one', async () => {
    assert.equal((await import('#env')).env, (await import('../src/env.js')).env)
  })

  it('reads as unset for everything in a browser', async () => {
    const { env } = await import('../src/env.browser.js')
    process.env.AI_ENV_SEAM_PROBE = 'set'
    try {
      assert.equal(env('AI_ENV_SEAM_PROBE'), undefined)
      assert.equal(env('PATH'), undefined)
      assert.equal(env(), undefined)
    } finally {
      delete process.env.AI_ENV_SEAM_PROBE
    }
  })
})

describe('#fetch', () => {
  it('resolves to the undici transport here', async () => {
    assert.equal((await import('#fetch')).fetch, (await import('../src/fetch.js')).fetch)
  })

  it('the browser transport passes the call to the page fetch, options and all', async () => {
    const { fetch } = await import('../src/fetch.browser.js')
    const calls = []
    const original = globalThis.fetch
    // Restored rather than left patched: fetch-json.test.js drives real requests through undici.
    globalThis.fetch = (url, options) => {
      calls.push([url, options])
      return 'response'
    }
    try {
      // No dispatcher of its own, unlike the Node half — whatever the caller passed and nothing else.
      assert.equal(fetch('https://example.invalid/v1', { method: 'POST' }), 'response')
    } finally {
      globalThis.fetch = original
    }
    assert.deepEqual(calls, [['https://example.invalid/v1', { method: 'POST' }]])
  })
})

describe('#chrome', () => {
  it('resolves to the real provider here', async () => {
    const { CHROME_ADAPTER } = await import('#chrome')
    assert.equal(CHROME_ADAPTER, (await import('../src/chrome/index.js')).CHROME_ADAPTER)
    // The wire format the browser half does without, which is how the two are told apart.
    assert.equal(typeof CHROME_ADAPTER.buildRequestBody, 'function')
  })

  it('refuses at selection in a browser, naming the reason', async () => {
    const { CHROME_ADAPTER } = await import('../src/chrome/browser.js')
    // Prices a turn at zero either way: whatever answers in a page, it is not billed per token.
    assert.equal(CHROME_ADAPTER.runsLocally, true)
    for (const method of ['preflight', 'send']) {
      assert.throws(() => CHROME_ADAPTER[method](), /not available in a browser build yet/u, method)
      assert.throws(() => CHROME_ADAPTER[method](), /LanguageModel/u, method)
    }
  })

  it('closes quietly in a browser, holding nothing open', async () => {
    const { CHROME_ADAPTER } = await import('../src/chrome/browser.js')
    // closeProvider() closes EVERY adapter rather than the selected one, so this is reached on a page
    // that never touched chrome. A throw here would turn an unconditional cleanup call into a crash.
    await assert.doesNotReject(async () => await CHROME_ADAPTER.close())
  })
})
