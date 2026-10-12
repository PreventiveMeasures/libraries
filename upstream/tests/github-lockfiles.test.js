import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { readFileSync } from 'node:fs'
import { afterEach, describe, it } from 'node:test'

import { createClient } from '../github.js'
import { FORMATS, lockfileFormat, projectFormats } from '../src/lockfiles.js'
import { gitTreeOfListing, objectId } from '../src/tree.js'
import { SHA, forbidRequests, json, stubGitHub } from './github-stub.js'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const client = () => createClient({ token: 't0ken' })
const API = 'https://api.github.com/repos/acme/app'
const blob = (text) => ({ mode: '100644', type: 'blob', sha: objectId('blob', Buffer.from(text)).toString('hex') })
const FILE = blob('{}\n')
const LINK = { mode: '120000', type: 'blob', sha: blob('../pnpm-lock.yaml').sha }
const SUBMODULE = { mode: '160000', type: 'commit', sha: '89e6c98d92887913cadf06b2adb97f26cde4849b' }

// The tree of `files`, by path, and GitHub's listing of each tree in it,
// by id.
function treeOf(files) {
  const listings = {}
  const build = (paths) => {
    const entries = [...Map.groupBy(Object.entries(paths), ([path]) => path.split('/')[0])].map(([name, group]) => {
      if (group.length === 1 && group[0][0] === name) return { path: name, ...group[0][1] }
      return { path: name, mode: '040000', type: 'tree', sha: build(Object.fromEntries(group.map(([path, entry]) => [path.slice(name.length + 1), entry]))) }
    })
    const sha = gitTreeOfListing(entries)
    listings[sha] = entries
    return sha
  }
  return { tree: build(files), listings }
}

// A tree's listing with every tree's under it, by paths from it.
const deepOf = (listings, id) => listings[id].flatMap((entry) => [entry, ...(entry.type === 'tree' ? deepOf(listings, entry.sha).map((under) => ({ ...under, path: `${entry.path}/${under.path}` })) : [])])

// GitHub, for acme/app at SHA: its commit of `tree`, and a listing of each
// tree, `?recursive=1` asked, cut short for each in `truncated`, with a
// `url` on each entry and a `size` on each blob, as GitHub answers.
function stub({ tree, listings }, { truncated = [], deep = {} } = {}) {
  return stubGitHub(({ url }) => {
    const { pathname, search } = new URL(url)
    if (pathname === `/repos/acme/app/git/commits/${SHA}`) return json({ sha: SHA, tree: { sha: tree } })
    const id = /^\/repos\/acme\/app\/git\/trees\/(?<id>[\da-f]{40})$/u.exec(pathname)?.groups.id
    if (!Object.hasOwn(listings, id) || !['', '?recursive=1'].includes(search)) return json({ message: 'Not Found' }, 404)
    const recursive = search !== ''
    const cut = recursive && truncated.includes(id)
    const entries = recursive ? (Object.hasOwn(deep, id) ? deep[id] : deepOf(listings, id)) : listings[id]
    const answered = entries && (cut ? entries.slice(0, 2) : entries).map((entry) => ({ ...entry, ...(entry.type === 'blob' && { size: 3 }), url: `${API}/git/${entry.type}s/${entry.sha}` }))
    return json({ sha: id, url: `${API}/git/trees/${id}`, tree: answered, truncated: cut })
  })
}
const urls = (calls) => calls.map(({ url }) => url.slice(API.length))
const find = (options) => client().findRepoLockfiles({ repo: 'acme/app', sha: SHA, ...options })

// A monorepo of lockfiles and project files, and what is not one: a name
// in other case, or with more after it; a pylock of two names; a symlink,
// a directory and a submodule by a lockfile's name; those in node_modules,
// at any depth.
const REPO = treeOf({
  'package.json': FILE,
  'pnpm-lock.yaml': blob('lockfileVersion: 9.0\n'),
  'pnpm-workspace.yaml': FILE,
  'apps/web/package.json': FILE,
  'apps/web/package-lock.json': blob('{"lockfileVersion":3}\n'),
  'apps/web/node_modules/left-pad/package.json': FILE,
  'apps/web/node_modules/left-pad/yarn.lock': FILE,
  'apps/cli/npm-shrinkwrap.json': FILE,
  'apps/cli/yarn.lock': blob('# yarn lockfile v1\n'),
  'apps/bun/bun.lockb': FILE,
  'apps/deno/deno.json': FILE,
  'crates/core/Cargo.toml': FILE,
  'crates/core/Cargo.lock': blob('version = 4\n'),
  'crates/core/cargo.lock': FILE,
  'crates/core/Cargo.lock.orig': FILE,
  'contracts/foundry.toml': FILE,
  'contracts/soldeer.lock': FILE,
  'contracts/foundry.lock': FILE,
  'contracts/lib/forge-std': SUBMODULE,
  'py/pyproject.toml': FILE,
  'py/uv.lock': FILE,
  'py/pylock.toml': FILE,
  'py/pylock.dev.toml': FILE,
  'py/pylock.a.b.toml': FILE,
  'py/env/dev.conda-lock.yml': FILE,
  'ruby/Gemfile': FILE,
  'ruby/Gemfile.lock': FILE,
  'ios/Podfile': FILE,
  'ios/Podfile.lock': FILE,
  'ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved': FILE,
  'go/go.mod': FILE,
  'infra/main.tf': FILE,
  'infra/providers.tf.json': FILE,
  'infra/.terraform.lock.hcl': FILE,
  'android/build.gradle.kts': FILE,
  'android/gradle.lockfile': FILE,
  'android/gradle/dependency-locks/compileClasspath.lockfile': FILE,
  'go/go.sum': FILE,
  'go/go.work': FILE,
  'go/go.work.sum': FILE,
  'dotnet/App.csproj': FILE,
  'dotnet/packages.lock.json': FILE,
  'dotnet/Lib.csproj': FILE,
  'dotnet/packages.Lib.lock.json': FILE,
  'dotnet/Directory.Packages.props': FILE,
  'php/composer.lock': FILE,
  'links/pnpm-lock.yaml': LINK,
  'links/package.json': LINK,
  'odd/yarn.lock/README': FILE,
  'odd/Cargo.lock': SUBMODULE,
  'odd/.csproj': FILE,
  'node_modules/a/pnpm-lock.yaml': FILE,
  'node_modules/a/package.json': FILE,
})
const at = (path) => deepOf(REPO.listings, REPO.tree).find((entry) => entry.path === path).sha
const JS = ['pnpm', 'npm', 'yarn', 'bun', 'deno']
const LOCKFILES = [
  ['android/gradle.lockfile', 'gradle'],
  ['android/gradle/dependency-locks/compileClasspath.lockfile', 'gradle'],
  ['apps/bun/bun.lockb', 'bun'],
  ['apps/cli/npm-shrinkwrap.json', 'npm'],
  ['apps/cli/yarn.lock', 'yarn'],
  ['apps/web/package-lock.json', 'npm'],
  ['contracts/foundry.lock', 'foundry'],
  ['contracts/soldeer.lock', 'soldeer'],
  ['crates/core/Cargo.lock', 'cargo'],
  ['dotnet/packages.Lib.lock.json', 'nuget'],
  ['dotnet/packages.lock.json', 'nuget'],
  ['go/go.sum', 'go'],
  ['go/go.work.sum', 'go'],
  ['infra/.terraform.lock.hcl', 'terraform'],
  ['ios/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved', 'swiftpm'],
  ['ios/Podfile.lock', 'cocoapods'],
  ['php/composer.lock', 'composer'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['py/env/dev.conda-lock.yml', 'conda-lock'],
  ['py/pylock.dev.toml', 'pylock'],
  ['py/pylock.toml', 'pylock'],
  ['py/uv.lock', 'uv'],
  ['ruby/Gemfile.lock', 'bundler'],
].map(([path, format]) => ({ path, format, sha: at(path) }))
const PROJECTS = [
  ['android/build.gradle.kts', ['gradle']],
  ['apps/deno/deno.json', ['deno']],
  ['apps/web/package.json', JS],
  ['contracts/foundry.toml', ['soldeer', 'foundry']],
  ['crates/core/Cargo.toml', ['cargo']],
  ['dotnet/App.csproj', ['nuget']],
  ['dotnet/Directory.Packages.props', ['nuget']],
  ['dotnet/Lib.csproj', ['nuget']],
  ['go/go.mod', ['go']],
  ['go/go.work', ['go']],
  ['infra/main.tf', ['terraform']],
  ['infra/providers.tf.json', ['terraform']],
  ['ios/Podfile', ['cocoapods']],
  ['package.json', JS],
  ['pnpm-workspace.yaml', ['pnpm']],
  ['py/pyproject.toml', ['uv', 'poetry', 'pylock', 'pdm', 'pixi']],
  ['ruby/Gemfile', ['bundler']],
].map(([path, formats]) => ({ path, formats, sha: at(path) }))
const FOUND = { lockfiles: LOCKFILES, projects: PROJECTS }

describe('lockfileFormat and projectFormats', () => {
  it('know each name FORMATS lists as the one format it gives, a project file as each in order', () => {
    for (const [format, { lockfiles, projects }] of Object.entries(FORMATS)) {
      for (const name of lockfiles.filter((known) => typeof known === 'string')) assert.equal(lockfileFormat(name), format, name)
      for (const name of projects.filter((known) => typeof known === 'string')) assert.ok(projectFormats(name).includes(format), name)
    }
    assert.deepEqual(projectFormats('package.json'), JS)
    assert.deepEqual(projectFormats('pyproject.toml'), ['uv', 'poetry', 'pylock', 'pdm', 'pixi'])
    for (const [name, format] of [['pylock.prod-2.toml', 'pylock'], ['Manifest-v1.11.toml', 'julia'], ['JuliaManifest-v1.11.toml', 'julia'], ['app.opam.locked', 'opam'], ['dev.conda-lock.yml', 'conda-lock'], ['packages.My.App.lock.json', 'nuget'], ['buildscript-gradle.lockfile', 'gradle'], ['settings-gradle.lockfile', 'gradle'], ['gradle-2.12.lockfile', 'gradle']]) assert.equal(lockfileFormat(name), format, name)
    for (const [name, format] of [['App.csproj', 'nuget'], ['Lib.fsproj', 'nuget'], ['lib.cabal', 'cabal'], ['app.opam', 'opam'], ['main.tf', 'terraform'], ['main.tf.json', 'terraform'], ['pubspec_overrides.yaml', 'pub'], ['rebar.config.script', 'rebar']]) assert.deepEqual(projectFormats(name), [format], name)
  })

  it('are the formats github.d.ts lists, those @preventive/lockfile reads among them', () => {
    const union = /export type LockfileFormat =(?<members>[^;]+?)\n\n/u.exec(readFileSync(new URL('../github.d.ts', import.meta.url), 'utf8')).groups.members
    assert.deepEqual([...union.matchAll(/'(?<format>[\w-]+)'/gu)].map(({ groups }) => groups.format), Object.keys(FORMATS))
    for (const format of ['bundler', 'cargo', 'cocoapods', 'composer', 'foundry', 'npm', 'pnpm', 'poetry', 'pylock', 'soldeer', 'uv', 'yarn']) assert.ok(Object.hasOwn(FORMATS, format), format)
  })

  it('know a file by its name as git has it, and by nothing else', () => {
    for (const name of ['cargo.lock', 'podfile.lock', 'Yarn.lock', 'Package.json', 'pylock..toml', 'pylock.a.b.toml', 'pylock.toml.bak', 'Manifest-v1.toml', '.csproj', '.cabal', '.conda-lock.yml', 'dev.conda-lock.yaml', 'packages..lock.json', '.lockfile', '.tf', '.tf.json', 'main.tfvars', 'constructor', '__proto__', 'toString', '']) {
      assert.equal(lockfileFormat(name), undefined, name)
      assert.deepEqual(projectFormats(name), [], name)
    }
  })
})

describe('findRepoLockfiles', () => {
  it('finds every lockfile and project file in the commit from one listing of the tree, with no node_modules, symlink or submodule', async () => {
    const calls = stub(REPO)
    assert.deepEqual(await find(), FOUND)
    assert.deepEqual(urls(calls), [`/git/commits/${SHA}`, `/git/trees/${REPO.tree}?recursive=1`])
  })

  it('finds those under a directory, by paths from the root', async () => {
    const calls = stub(REPO)
    const under = (dir) => (found) => found.path.startsWith(dir)
    assert.deepEqual(await find({ directory: 'apps/cli' }), { lockfiles: LOCKFILES.filter(under('apps/cli/')), projects: [] })
    assert.deepEqual(urls(calls), [`/git/commits/${SHA}`, `/git/trees/${REPO.tree}`, `/git/trees/${at('apps')}`, `/git/trees/${at('apps/cli')}?recursive=1`])
    stub(REPO)
    const pad = 'apps/web/node_modules/left-pad'
    assert.deepEqual(await find({ directory: 'apps/web/node_modules' }), { lockfiles: [{ path: `${pad}/yarn.lock`, format: 'yarn', sha: FILE.sha }], projects: [{ path: `${pad}/package.json`, formats: JS, sha: FILE.sha }] })
    stub(REPO)
    assert.deepEqual(await find({ directory: 'odd/yarn.lock' }), { lockfiles: [], projects: [] })
  })

  it('walks a tree GitHub cuts short a directory at a time, until a listing is whole, never into node_modules', async () => {
    const calls = stub(REPO, { truncated: [REPO.tree, at('apps'), at('apps/web')] })
    assert.deepEqual(await find(), FOUND)
    const asked = urls(calls)
    for (const path of ['apps', 'apps/web']) assert.ok(asked.includes(`/git/trees/${at(path)}?recursive=1`) && asked.includes(`/git/trees/${at(path)}`), path)
    for (const path of ['crates', 'py', 'apps/cli']) assert.ok(asked.includes(`/git/trees/${at(path)}?recursive=1`) && !asked.includes(`/git/trees/${at(path)}`), path)
    for (const path of ['node_modules', 'apps/web/node_modules', 'contracts/lib/forge-std', 'odd/Cargo.lock']) assert.ok(!asked.some((url) => url.includes(at(path))), path)
  })

  it("refuses a listing that is not the tree's: an entry changed, left out, added, listed twice, or under no tree listed", async () => {
    const deep = deepOf(REPO.listings, REPO.tree)
    const lock = deep.findIndex(({ path }) => path === 'crates/core/Cargo.lock')
    const extra = { path: 'py/yarn.lock', ...FILE }
    for (const changed of [
      deep.with(lock, { ...deep[lock], sha: SHA }),
      deep.with(lock, { ...deep[lock], mode: '100755' }),
      deep.toSpliced(lock, 1),
      [...deep, extra],
      [...deep, { ...extra, path: 'ghost/yarn.lock' }],
      [...deep, { ...extra, path: '/yarn.lock' }],
      [...deep, { ...extra, path: 'py//yarn.lock' }],
      [...deep, deep.find(({ path }) => path === 'py')],
      deep.map(({ path, ...entry }) => ({ path: path.replace(/^crates\//u, 'other/'), ...entry })),
      deep.with(0, { ...deep[0], path: 42 }),
      null,
    ]) {
      stub(REPO, { deep: { [REPO.tree]: changed } })
      await assert.rejects(find(), new RegExp(`^AssertionError.*findRepoLockfiles: GitHub's listing of tree ${REPO.tree} in acme/app, with the trees under it, is not that tree$`, 'u'))
    }
  })

  it('refuses a listing GitHub cuts short that is not the tree either', async () => {
    stub({ ...REPO, listings: { ...REPO.listings, [REPO.tree]: REPO.listings[REPO.tree].slice(1) } }, { truncated: [REPO.tree] })
    await assert.rejects(find(), new RegExp(`findRepoLockfiles: GitHub's listing of tree ${REPO.tree} in acme/app is not that tree$`, 'u'))
  })

  it('refuses a lockfile or a project file at a path getRepoFile does not take', async () => {
    stub(treeOf({ 'a\nb/yarn.lock': FILE, 'x\u0007/README': FILE }))
    await assert.rejects(find(), /findRepoLockfiles: acme\/app@\w+ has a lockfile at "a\\nb\/yarn\.lock", which getRepoFile does not take$/u)
    stub(treeOf({ 'a\u0085b/package.json': FILE }))
    await assert.rejects(find(), /findRepoLockfiles: acme\/app@\w+ has a project file at "a\\u0085b\/package\.json", which getRepoFile does not take$/u)
    stub(treeOf({ 'x\u0007/README': FILE, 'yarn.lock': FILE }))
    assert.deepEqual(await find(), { lockfiles: [{ path: 'yarn.lock', format: 'yarn', sha: FILE.sha }], projects: [] })
  })

  it('finds none in a tree with none, or an empty one', async () => {
    for (const files of [{ 'README.md': FILE, 'src/index.js': FILE }, {}]) {
      stub(treeOf(files))
      assert.deepEqual(await find(), { lockfiles: [], projects: [] })
    }
  })

  it('takes only a full commit sha and a directory inside the repo, before any request', async () => {
    const calls = forbidRequests()
    for (const sha of [undefined, 'main', SHA.slice(0, 7), SHA.toUpperCase()]) {
      await assert.rejects(find({ sha }), /findRepoLockfiles: sha must be a full commit sha/u, String(sha))
    }
    for (const directory of ['', '/', 'apps/', '..', 'a/../b', '.git', 42]) {
      await assert.rejects(find({ directory }), /findRepoLockfiles: directory must be a path inside a repository/u, String(directory))
    }
    await assert.rejects(find({ path: 'apps' }), /findRepoLockfiles: unknown option path/u)
    await assert.rejects(find({ ref: 'main' }), /findRepoLockfiles: unknown option ref/u)
    await assert.rejects(client().findRepoLockfiles({ repo: 'acme', sha: SHA }), /findRepoLockfiles: repo must be "owner\/name"/u)
    await assert.rejects(client().findRepoLockfiles(), /findRepoLockfiles: options must be an options object/u)
    assert.deepEqual(calls, [])
  })

  it('refuses a directory that is none, and throws a HttpError for a commit or a tree GitHub does not have', async () => {
    stub(REPO)
    await assert.rejects(find({ directory: 'pnpm-lock.yaml' }), new RegExp(`findRepoLockfiles: acme/app@${SHA} has no directory at "pnpm-lock.yaml"$`, 'u'))
    stub({ tree: REPO.tree, listings: {} })
    await assert.rejects(find(), { name: 'HttpError', status: 404, message: `GET ${API}/git/trees/${REPO.tree}?recursive=1 404: {"message":"Not Found"}` })
    stubGitHub(() => json({ message: 'Not Found' }, 404))
    await assert.rejects(find(), { name: 'HttpError', status: 404, message: `GET ${API}/git/commits/${SHA} 404: {"message":"Not Found"}` })
  })
})
