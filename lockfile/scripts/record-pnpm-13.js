// Records lockfiles of `lockfileVersion: '13.0'` that pnpm 12.19.0, 12.20.0
// and 12.21.0 write with `lockfile.format: v13` for the projects below, and
// what pnpm reads each as, into tests/pnpm-13/fixtures.json.br. Needs npm
// and network access to the npm registry:
//
//     node lockfile/scripts/record-pnpm-13.js
//
// Each project gives the format's peers something to say: a package with
// two sets of peers, in two projects; the same of an injected directory; a
// peer below a package that it does not declare, bound in one project and
// not in the other; a package whose dependency has it as a peer; a cycle of
// peers, with a patch beside it and without; a peer a linked project
// provides, under an alias; peers hashed past peersSuffixMaxLength;
// dedupePeers; optional peers, bound and missing; and a stack of React
// libraries in two projects of two Reacts, whose scopes leave some
// references to name their snapshots by their bindings. Each is installed,
// and then again from the lockfile alone, frozen, which leaves what pnpm
// read it as in node_modules/.pnpm/lock.yaml, in v9's shape: the fixture
// holds both texts, `lockfile` and `read`, by `<project>@<pnpm>`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliCompressSync } from 'node:zlib'

const OUT = new URL('../tests/pnpm-13/fixtures.json.br', import.meta.url)
const VERSIONS = ['12.19.0', '12.20.0', '12.21.0']

const json = (value) => `${JSON.stringify(value, null, 2)}\n`
const manifest = (name, fields = {}) => json({ name, version: '1.0.0', private: true, ...fields })
const WORKSPACE = 'packages:\n  - p/*\n'

const PATCH = `diff --git a/index.js b/index.js
--- a/index.js
+++ b/index.js
@@ -2,7 +2,7 @@
  * is-number <https://github.com/jonschlinkert/is-number>
  *
  * Copyright (c) 2014-present, Jon Schlinkert.
- * Released under the MIT License.
+ * Released under the MIT License. Patched.
  */

 'use strict';
`

const NEST = { '@nestjs/core': '10.3.8', '@nestjs/common': '10.3.8', '@nestjs/platform-express': '10.3.8', 'reflect-metadata': '0.2.2', rxjs: '7.8.1' }
const REACT = { 'react-transition-group': '4.4.5', react: '18.2.0', 'react-dom': '18.2.0' }
const UI = { '@mui/material': '5.15.15', '@emotion/react': '11.11.4', '@emotion/styled': '11.11.5', 'react-router-dom': '6.23.0', formik: '2.4.6' }

const PROJECTS = {
  variants: {
    'package.json': manifest('variants'),
    'pnpm-workspace.yaml': WORKSPACE,
    'p/a/package.json': manifest('a', { dependencies: { react: '17.0.2', 'react-dom': '17.0.2', 'react-transition-group': '4.4.5', shared: 'workspace:*' } }),
    'p/b/package.json': manifest('b', { dependencies: { react: '18.2.0', 'react-dom': '18.2.0', 'react-transition-group': '4.4.5', shared: 'workspace:*' } }),
    'p/shared/package.json': manifest('shared', { dependencies: { 'react-transition-group': '4.4.5' }, peerDependencies: { react: '*', 'react-dom': '*' } }),
  },
  injected: {
    'package.json': manifest('injected'),
    'pnpm-workspace.yaml': WORKSPACE,
    'p/a/package.json': manifest('a', { dependencies: { react: '17.0.2', shared: 'workspace:*' }, dependenciesMeta: { shared: { injected: true } } }),
    'p/b/package.json': manifest('b', { dependencies: { react: '18.2.0', shared: 'workspace:*' }, dependenciesMeta: { shared: { injected: true } } }),
    'p/shared/package.json': manifest('shared', { peerDependencies: { react: '*' }, devDependencies: { react: '18.2.0' } }),
  },
  transitive: {
    'package.json': manifest('transitive'),
    'pnpm-workspace.yaml': WORKSPACE,
    'p/a/package.json': manifest('a', { dependencies: { '@typescript-eslint/utils': '5.62.0', eslint: '8.57.0', typescript: '5.4.5' } }),
    'p/b/package.json': manifest('b', { dependencies: { '@typescript-eslint/utils': '5.62.0', eslint: '8.57.0' } }),
  },
  cycle: {
    'package.json': manifest('cycle', { dependencies: { 'styled-components': '5.3.11', react: '18.2.0', 'react-dom': '18.2.0', 'react-is': '18.2.0' } }),
  },
  nest: {
    'package.json': manifest('nest', { dependencies: NEST }),
  },
  nestpatched: {
    'package.json': manifest('nestpatched', { dependencies: { ...NEST, 'is-number': '7.0.0' } }),
    'pnpm-workspace.yaml': 'patchedDependencies:\n  is-number@7.0.0: patches/is-number.patch\n',
    'patches/is-number.patch': PATCH,
  },
  linked: {
    'package.json': manifest('linked', { dependencies: { react: 'workspace:*', 'react-dom': '18.2.0', rtg: 'npm:react-transition-group@4.4.5' } }),
    'pnpm-workspace.yaml': WORKSPACE,
    'p/react/package.json': json({ name: 'react', version: '18.2.0' }),
  },
  hashed: {
    'package.json': manifest('hashed', { dependencies: REACT }),
    'pnpm-workspace.yaml': 'peersSuffixMaxLength: 30\n',
  },
  dedupe: {
    'package.json': manifest('dedupe', { dependencies: REACT }),
    'pnpm-workspace.yaml': 'dedupePeers: true\n',
  },
  stack: {
    'package.json': manifest('stack'),
    'pnpm-workspace.yaml': WORKSPACE,
    'p/a/package.json': manifest('a', {
      dependencies: { ...UI, react: '18.2.0', 'react-dom': '18.2.0', '@tanstack/react-query': '5.32.0', 'react-redux': '9.1.1', '@reduxjs/toolkit': '2.2.3' },
      devDependencies: { '@testing-library/react': '15.0.5', eslint: '8.57.0', '@typescript-eslint/eslint-plugin': '7.8.0', '@typescript-eslint/parser': '7.8.0', typescript: '5.4.5', vite: '5.2.10', '@vitejs/plugin-react': '4.2.1' },
    }),
    'p/b/package.json': manifest('b', {
      dependencies: { ...UI, react: '17.0.2', 'react-dom': '17.0.2', 'react-redux': '8.1.3', a: 'workspace:*' },
      devDependencies: { '@testing-library/react': '12.1.5', eslint: '8.57.0', typescript: '5.3.3' },
    }),
  },
  optional: {
    'package.json': manifest('optional'),
    'pnpm-workspace.yaml': WORKSPACE,
    'p/a/package.json': manifest('a', { dependencies: { zustand: '4.5.2', react: '18.2.0' } }),
    'p/b/package.json': manifest('b', { dependencies: { zustand: '4.5.2' } }),
  },
}

function lay(dir, files) {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true })
    writeFileSync(join(dir, name), content)
  }
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), `${files['pnpm-workspace.yaml'] ?? ''}lockfile:\n  format: v13\n`)
}

const fixtures = {}
for (const pnpmVersion of VERSIONS) {
  for (const [project, files] of Object.entries(PROJECTS)) {
    const dir = mkdtempSync(join(tmpdir(), `${project}-`))
    const pnpm = (...args) => execFileSync('npx', ['-y', `pnpm@${pnpmVersion}`, ...args, '--ignore-scripts', `--config.store-dir=${dir}.store`], { cwd: dir, stdio: 'inherit' })
    try {
      lay(dir, files)
      pnpm('install')
      const lockfile = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
      for (const name of Object.keys(files).filter((file) => file.endsWith('package.json'))) rmSync(join(dir, dirname(name), 'node_modules'), { recursive: true, force: true })
      pnpm('install', '--frozen-lockfile')
      fixtures[`${project}@${pnpmVersion}`] = { lockfile, read: readFileSync(join(dir, 'node_modules/.pnpm/lock.yaml'), 'utf8') }
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(`${dir}.store`, { recursive: true, force: true })
    }
  }
}
mkdirSync(new URL('.', OUT), { recursive: true })
writeFileSync(OUT, brotliCompressSync(JSON.stringify(fixtures)))
