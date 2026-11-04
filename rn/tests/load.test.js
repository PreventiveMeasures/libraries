import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { createRequire } from 'node:module'
import { describe, it } from 'node:test'

import { loadFile } from '../src/load.js'

const require = createRequire(import.meta.url)
const stripFlow = (source) => require('flow-remove-types')(source, { all: true, removeEmptyImports: true }).toString()

for (const name of ['esbuild', 'esbuild-0.25']) {
  const esbuild = require(name)
  describe(`loading for Babel with ${name}`, () => {
    const load = async (contents, options = {}, file = '/app/index.js') => {
      const transformed = []
      let input
      const result = await loadFile({
        projectRoot: '/app',
        esbuild: { ...esbuild, transform: (code, flags) => (transformed.push(code), esbuild.transform(code, flags)) },
        stripFlow,
        babel: (code, path, without) => (input = { code, path, without }, code),
        babelPlugins: () => new Map([['syntax-flow', {}]]),
        ...options,
      }, file, contents)
      return { result, input, transformed }
    }

    it('parses ordinary JavaScript and stripped, annotated Flow only once before Babel', async () => {
      for (const source of ['export const value = <Text>hello</Text>\n', '// @flow\nexport const value: number = 42\n']) {
        const { result, input, transformed } = await load(source)
        assert.equal(transformed.length, 1)
        assert.equal(result.contents, input.code)
        assert.equal(input.path, '/app/index.js')
        assert.ok(input.without.includes('syntax-flow'))
        assert.ok(!input.code.includes(': number'))
      }
    })

    it('still detects and strips Flow without a pragma', async () => {
      const { input } = await load('export const value: number = 42\n')
      assert.match(input.code, /export const value = 42/u)
      assert.ok(input.without.includes('syntax-flow'))
    })

    it('lowers TSX without a JSX opener once, dropping type-only React use and preserving code and maps', async () => {
      const source = "import React from 'react'\nexport type Element = React.ReactElement\nexport const value: number = 42\n"
      const path = '/app/index.tsx'
      for (const sourcemap of [false, true]) {
        const { result, input, transformed } = await load(source, { sourcemap }, path)
        const expected = await esbuild.transform(source, {
          loader: 'tsx', jsx: 'preserve', sourcefile: path, logLevel: 'silent',
          supported: { 'class-static-blocks': false, using: false, decorators: false },
          tsconfigRaw: { compilerOptions: { useDefineForClassFields: false } },
          ...(sourcemap && { sourcemap: 'external' }),
        })
        const code = sourcemap ? `${expected.code}//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(expected.map).toString('base64')}\n` : expected.code
        assert.deepEqual(transformed, [source])
        assert.equal(result.contents, code)
        assert.equal(input.code, code)
        assert.ok(!expected.code.includes('react'))
      }
    })

    it('still distinguishes JSX from generic syntax in TSX before deciding whether to retain React', async () => {
      const cases = [
        ['export const view = () => <Text>hello</Text>', 2, true],
        ['export const identity = <T,>(value: T) => value', 3, false],
      ]
      for (const [body, count, react] of cases) {
        const { input, transformed } = await load(`import React from 'react'\n${body}\n`, {}, '/app/index.tsx')
        assert.equal(transformed.length, count)
        assert.equal(input.code.includes('from "react"'), react)
      }
    })

    it('leaves executable Flow and its pragma to the Babel config', async () => {
      const source = '// @flow\nenum Status { Ready, Done }\nexport const status: Status = Status.Ready\n'
      const { input } = await load(source)
      assert.equal(input.code, source)
      assert.ok(!input.without.includes('syntax-flow'))
    })

    it('preserves JSX pragmas, Flow calls without a stripper, decorators and codegen types', async () => {
      const cases = [
        ['/** @jsx h */\nexport const view = <Text />\n', {}],
        ['// @flow\nexport const value = f<T>(x)\n', { stripFlow: null }],
        ['class Model { @field title }\nexport default Model\n', {}],
        ["export default codegenNativeComponent<Props>('View')\n", {}],
      ]
      for (const [source, options] of cases) {
        const { input } = await load(source, options)
        assert.equal(input.code, source)
        assert.ok(!input.without.includes('syntax-flow'))
      }
    })

    it('lets Babel report unsupported syntax using the original source', async () => {
      const source = 'export const value = (\n'
      const { input } = await load(source)
      assert.equal(input.code, source)
      assert.ok(!input.without.includes('syntax-flow'))
    })
  })
}
