// Records what pnpm 9, 10, 11 and 12 write for the workspace below into
// tests/fixtures/pnpm-*.yaml. Needs npm, git and network access to the npm
// registry and github.com:
//
//     node lockfile/scripts/record-pnpm.js [<name>...]
//
// With names, only the runs of those names are recorded, so the rest stay
// as they were recorded, against the registry as it was.
//
// One workspace, installed by each version in a temporary directory of its
// own, pulls in every kind of dependency a v9 lockfile records: a registry
// tarball URL, a local tarball and directory, a link, a git repository, an
// npm alias, a catalog and a named one, peers resolved inside peers, a
// patch, an override, workspace packages linked and injected, dev and
// optional ones and platform bindings. pnpm 9 takes its overrides and
// patches from package.json; later versions from pnpm-workspace.yaml.
//
// The runs after the first four lead the lockfile with an env document: a
// config dependency added after the install under pnpm 11, and under pnpm
// 12 one added to a project that also pins pnpm as its package manager.
// The last adds a config dependency to a bare project and installs
// nothing, which leaves the env document alone in the file. The config
// dependency is a package with no code pnpm runs, so it changes nothing
// else.
//
// The two runs of the small project after those give pnpm's manifests
// something to rewrite, a pnpmfile hook and a package extension, an
// optional dependency to ignore by name and one by pattern, a Node
// executable for a dependency's bins, and a peer to hash with
// `peersSuffixMaxLength: 0`, and resolve by time, which records when each
// direct dependency was published; pnpm 9 writes its checksums bare, pnpm
// 10 and later as integrities. pnpm 9 takes the settings from package.json
// and has neither the limit nor the resolution mode to set.
//
// The runs with `format` set `lockfile.format: v13`, which pnpm 12 has from
// 12.19.0, and write the lockfile of `lockfileVersion: '13.0'`: the
// workspace, the config dependency and pinned pnpm, and the small project,
// by 12.21.0, and the workspace by 12.19.0, which lays it out otherwise.
// Each of them is installed again from the lockfile alone, frozen, and
// what pnpm reads it as, which it keeps in node_modules/.pnpm/lock.yaml in
// v9's shape, is recorded beside it: both texts, `lockfile` and `read`, by
// the run's name, in tests/pnpm-13/fixtures.json.br, with
// scripts/record-pnpm-13.js's.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'

const OUT = new URL('../tests/fixtures/', import.meta.url)
const NEXT = new URL('../tests/pnpm-13/fixtures.json.br', import.meta.url)

const RUNS = [
  { name: 'pnpm-9', pnpm: '9.15.9' },
  { name: 'pnpm-10', pnpm: '10.34.5' },
  { name: 'pnpm-11', pnpm: '11.27.1' },
  { name: 'pnpm-12', pnpm: '12.6.0' },
  { name: 'pnpm-11-config', pnpm: '11.27.1', config: true },
  { name: 'pnpm-12-env', pnpm: '12.6.0', packageManager: 'pnpm@12.6.0', config: true },
  { name: 'pnpm-12-env-only', pnpm: '12.6.0', bare: true, config: true },
  { name: 'pnpm-9-hooks', pnpm: '9.15.9', hooks: true },
  { name: 'pnpm-12-hooks', pnpm: '12.6.0', hooks: true },
  { name: 'pnpm-13', pnpm: '12.21.0', format: 'v13' },
  { name: 'pnpm-13-env', pnpm: '12.21.0', packageManager: 'pnpm@12.21.0', config: true, format: 'v13' },
  { name: 'pnpm-13-hooks', pnpm: '12.21.0', hooks: true, format: 'v13' },
  { name: 'pnpm-13-12.19', pnpm: '12.19.0', format: 'v13' },
]

const FORMAT = (run) => (run.format === undefined ? [] : ['lockfile:', `  format: ${run.format}`])

const HOOKS = {
  packageExtensions: { 'is-odd': { dependencies: { 'is-number': '6.0.0' } } },
  ignoredOptionalDependencies: ['fsevents', '@esbuild/*'],
}

const CONFIG = 'is-number@7.0.0'

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

// The workspace above, laid out in `dir` for `run`.
function lay(dir, run) {
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
  const settings = legacy ? [] : [...yamlMap('overrides', OVERRIDES), ...yamlMap('patchedDependencies', PATCHES), ...FORMAT(run)]
  write(dir, 'pnpm-workspace.yaml', `${[...WORKSPACE, ...settings].join('\n')}\n`)
}

// The small project, laid out in `dir` for `run`.
function layHooks(dir, run) {
  const legacy = run.pnpm.startsWith('9.')
  write(dir, 'package.json', {
    name: 'hooks',
    version: '0.0.0',
    private: true,
    dependencies: { 'is-odd': '3.0.1', mkdirp: '1.0.4', react: '18.2.0', 'react-dom': '18.2.0' },
    optionalDependencies: { fsevents: '2.3.3' },
    dependenciesMeta: { mkdirp: { node: '/usr/local/bin/node' } },
    ...(legacy ? { pnpm: HOOKS } : {}),
  })
  write(dir, '.pnpmfile.cjs', 'module.exports = { hooks: { readPackage: (pkg) => pkg } }\n')
  if (legacy) return
  const workspace = [
    'packageExtensions:', '  is-odd:', '    dependencies:', '      is-number: 6.0.0',
    'ignoredOptionalDependencies:', ...HOOKS.ignoredOptionalDependencies.map((name) => `  - '${name}'`),
    'peersSuffixMaxLength: 0',
    'resolutionMode: time-based',
    ...FORMAT(run),
  ]
  write(dir, 'pnpm-workspace.yaml', `${workspace.join('\n')}\n`)
}

const only = process.argv.slice(2)
const unknown = only.find((name) => !RUNS.some((run) => run.name === name))
if (unknown !== undefined) throw new Error(`no run is named ${unknown}`)

const next = existsSync(NEXT) ? JSON.parse(brotliDecompressSync(readFileSync(NEXT)).toString('utf8')) : {}
const runs = RUNS.filter(({ name }) => only.length === 0 || only.includes(name))
for (const run of runs) {
  const dir = mkdtempSync(join(tmpdir(), `${run.name}-`))
  const pnpm = (...args) => execFileSync('npx', ['-y', `pnpm@${run.pnpm}`, ...args, `--config.store-dir=${dir}.store`], { cwd: dir, stdio: 'inherit' })
  try {
    if (run.bare) write(dir, 'package.json', { name: 'bare', version: '0.0.0', private: true })
    else if (run.hooks) layHooks(dir, run)
    else lay(dir, run)
    if (!run.bare) pnpm('install')
    if (run.config) pnpm('add', '--config', CONFIG)
    if (run.format === undefined) {
      copyFileSync(join(dir, 'pnpm-lock.yaml'), new URL(`${run.name}.yaml`, OUT))
    } else {
      const lockfile = readFileSync(join(dir, 'pnpm-lock.yaml'), 'utf8')
      for (const project of ['.', 'packages/ws-a', 'packages/ws-b']) rmSync(join(dir, project, 'node_modules'), { recursive: true, force: true })
      pnpm('install', '--frozen-lockfile', '--ignore-scripts')
      next[run.name] = { lockfile, read: readFileSync(join(dir, 'node_modules/.pnpm/lock.yaml'), 'utf8') }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.store`, { recursive: true, force: true })
  }
}
if (runs.some((run) => run.format !== undefined)) writeFileSync(NEXT, brotliCompressSync(JSON.stringify(next)))
