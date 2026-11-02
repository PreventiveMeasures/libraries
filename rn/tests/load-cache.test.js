import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { after, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { loadCached, lowersLetOf } from '../src/bundle.js'
import { peers, projectBabel } from '../src/cli.js'
import { diskHost } from '../src/defaults.js'
import { createLoadCache, ownModules } from '../src/load-cache.js'
import { writeTree } from './fixtures.js'

const esbuild = createRequire(import.meta.url)('esbuild')
const modules = createRequire(import.meta.url).cache
const BABEL_CORE = `${sep}@babel${sep}core${sep}`
const fail = (message) => assert.fail(message)
const linked = (name) => ({ link: realpathSync(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url))) })
// A plugin of an output of its own each time it runs: one the same is kept.
const RANDOM = "module.exports = ({ types: t }, { tag = '' }) => ({ name: 'random', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral(tag + Math.random()))) } } } })\n"

// The records of a pack's segment (load-pack.js's): a key, its length, its JSON.
const recordsOf = (buffer) => {
  let count = 0
  for (let at = 0; at + 68 <= buffer.length; at += 68 + buffer.readUInt32LE(at + 64)) count++
  return count
}

// A project of these files and @babel/core, its cache in it, and a run of
// rn-serve on it: a target of its own, its own workers, a store of its
// own, a build of it started; `load(name, contents, options)` writes the
// file, and loads it as loadCached() does with the store; end() finishes
// the build, its pack written: -> its tally, but its time.
function projectOf(tree) {
  const { root, cleanup } = writeTree({ 'package.json': { name: 'app' }, 'node_modules/@babel/core': linked('@babel/core'), ...tree })
  const cacheDir = join(root, 'cache')
  const run = ({ platform = 'ios', dir = cacheDir, babel = true } = {}) => {
    // The project's own modules loaded anew, as by a run of its own, and
    // @babel/core, of what it has loaded of them, which transforms in band.
    for (const path of Object.keys(modules)) if (path.startsWith(`${root}${sep}`) || path.includes(BABEL_CORE)) delete modules[path]
    const target = babel ? projectBabel(root, peers(root, fail), fail, { fingerprint: true, maxWorkers: 1 })({ platform, dev: true }) : null
    const store = createLoadCache(dir, { esbuild, cwd: root })(target)
    // Its build started as it first loads, after a test has its target as it would.
    let started = false
    const load = (name, contents, options = {}) => {
      if (!started) store.start()
      started = true
      writeFileSync(join(root, name), contents)
      return loadCached({ esbuild, projectRoot: root, stripFlow: null, babel: target?.babel ?? null, babelPlugins: target?.babelPlugins ?? null, store, ...options }, diskHost, null, join(root, name))
    }
    const end = async () => {
      const { tally, written } = store.finish()
      await written
      const { ms: _ms, ...counts } = tally
      return counts
    }
    return { target, store, load, end }
  }
  // Each record of the packs, and each other file kept.
  const entries = () => {
    let count = 0
    for (const path of readdirSync(cacheDir, { recursive: true })) {
      const full = join(cacheDir, path)
      if (path.endsWith('.pack')) count += recordsOf(readFileSync(full))
      else if (!path.startsWith('packs') && statSync(full).isFile()) count++
    }
    return count
  }
  return { root, cleanup, run, entries }
}

describe('loadCached, with a store of load-cache.js', () => {
  const { root, cleanup, run, entries } = projectOf({
    'babel.config.json': { plugins: [['./random.cjs', { tag: 'a' }]] },
    'random.cjs': RANDOM,
    'sub/.keep': '',
    // A plugin a .babelrc of its own directory names, of a file it requires
    // as Babel makes it (in its factory, which Babel's partial config calls not).
    'nested/.babelrc': { plugins: ['../local.cjs'] },
    'local.cjs': "module.exports = ({ types: t }) => {\n  const helper = require('./helper.cjs')\n  return { name: 'local', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral(helper))) } } } }\n}\n",
    'helper.cjs': "module.exports = 'helped'\n",
  })
  after(cleanup)
  const contents = async (...args) => {
    const each = run()
    const loaded = await each.load(...args)
    await each.end()
    return loaded.contents
  }

  it('keeps each file as it loads, which a run after takes while its name and contents are the same, and counts each', async () => {
    const first = run()
    const loaded = await first.load('a.js', "import a from 'a'\na()")
    assert.match(loaded.contents, /^import a from "a";\na\(\);\n"a0\.\d+";$/u)
    assert.deepEqual(await first.end(), { hits: 0, misses: 1, memory: 0, unkept: {} })
    const second = run()
    assert.deepEqual(await second.load('a.js', "import a from 'a'\na()"), loaded)
    // As in memory, of the build.
    const memory = new Map()
    const options = { esbuild, projectRoot: root, stripFlow: null, babel: second.target.babel, babelPlugins: second.target.babelPlugins, store: second.store }
    await loadCached(options, diskHost, memory, join(root, 'a.js'))
    await loadCached(options, diskHost, memory, join(root, 'a.js'))
    assert.deepEqual(await second.end(), { hits: 2, misses: 0, memory: 1, unkept: {} })
    assert.notEqual(await contents('a.js', 'a()'), loaded.contents)
    writeFileSync(join(root, 'other.js'), "import a from 'a'\na()")
    assert.notEqual(await contents('other.js', "import a from 'a'\na()"), loaded.contents)
    // Three files, and the target's fingerprint.
    assert.equal(entries(), 4)
  })

  it("loads anew where the config Babel loads for the file changes, of a file it didn't load before too", async () => {
    const before = await contents('sub/b.js', 'b()')
    writeFileSync(join(root, 'babel.config.json'), JSON.stringify({ plugins: [['./random.cjs', { tag: 'changed' }]] }))
    const changed = await contents('sub/b.js', 'b()')
    assert.notEqual(changed, before)
    assert.match(changed, /"changed0\.\d+";$/u)
    // A .babelrc of its directory, whose options Babel takes over the config's.
    writeFileSync(join(root, 'sub/.babelrc'), JSON.stringify({ plugins: [['../random.cjs', { tag: 'sub' }]] }))
    assert.match(await contents('sub/b.js', 'b()'), /^b\(\);\n"sub0\.\d+";$/u)
    assert.equal(await contents('sub/b.js', 'b()'), await contents('sub/b.js', 'b()'))
  })

  it("loads anew where a plugin's code changes, or the target, asking its workers for its fingerprint then alone", async () => {
    const asked = (each) => {
      let count = 0
      const { fingerprint } = each.target
      each.target.fingerprint = () => {
        count++
        return fingerprint()
      }
      return () => count
    }
    const before = await contents('c.js', 'c()')
    const kept = run()
    const keptAsked = asked(kept)
    assert.equal((await kept.load('c.js', 'c()')).contents, before)
    assert.equal(keptAsked(), 0)
    writeFileSync(join(root, 'random.cjs'), `// Changed.\n${RANDOM}`)
    const changed = run()
    const changedAsked = asked(changed)
    assert.notEqual((await changed.load('c.js', 'c()')).contents, before)
    assert.equal(changedAsked(), 1)
    assert.notEqual((await run({ platform: 'android' }).load('c.js', 'c()')).contents, await contents('c.js', 'c()'))
  })

  it("loads anew where a plugin the file's own config names changes, or what it requires", async () => {
    // Its plugin after the config's, which Babel merges it into.
    assert.match(await contents('nested/g.js', 'g()'), /\n"helped";$/u)
    writeFileSync(join(root, 'helper.cjs'), "module.exports = 'changed'\n")
    assert.match(await contents('nested/g.js', 'g()'), /\n"changed";$/u)
  })

  it('keeps each as --esm loads it apart: an ES module, or one left CommonJS', async () => {
    const plain = await contents('d.js', 'd()')
    const esModule = await contents('d.js', 'd()', { esm: new Set() })
    assert.notEqual(esModule, plain)
    assert.notEqual(await contents('d.js', 'd()', { esm: new Set([join(root, 'd.js')]) }), esModule)
    assert.equal(await contents('d.js', 'd()'), plain)
    assert.equal(await contents('d.js', 'd()', { esm: new Set() }), esModule)
  })

  it("keeps what is of the entry's config, as lowersLetOf() has it, which a run after then loads none of", async () => {
    writeFileSync(join(root, 'index.js'), '')
    const options = (each) => ({ babel: each.target.babel, babelPlugins: each.target.babelPlugins, projectRoot: root, entry: 'index.js', store: each.store })
    const first = run()
    assert.equal(await lowersLetOf(options(first)), false)
    const second = run()
    second.target.babelPlugins = () => assert.fail('the config loaded')
    assert.equal(await lowersLetOf(options(second)), false)
  })

  it("loads, though the cache can't be written", async () => {
    const blocked = join(root, 'blocked')
    // Its packs' directory a file, and each other entry's.
    mkdirSync(blocked)
    for (const name of ['packs', ...Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'))]) writeFileSync(join(blocked, name), '')
    const each = run({ dir: blocked })
    assert.match((await each.load('i.js', 'i()')).contents, /^i\(\);\n"/u)
    assert.deepEqual(await each.end(), { hits: 0, misses: 1, memory: 0, unkept: {} })
  })

  it('keeps none that fails, nor any of a target with no fingerprint, and counts each, and why', async () => {
    const count = entries()
    const failing = run()
    assert.equal((await failing.load('f.js', 'const = 1')).errors.length, 1)
    assert.deepEqual(await failing.end(), { hits: 0, misses: 1, memory: 0, unkept: { failed: 1 } })
    assert.equal(entries(), count)
    const unprinted = run()
    unprinted.target.fingerprint = () => Promise.reject(new Error('no fingerprint'))
    unprinted.target.workerOptions = { other: true }
    await unprinted.load('g.js', 'g()')
    assert.deepEqual(await unprinted.end(), { hits: 0, misses: 1, memory: 0, unkept: { fingerprint: 1 } })
    assert.equal(entries(), count)
  })

  it('keeps each file as it loads without Babel too: its Flow stripped, by flow-remove-types', async () => {
    let stripped = 0
    const stripFlow = (source) => {
      stripped++
      return source.replace(': number', '')
    }
    const flow = '// @flow\nconst n: number = 1\n'
    const before = run({ babel: false })
    const first = await before.load('flow.js', flow, { stripFlow })
    await before.end()
    assert.deepEqual([first.contents, stripped], ['// @flow\nconst n = 1\n', 1])
    assert.deepEqual(await run({ babel: false }).load('flow.js', flow, { stripFlow }), first)
    assert.equal(stripped, 1)
  })
})

describe('loadCached, with a store, of a plugin a .babelrc has of options of its own', () => {
  // A plugin of the helper its options pick, required in its factory, of
  // the root's config, and of a .babelrc of other options.
  const { root, cleanup, run } = projectOf({
    'babel.config.json': { plugins: [['./picks.cjs', { pick: 'a' }]] },
    'optioned/.babelrc': { plugins: [['../picks.cjs', { pick: 'b' }]] },
    'picks.cjs': "module.exports = ({ types: t }, { pick }) => {\n  const value = require(`./pick-${pick}.cjs`)\n  return { name: 'picks', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral(value))) } } } }\n}\n",
    'pick-a.cjs': "module.exports = 'a'\n",
    'pick-b.cjs': "module.exports = 'b'\n",
  })
  after(cleanup)
  const contents = async (...args) => {
    const each = run()
    const loaded = await each.load(...args)
    await each.end()
    return loaded.contents
  }

  it('loads anew where what the plugin requires of those options changes', async () => {
    assert.equal(await contents('optioned/x.js', 'x()'), 'x();\n"b";')
    assert.equal(await contents('y.js', 'y()'), 'y();\n"a";')
    writeFileSync(join(root, 'pick-b.cjs'), "module.exports = 'b2'\n")
    assert.equal(await contents('optioned/x.js', 'x()'), 'x();\n"b2";')
    assert.equal(await contents('y.js', 'y()'), 'y();\n"a";')
    writeFileSync(join(root, 'pick-a.cjs'), "module.exports = 'a2'\n")
    assert.equal(await contents('y.js', 'y()'), 'y();\n"a2";')
  })
})

describe('loadCached, with a store, of a config of what it reads as it loads', () => {
  const { root, cleanup, run, entries } = projectOf({
    // A config of a function of what it reads as it loads, and of whether a file is there.
    'babel.config.js': "const { existsSync, readFileSync } = require('node:fs')\nconst data = readFileSync(__dirname + '/data.txt', 'utf8').trim() + (existsSync(__dirname + '/flag') ? '!' : '')\nmodule.exports = { plugins: [['./calls.cjs', { value: () => data }]], overrides: [{ test: /external/u, plugins: ['./external.cjs'] }] }\n",
    'calls.cjs': "module.exports = ({ types: t }, { value }) => ({ name: 'calls', visitor: { Program: { exit(path) { path.pushContainer('body', t.expressionStatement(t.stringLiteral(value()))) } } } })\n",
    'data.txt': 'one\n',
    // As random, but its output of a file it names, which may change.
    'external.cjs': "module.exports = (api) => { api.cache.never(); api.addExternalDependency(__dirname + '/dep.txt'); return { name: 'external', visitor: { Program: { exit(path) { path.pushContainer('body', api.types.expressionStatement(api.types.stringLiteral(String(Math.random())))) } } } } }\n",
  })
  after(cleanup)
  const contents = async (...args) => {
    const each = run()
    const loaded = await each.load(...args)
    await each.end()
    return loaded.contents
  }

  it('loads anew where what the config read or looked for as it loaded changes, which a function of its options may keep', async () => {
    assert.equal(await contents('h.js', 'h()'), 'h();\n"one";')
    assert.equal(await contents('h.js', 'h()'), 'h();\n"one";')
    writeFileSync(join(root, 'data.txt'), 'two\n')
    assert.equal(await contents('h.js', 'h()'), 'h();\n"two";')
    writeFileSync(join(root, 'flag'), '')
    assert.equal(await contents('h.js', 'h()'), 'h();\n"two!";')
  })

  it("keeps none of a plugin's of files it names", async () => {
    const count = entries()
    assert.notEqual(await contents('external.js', 'e()'), await contents('external.js', 'e()'))
    assert.equal(entries(), count)
    const each = run()
    await each.load('external.js', 'e()')
    assert.deepEqual(await each.end(), { hits: 0, misses: 1, memory: 0, unkept: { external: 1 } })
  })
})

describe('ownModules', () => {
  it("has rn's code each kept file is of: the chain's, and each of rn's modules it imports", () => {
    const src = fileURLToPath(new URL('../src/', import.meta.url))
    assert.deepEqual(ownModules(), ['assets.js', 'babel-transformer.js', 'babel-worker.js', 'babelrc.js', 'bundle.js', 'defaults.js', 'exports.js', 'image-size.js', 'load-cache.js', 'load-pack.js', 'load.js', 'mappings.js', 'modules.js', 'resolve.js', 'serializer.js', 'worklets.js'].map((name) => join(src, name)))
  })
})
