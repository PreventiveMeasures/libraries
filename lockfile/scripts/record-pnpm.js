// Records what pnpm 9, 10, 11 and 12 write for the workspace below into
// tests/fixtures/pnpm-*.yaml. Needs npm, git and network access to the npm
// registry and github.com:
//
//     node lockfile/scripts/record-pnpm.js
//
// One workspace, installed by each version in a temporary directory of its
// own, pulls in every kind of dependency a v9 lockfile records: a registry
// tarball URL, a local tarball and directory, a link, a git repository, an
// npm alias, a catalog and a named one, peers resolved inside peers, a
// patch, an override, workspace packages linked and injected, dev and
// optional ones and platform bindings. pnpm 9 takes its overrides and
// patches from package.json; later versions from pnpm-workspace.yaml. The
// last run pins pnpm 12 as the package manager, which leads the lockfile
// with an env document.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const OUT = new URL('../tests/fixtures/', import.meta.url)

const RUNS = [
  { name: 'pnpm-9', pnpm: '9.15.9' },
  { name: 'pnpm-10', pnpm: '10.34.5' },
  { name: 'pnpm-11', pnpm: '11.27.1' },
  { name: 'pnpm-12', pnpm: '12.6.0' },
  { name: 'pnpm-12-env', pnpm: '12.6.0', packageManager: 'pnpm@12.6.0' },
]

const OVERRIDES = { 'loose-envify': '1.4.0' }
const PATCHES = { 'is-number@7.0.0': 'patches/is-number@7.0.0.patch' }

const PATCH = `diff --git a/index.js b/index.js
index 27f19b757f7c1186b92c405a213bf0dd9b6cbe95..b4443284044487ed4b788d95bacfeddab5c719ce 100644
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

const ROOT = {
  name: 'fixture',
  version: '0.0.0',
  private: true,
  dependencies: {
    'is-odd': 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz',
    isarray: 'git+https://github.com/juliangruber/isarray.git#v2.0.5',
    linked: 'link:./linked',
    'local-dir': 'file:./local-dir',
    'local-tgz': 'file:vendor/local-tgz-1.0.0.tgz',
    'my-q': 'npm:q@1.5.1',
    react: 'catalog:',
    'react-dom': '18.2.0',
    'react-transition-group': '4.4.5',
    'ws-a': 'workspace:*',
    'ws-b': 'workspace:^',
  },
  devDependencies: { mkdirp: '1.0.4' },
  optionalDependencies: { '@img/sharp-linux-x64': '0.33.5', fsevents: '2.3.3' },
  dependenciesMeta: { 'ws-a': { injected: true } },
}

const FILES = {
  'linked/package.json': { name: 'linked', version: '0.0.1' },
  'local-dir/package.json': { name: 'local-dir', version: '0.1.0', dependencies: { 'is-number': '^7.0.0' } },
  'packages/ws-a/package.json': { name: 'ws-a', version: '1.0.0', dependencies: { 'is-number': '7.0.0', 'ws-b': 'workspace:*' }, peerDependencies: { react: '^18.0.0' } },
  'packages/ws-b/package.json': { name: 'ws-b', version: '2.0.0', dependencies: { 'is-odd': '3.0.1', 'is-number': 'catalog:legacy' } },
  'tgz/package.json': { name: 'local-tgz', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' } },
  'tgz/index.js': 'module.exports = 1\n',
  'patches/is-number@7.0.0.patch': PATCH,
}

const WORKSPACE = ['packages:', '  - packages/*', 'catalog:', '  react: 18.2.0', 'catalogs:', '  legacy:', '    is-number: 6.0.0']

function write(dir, name, content) {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}

const yamlMap = (key, map) => [`${key}:`, ...Object.entries(map).map(([k, v]) => `  ${k}: ${v}`)]

for (const run of RUNS) {
  const dir = mkdtempSync(join(tmpdir(), `${run.name}-`))
  try {
    for (const [name, content] of Object.entries(FILES)) write(dir, name, content)
    mkdirSync(join(dir, 'vendor'))
    execFileSync('npm', ['pack', '--pack-destination', '../vendor'], { cwd: join(dir, 'tgz'), stdio: 'ignore' })
    rmSync(join(dir, 'tgz'), { recursive: true })
    const legacy = run.pnpm.startsWith('9.')
    write(dir, 'package.json', {
      ...ROOT,
      ...(run.packageManager ? { packageManager: run.packageManager } : {}),
      ...(legacy ? { pnpm: { overrides: OVERRIDES, patchedDependencies: PATCHES } } : {}),
    })
    const settings = legacy ? [] : [...yamlMap('overrides', OVERRIDES), ...yamlMap('patchedDependencies', PATCHES)]
    write(dir, 'pnpm-workspace.yaml', `${[...WORKSPACE, ...settings].join('\n')}\n`)
    execFileSync('npx', ['-y', `pnpm@${run.pnpm}`, 'install', `--config.store-dir=${dir}.store`], { cwd: dir, stdio: 'inherit' })
    copyFileSync(join(dir, 'pnpm-lock.yaml'), new URL(`${run.name}.yaml`, OUT))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.store`, { recursive: true, force: true })
  }
}
