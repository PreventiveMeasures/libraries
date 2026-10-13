// One small lockfile with a node of every kind npm writes — a registry
// package and one nested under another, a peer, an alias, a git repository,
// a tarball by URL and one on disk that bundles a package, dev and optional
// ones, a directory linked and a workspace with its own node_modules — as
// npm writes it, of version 3 and of 2; and the same with an edit, as text.
// And what the tests share: the reader with semver, and the lockfiles npm
// wrote, which scripts/record-npm.js records into fixtures.json.br, one
// JSON object of their texts by name, compressed with brotli.

import { readFileSync } from 'node:fs'
import { brotliDecompressSync } from 'node:zlib'
import { parseNpmLockfile } from '../../npm.js'
import { semver } from '../yarn1/semver.js'

const FIXTURES = JSON.parse(brotliDecompressSync(readFileSync(new URL('fixtures.json.br', import.meta.url))).toString('utf8'))

export const parse = (text, options) => parseNpmLockfile(text, options ?? { semver })

export function fixture(name) {
  if (!Object.hasOwn(FIXTURES, name)) throw new Error(`no fixture ${name}`)
  return FIXTURES[name]
}
export const plain = (value) => structuredClone(value)

export const I = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg=='
export const C = '0123456789abcdef0123456789abcdef01234567'
export const S1 = 'sha1-2jmj7l5rSw0yVb/vlWAYkK/YBwk='

export const registry = (name, version) => `https://registry.npmjs.org/${name}/-/${name.slice(name.indexOf('/') + 1)}-${version}.tgz`
// A package from the registry's tarball of its name and version.
export const published = (name, version, rest = {}) => ({ version, resolved: registry(name, version), integrity: I, ...rest })

export const BASE = {
  name: 'base',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': {
      name: 'base',
      version: '1.0.0',
      workspaces: ['packages/*'],
      dependencies: {
        a: '^1.0.0',
        c: '2.0.0',
        d: 'file:d',
        e: 'github:user/e#semver:^3.0.0',
        f: 'https://example.com/f.tgz',
        'my-q': 'npm:q@^1.0.0',
        t: 'file:vendor/t-1.0.0.tgz',
      },
      devDependencies: { dv: '1.0.0' },
      optionalDependencies: { '@s/o': '1.0.0' },
    },
    d: { version: '0.1.0', dependencies: { b: '*' } },
    'node_modules/@s/o': published('@s/o', '1.0.0', { optional: true, os: ['darwin'] }),
    'node_modules/a': published('a', '1.0.0', { dependencies: { b: '^1.0.0' }, peerDependencies: { c: '^2.0.0' } }),
    'node_modules/b': published('b', '1.0.0'),
    'node_modules/c': published('c', '2.0.0'),
    'node_modules/d': { resolved: 'd', link: true },
    'node_modules/dv': published('dv', '1.0.0', { dev: true, bin: { dv: 'cli.js' } }),
    'node_modules/e': { version: '3.0.0', resolved: `git+ssh://git@github.com/user/e.git#${C}` },
    'node_modules/f': { name: 'f-pkg', version: '4.0.0', resolved: 'https://example.com/f.tgz', integrity: I },
    'node_modules/my-q': { name: 'q', ...published('q', '1.0.0') },
    'node_modules/t': { version: '1.0.0', resolved: 'file:vendor/t-1.0.0.tgz', integrity: I, bundleDependencies: ['x'], dependencies: { x: '1.0.0' } },
    'node_modules/t/node_modules/x': { version: '1.0.0', inBundle: true },
    'node_modules/ws': { resolved: 'packages/ws', link: true },
    'packages/ws': { version: '1.0.0', dependencies: { b: '^2.0.0' } },
    'packages/ws/node_modules/b': published('b', '2.0.0'),
  },
}

// BASE of version 2, with the tree again for npm 6 as npm writes it: by
// the edge that asks for each package, its version, a tarball by its spec,
// a repository with what was asked for, and a link to the directory it
// leads to with what is in there; what each asks for but peers.
export const BASE_V2 = {
  ...BASE,
  lockfileVersion: 2,
  dependencies: {
    '@s/o': published('@s/o', '1.0.0', { optional: true }),
    a: published('a', '1.0.0', { requires: { b: '^1.0.0' } }),
    b: published('b', '1.0.0'),
    c: published('c', '2.0.0'),
    d: { version: 'file:d', requires: { b: '*' } },
    dv: published('dv', '1.0.0', { dev: true }),
    e: { version: `git+ssh://git@github.com/user/e.git#${C}`, from: 'e@github:user/e#semver:^3.0.0' },
    f: { version: 'https://example.com/f.tgz', integrity: I },
    'my-q': { version: 'npm:q@1.0.0', resolved: registry('q', '1.0.0'), integrity: I },
    t: { version: 'file:vendor/t-1.0.0.tgz', integrity: I, requires: { x: '1.0.0' }, dependencies: { x: { version: '1.0.0', bundled: true } } },
    ws: { version: 'file:packages/ws', requires: { b: '^2.0.0' }, dependencies: { b: published('b', '2.0.0') } },
  },
}

// Each entry of a tree for npm 6, with the mapping it is in.
export function legacyEntries(dependencies, found = []) {
  for (const [name, entry] of Object.entries(dependencies)) {
    found.push([dependencies, name, entry])
    if (entry.dependencies !== undefined) legacyEntries(entry.dependencies, found)
  }
  return found
}

export const write = (lock, indent = 2) => `${JSON.stringify(lock, null, indent)}\n`

// BASE, or another, given to `change` to edit, as text.
export function edit(change, lock = BASE) {
  const copy = structuredClone(lock)
  change(copy)
  return write(copy)
}
