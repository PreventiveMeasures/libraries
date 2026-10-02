// Records what npm writes for the projects below into tests/npm/fixtures/,
// each package-lock.json as <name>.json. Needs npm, git and network access
// to the npm registry and github.com:
//
//     node lockfile/scripts/record-npm.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
//
// The workspace pulls in every kind of dependency a lockfile records: a
// registry package, nested where two versions meet, a tarball by URL and
// the same one under an alias, a git repository, a directory, a local
// tarball with a bin and an install script, one that bundles a dependency,
// an npm alias, peers, an optional peer left out, dev and optional ones,
// platform packages, a deprecated one; and workspaces, one under a name its
// directory does not have. npm 9, 10, 11 and 12 write it, each as
// lockfileVersion 3; npm 12, set to fetch a repository and a tarball by
// URL, as it is not by default, resolves a git repository on GitHub to its
// https URL, where the others write the ssh one.
//
// The plain project is npm 11's from a package.json indented with a tab,
// with CRLF line ends, which npm keeps; once more with the registry's
// tarball URLs left out, which npm can be set to do. The flags project
// has a peer npm installs, a package both dev and optional, and a name
// listed both in dependencies and in devDependencies, which npm reads as a
// dev dependency alone. The outside project asks for a directory beside
// it, whose dependencies npm leaves to it. The overrides project is
// installed with an override of what react-dom asks for, which the
// lockfile does not record.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/npm/fixtures/', import.meta.url))

const ODD = 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz'
const GIT = 'git+https://github.com/juliangruber/isarray.git#v2.0.5'

const WORKSPACE = {
  '.': {
    name: 'fixture',
    version: '0.0.0',
    private: true,
    workspaces: ['packages/*'],
    dependencies: {
      bundler: 'file:vendor/bundler-1.0.0.tgz',
      'is-odd': ODD,
      isarray: GIT,
      'left-pad': '1.3.0',
      'local-dir': 'file:./local-dir',
      'local-tgz': 'file:vendor/local-tgz-1.0.0.tgz',
      'my-q': 'npm:q@1.5.1',
      'odd-alias': ODD,
      react: '18.2.0',
      'react-dom': '18.2.0',
      ws: '8.18.0',
      'ws-a': '1.0.0',
    },
    devDependencies: { 'is-number': '6.0.0', mkdirp: '1.0.4' },
    optionalDependencies: { '@img/sharp-linux-x64': '0.33.5', fsevents: '2.3.3' },
  },
  'packages/ws-a': {
    name: 'ws-a',
    version: '1.0.0',
    dependencies: { 'is-number': '7.0.0', 'ws-b': '2.0.0' },
    peerDependencies: { react: '^18.0.0' },
  },
  'packages/ws-b': {
    name: 'ws-b',
    version: '2.0.0',
    dependencies: { 'is-number': '^6.0.0', q: '1.5.1' },
    devDependencies: { mkdirp: '^1.0.0' },
  },
  'packages/ws-c': { name: '@fixture/ws-c', version: '3.0.0', dependencies: { 'ws-a': '^1.0.0' } },
  'local-dir': { name: 'local-dir', version: '0.1.0', dependencies: { 'is-number': '^7.0.0' } },
}

// What goes into vendor/, packed: each tarball's manifest and files.
const TARBALLS = {
  bundler: {
    manifest: { name: 'bundler', version: '1.0.0', dependencies: { 'is-number': '7.0.0', 'is-odd': '3.0.1' }, bundleDependencies: ['is-number'] },
    install: true,
  },
  'local-tgz': {
    manifest: { name: 'local-tgz', version: '1.0.0', bin: { 'local-tgz': 'cli.js' }, scripts: { postinstall: 'node cli.js' }, dependencies: { 'is-number': '^7.0.0' } },
    files: { 'cli.js': '#!/usr/bin/env node\n' },
  },
}

const PLAIN = { '.': { name: 'plain', version: '1.0.0', dependencies: { 'is-odd': '3.0.1', mkdirp: '1.0.4' } } }

const FLAGS = {
  '.': {
    name: 'flags',
    version: '1.0.0',
    dependencies: { 'left-pad': '1.3.0', 'react-dom': '18.2.0', ws: '8.18.0' },
    devDependencies: { 'left-pad': '1.3.0', 'to-regex-range': '5.0.1' },
    optionalDependencies: { 'is-number': '7.0.0' },
  },
}

const OUTSIDE = {
  '.': { name: 'outside-project', version: '1.0.0', dependencies: { 'is-number': '6.0.0', outside: 'file:../outside' } },
  '../outside': { name: 'outside', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' }, devDependencies: { 'left-pad': '1.3.0' } },
}

const OVERRIDES = {
  '.': { name: 'overrides', version: '1.0.0', dependencies: { 'react-dom': '18.2.0' }, overrides: { scheduler: '0.20.2' } },
}

const INSTALL = ['install', '--no-audit', '--no-fund', '--ignore-scripts']

const RUNS = [
  { name: 'npm-12', npm: '12.2.0', manifests: WORKSPACE, args: ['--allow-git=all', '--allow-remote=all'] },
  { name: 'npm-11', npm: '11.12.1', manifests: WORKSPACE },
  { name: 'npm-10', npm: '10.9.9', manifests: WORKSPACE },
  { name: 'npm-9', npm: '9.9.4', manifests: WORKSPACE },
  { name: 'npm-11-plain', npm: '11.12.1', manifests: PLAIN, crlf: true },
  { name: 'npm-11-plain-omitted', npm: '11.12.1', manifests: PLAIN, crlf: true, args: ['--omit-lockfile-registry-resolved'] },
  { name: 'npm-11-flags', npm: '11.12.1', manifests: FLAGS },
  { name: 'npm-11-outside', npm: '11.12.1', manifests: OUTSIDE },
  { name: 'npm-11-overrides', npm: '11.12.1', manifests: OVERRIDES },
]

function write(dir, name, content) {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}

// npm pack writes every entry at one date, so a tarball packed again has
// the same integrity.
function pack(dir, name, { manifest, files = {}, install }) {
  const source = join(dir, '.src', name)
  write(source, 'package.json', manifest)
  for (const [file, content] of Object.entries(files)) write(source, file, content)
  const npm = (...args) => execFileSync('npm', [...args, `--cache=${dir}.cache`], { cwd: source, stdio: 'ignore' })
  if (install) npm(...INSTALL)
  npm('pack', '--pack-destination', join(dir, 'vendor'))
}

// The manifests by directory from `dir`, the project's, and what they ask
// for from disk; with CRLF line ends and a tab where npm is to keep them.
function lay(dir, run) {
  for (const [path, manifest] of Object.entries(run.manifests)) {
    const text = run.crlf ? `${JSON.stringify(manifest, null, '\t')}\n`.replaceAll('\n', '\r\n') : manifest
    write(dir, join(path, 'package.json'), text)
  }
  if (run.manifests !== WORKSPACE) return
  mkdirSync(join(dir, 'vendor'))
  for (const [name, tarball] of Object.entries(TARBALLS)) pack(dir, name, tarball)
  rmSync(join(dir, '.src'), { recursive: true })
}

const only = process.argv.slice(2)

for (const run of RUNS.filter(({ name }) => only.length === 0 || only.includes(name))) {
  const top = mkdtempSync(join(tmpdir(), `${run.name}-`))
  const dir = join(top, 'project')
  const npm = (...args) => execFileSync('npx', ['-y', `npm@${run.npm}`, ...args, `--cache=${top}.cache`], { cwd: dir, stdio: 'inherit' })
  try {
    lay(dir, run)
    npm(...INSTALL, ...run.args ?? [])
    write(OUT, `${run.name}.json`, readFileSync(join(dir, 'package-lock.json'), 'utf8'))
  } finally {
    rmSync(top, { recursive: true, force: true })
    rmSync(`${top}.cache`, { recursive: true, force: true })
  }
}
