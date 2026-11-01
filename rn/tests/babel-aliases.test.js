import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { createAliases } from '../babel-aliases.js'

const { resolvePath } = createRequire(import.meta.url)('babel-plugin-module-resolver')

describe('createAliases', () => {
  it('maps as babel-plugin-module-resolver\'s resolvePath does', () => {
    const cwd = '/p'
    const alias = {
      '#local': './src', '#up': '../shared', 'lodash': 'lodash-es', '^@(.+)/(.+)$': './lib/\\1/\\2', '^~(.*)': './src\\1',
      'idx': './src/index', 'empty': '', 'same': 'same', 'dot.name': './dot', 'x$': './exact',
    }
    const aliases = createAliases(alias, cwd)
    const specifiers = ['#local', '#local/abc', '#localx', '#up/y', 'lodash', 'lodash/fp', '@a/b', '@a/b/c', '~/x', '~', 'idx', 'empty', 'same', 'dot.name', 'dotxname', 'x', './rel', '../rel', 'none']
    // The plugin warns of a package it can't find, outside production.
    const { NODE_ENV } = process.env
    process.env.NODE_ENV = 'production'
    try {
      for (const file of ['/p/index.js', '/p/src/a/b.js', '/q/other.js']) {
        for (const specifier of specifiers) {
          const mapped = resolvePath(specifier, file, { cwd, alias })
          assert.equal(aliases(file, specifier), mapped && mapped !== specifier ? mapped : null, `${specifier} from ${file}`)
        }
      }
    } finally {
      if (NODE_ENV === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = NODE_ENV
    }
  })

  it('refuses what isn\'t aliases to strings, and an invalid regular expression', () => {
    for (const alias of [null, ['./src'], { a: 1 }]) {
      assert.throws(() => createAliases(alias, '/p'), { name: 'TypeError', message: 'alias must be an object mapping each alias to a string' })
    }
    assert.throws(() => createAliases({ '^(': './src' }, '/p'), { name: 'SyntaxError', message: '"^(" is not a valid regular expression' })
  })
})
