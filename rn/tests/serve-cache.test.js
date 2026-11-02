import assert from 'node:assert/strict'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { bundleName, lastBuilds } from '../src/serve-cache.js'
import { writeTree } from './fixtures.js'

const request = (entryFile, platform, more = {}) => ({ kind: 'bundle', entryFile, platform, dev: true, minify: false, shallow: false, sourceUrl: 'http://localhost:8081/index.bundle', ...more })
const kept = ({ entryFile, platform, dev, minify }) => ({ kind: 'bundle', entryFile, platform, dev, minify, shallow: false })

describe('lastBuilds', () => {
  const { root, cleanup } = writeTree({})
  after(cleanup)
  // A dev bundler that has each request it is asked for, at once, as each
  // before it is done.
  const bundlerOf = () => {
    const asked = []
    let running = 0
    return {
      asked,
      files: () => new Set(['kept']),
      get: async (each) => {
        assert.equal(running++, 0, 'one at a time')
        asked.push(each)
        await new Promise((done) => {
          setImmediate(done)
        })
        running--
        return { ok: true }
      },
    }
  }
  const warmed = async (dir, project) => {
    const bundler = bundlerOf()
    const logged = []
    await lastBuilds(dir, project).warm(bundler, (line) => logged.push(line))
    return [bundler.asked, logged]
  }

  it("builds, as a run starts, the bundles an app asked for of the project's last run that served one, one after another", async () => {
    const dir = join(root, 'a')
    assert.deepEqual(await warmed(dir, '/app'), [[], []])
    const served = lastBuilds(dir, '/app').served(bundlerOf())
    for (const each of [request('./index', 'ios'), request('./index', 'ios', { kind: 'map' }), request('./index', 'ios', { shallow: true }), request('./index', 'android')]) await served.get(each)
    assert.deepEqual(served.files(), new Set(['kept']))
    const last = [kept(request('./index', 'ios')), kept(request('./index', 'android'))]
    assert.deepEqual(await warmed(dir, '/app'), [last, ['rn-serve: building ./index for ios, dev; ./index for android, dev ahead of the app, as its last run did']])
    // Of a run that served none, the last that did; of another project, its own.
    lastBuilds(dir, '/app')
    assert.deepEqual((await warmed(dir, '/app'))[0], last)
    assert.deepEqual((await warmed(dir, '/other'))[0], [])
    // Of a run that served one, its own alone.
    await lastBuilds(dir, '/app').served(bundlerOf()).get(request('./other', 'ios', { minify: true }))
    assert.deepEqual((await warmed(dir, '/app'))[0], [kept(request('./other', 'ios', { minify: true }))])
  })

  it('builds none of what is kept that is no request', async () => {
    const dir = join(root, 'b')
    await lastBuilds(dir, '/app').served(bundlerOf()).get(request('./index', 'ios'))
    const [name] = readdirSync(join(dir, 'builds'))
    writeFileSync(join(dir, 'builds', name), JSON.stringify([{ entryFile: '../../etc/passwd', platform: 'ios', dev: true, minify: false }, { entryFile: './index', platform: 1, dev: true, minify: false }, null, { entryFile: './index', platform: null, dev: false, minify: false }]))
    assert.deepEqual((await warmed(dir, '/app'))[0], [kept(request('./index', null, { dev: false }))])
    writeFileSync(join(dir, 'builds', name), '{')
    assert.deepEqual(await warmed(dir, '/app'), [[], []])
  })

  it('names a bundle by its entry, platform, dev and minify', () => {
    assert.deepEqual([bundleName(request('./index', 'ios')), bundleName(request('./index', null, { dev: false, minify: true }))], ['./index for ios, dev', './index for no platform, minified'])
  })
})
