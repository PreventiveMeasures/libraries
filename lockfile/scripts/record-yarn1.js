// Records what yarn 1 writes for the projects below into
// tests/yarn1/fixtures/, each lockfile as <name>.lock and its manifests, by
// directory, as <name>.json. Needs npm, git and network access to the npm
// registry and github.com:
//
//     node lockfile/scripts/record-yarn1.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
//
// The workspace pulls in every kind of dependency yarn 1 records: a
// registry package, a tarball by URL and the same one under an alias, a
// git repository, a link and a directory, from the root and from a
// workspace, a local tarball, an npm alias, peers, a range left empty,
// dev and optional ones, platform packages and a resolution; and
// workspaces, linked and not written. yarn 1.22.22 writes it as it is read
// here; yarn 1.22.19 merges the alias and the package it aliases into one
// entry, which is refused.
//
// The plain project, registry packages and a git repository alone, is
// written the same by yarn 1.9.4, which records no integrity, 1.22.19 and
// 1.22.22, which is set to write its version and Node's into the header.
//
// The last runs are yarn's two ways of installing something other than the
// lockfile says. Under yarn 1.22.19, the aliases of string-width and
// strip-ansi share their entries with them; installed once more with the
// aliases asked for first, yarn names the entry after the alias, and
// leaves string-width out of node_modules. yarn 1.22.22 writes them apart.
// And under either, a resolution of is-odd's is-number to a tarball of
// its own is given to the project's is-number too, of the same version,
// which then installs that tarball in place of the registry's.
//
// And a race: a project asks for a tarball of is-number 7.0.0 after
// to-regex-range, whose range of the registry's is-number yarn resolves
// first, to an entry apart. Asked for in the other order, yarn gives that
// range the tarball, of the same name and version, under --frozen-lockfile
// too.
//
// A workspace named is-number, of the version to-regex-range asks for, is
// linked for it, with no entry.
//
// Resolutions to a tarball are read where yarn applies them to every
// request of what they resolve: a URL for is-even's is-odd, and a local
// tarball for is-number wherever it is asked for, a workspace's own among
// them. They are refused where yarn gives the tarball to a request they do
// not apply to: to a regular dependency on the tarball itself, and to a
// workspace's is-number, which a resolution of `ws-a/is-number` does not
// reach, as yarn requests a workspace's dependencies through its
// aggregator, but which yarn gives the tarball all the same.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/yarn1/fixtures/', import.meta.url))

const ODD = 'https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz'
const GIT = 'git+https://github.com/juliangruber/isarray.git#v2.0.5'

const WORKSPACE = {
  '.': {
    name: 'fixture',
    version: '0.0.0',
    private: true,
    workspaces: ['packages/*'],
    dependencies: {
      'is-odd': ODD,
      isarray: GIT,
      linked: 'link:./linked',
      'local-dir': 'file:./local-dir',
      'local-tgz': 'file:vendor/local-tgz-1.0.0.tgz',
      'my-q': 'npm:q@1.5.1',
      'odd-alias': ODD,
      react: '18.2.0',
      'react-dom': '18.2.0',
      'react-transition-group': '4.4.5',
      'ws-a': '1.0.0',
      'ws-b': '^2.0.0',
    },
    devDependencies: { mkdirp: '1.0.4' },
    optionalDependencies: { '@img/sharp-linux-x64': '0.33.5', fsevents: '2.3.3' },
    resolutions: { 'loose-envify': '1.4.0' },
  },
  'packages/ws-a': {
    name: 'ws-a',
    version: '1.0.0',
    dependencies: { 'is-number': '7.0.0', 'ws-b': '2.0.0' },
    devDependencies: { mkdirp: '^1.0.0' },
    peerDependencies: { react: '^18.0.0' },
  },
  'packages/ws-b': {
    name: 'ws-b',
    version: '2.0.0',
    dependencies: { 'is-number': '6.0.0', linked: 'link:../../linked', 'local-dir': 'file:../../local-dir', 'object-assign': '', q: '1.5.1' },
  },
}

const PLAIN = {
  '.': {
    name: 'plain',
    version: '0.0.0',
    private: true,
    dependencies: { 'is-odd': '3.0.1', isarray: GIT, 'react-dom': '18.2.0' },
    devDependencies: { mkdirp: '1.0.4' },
    optionalDependencies: { fsevents: '2.3.3' },
  },
}

const ALIASES = { 'string-width': '^4.2.0', 'string-width-cjs': 'npm:string-width@^4.2.0', 'strip-ansi': '^6.0.0', 'strip-ansi-cjs': 'npm:strip-ansi@^6.0.1' }
const aliases = (dependencies) => ({ '.': { name: 'aliases', version: '0.0.0', private: true, dependencies } })
// The same, the aliases first and one more dependency, for the lockfile to
// be written again.
const REORDERED = { 'string-width-cjs': ALIASES['string-width-cjs'], 'string-width': '^4.2.0', 'strip-ansi-cjs': ALIASES['strip-ansi-cjs'], 'strip-ansi': '^6.0.0', 'is-number': '7.0.0' }

const RESOLUTION = {
  '.': {
    name: 'resolution',
    version: '0.0.0',
    private: true,
    dependencies: { 'is-number': '6.0.0', 'is-odd': '3.0.1' },
    resolutions: { 'is-odd/is-number': 'file:./vendor/is-number-6.0.0.tgz' },
  },
}

const PATCHED = 'file:./vendor/is-number-6.0.0.tgz'
const workspace = (root, dependencies) => ({
  '.': { name: 'resolutions', version: '0.0.0', private: true, workspaces: ['packages/*'], ...root },
  'packages/ws-a': { name: 'ws-a', version: '1.0.0', dependencies },
})
const RESOLVED = workspace({ dependencies: { 'is-even': '1.0.0' }, resolutions: { 'is-even/is-odd': ODD, '**/is-number': PATCHED } }, { 'is-number': '^6.0.0' })
const SHARED = workspace({ dependencies: { 'is-odd': '3.0.1', num: PATCHED }, resolutions: { 'is-number': PATCHED } }, { 'is-odd': '3.0.1' })
const SCOPED = workspace({ resolutions: { 'ws-a/is-number': PATCHED } }, { 'is-number': '^6.0.0' })

const RACE = {
  '.': { name: 'race', version: '0.0.0', private: true, dependencies: { 'to-regex-range': '5.0.1', 'is-number': 'file:./vendor/is-number-7.0.0.tgz' } },
}

const LINKED = {
  '.': { name: 'linked', version: '0.0.0', private: true, workspaces: ['packages/*'], dependencies: { 'to-regex-range': '5.0.1' } },
  'packages/is-number': { name: 'is-number', version: '7.0.0' },
}

const RUNS = [
  { name: 'yarn-1.22.22', yarn: '1.22.22', manifests: WORKSPACE },
  { name: 'yarn-1.22.19', yarn: '1.22.19', manifests: WORKSPACE },
  { name: 'yarn-1.9.4-plain', yarn: '1.9.4', manifests: PLAIN },
  { name: 'yarn-1.22.19-plain', yarn: '1.22.19', manifests: PLAIN },
  { name: 'yarn-1.22.22-plain', yarn: '1.22.22', manifests: PLAIN, yarnrc: 'yarn-enable-lockfile-versions true\n' },
  { name: 'yarn-1.22.19-aliases', yarn: '1.22.19', manifests: aliases(ALIASES), again: aliases(REORDERED) },
  { name: 'yarn-1.22.22-aliases', yarn: '1.22.22', manifests: aliases(ALIASES) },
  { name: 'yarn-1.22.22-resolution', yarn: '1.22.22', manifests: RESOLUTION },
  { name: 'yarn-1.22.22-resolutions', yarn: '1.22.22', manifests: RESOLVED },
  { name: 'yarn-1.22.22-resolution-shared', yarn: '1.22.22', manifests: SHARED },
  { name: 'yarn-1.22.22-resolution-scoped', yarn: '1.22.22', manifests: SCOPED },
  { name: 'yarn-1.22.22-race', yarn: '1.22.22', manifests: RACE },
  { name: 'yarn-1.22.22-linked', yarn: '1.22.22', manifests: LINKED },
]

function write(dir, name, content) {
  mkdirSync(dirname(join(dir, name)), { recursive: true })
  writeFileSync(join(dir, name), typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`)
}

function pack(dir, manifest, files = {}) {
  const source = mkdtempSync(join(tmpdir(), 'pack-'))
  write(source, 'package.json', manifest)
  for (const [name, content] of Object.entries(files)) write(source, name, content)
  mkdirSync(join(dir, 'vendor'), { recursive: true })
  execFileSync('npm', ['pack', '--pack-destination', join(dir, 'vendor')], { cwd: source, stdio: 'ignore' })
  rmSync(source, { recursive: true })
}

// What the manifests ask for from disk, laid out in `dir`.
function lay(dir, manifests) {
  for (const [path, manifest] of Object.entries(manifests)) write(dir, join(path, 'package.json'), manifest)
  if (manifests === WORKSPACE) {
    write(dir, 'linked/package.json', { name: 'linked', version: '0.0.1' })
    write(dir, 'local-dir/package.json', { name: 'local-dir', version: '0.1.0', dependencies: { 'is-number': '^7.0.0' } })
    pack(dir, { name: 'local-tgz', version: '1.0.0', dependencies: { 'is-number': '^7.0.0' } }, { 'index.js': 'module.exports = 1\n' })
  }
  if ([RESOLUTION, RESOLVED, SHARED, SCOPED].includes(manifests)) pack(dir, { name: 'is-number', version: '6.0.0' }, { 'index.js': 'module.exports = "patched"\n' })
  if (manifests === RACE) pack(dir, { name: 'is-number', version: '7.0.0' }, { 'index.js': 'module.exports = "patched"\n' })
}

const only = process.argv.slice(2)

for (const run of RUNS.filter(({ name }) => only.length === 0 || only.includes(name))) {
  const dir = mkdtempSync(join(tmpdir(), `${run.name}-`))
  const yarn = () => execFileSync('npx', ['-y', `yarn@${run.yarn}`, 'install', '--no-progress', '--non-interactive', `--cache-folder=${dir}.cache`], { cwd: dir, stdio: 'inherit' })
  try {
    lay(dir, run.manifests)
    if (run.yarnrc) write(dir, '.yarnrc', run.yarnrc)
    yarn()
    if (run.again) {
      lay(dir, run.again)
      yarn()
    }
    write(OUT, `${run.name}.lock`, readFileSync(join(dir, 'yarn.lock'), 'utf8'))
    write(OUT, `${run.name}.json`, run.again ?? run.manifests)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(`${dir}.cache`, { recursive: true, force: true })
  }
}
