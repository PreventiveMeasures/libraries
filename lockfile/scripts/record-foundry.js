// Records what forge writes for the projects below into
// tests/foundry/fixtures/, each foundry.lock as <name>.lock and the
// repository's .gitmodules as <name>.gitmodules. Downloads forge's releases
// for this machine from GitHub, and needs git and network access to
// github.com:
//
//     node lockfile/scripts/record-foundry.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// VERBOSE=1 shows what forge and git say as they run.
//
// forge-<version>: a project of each kind of dependency forge install
// records, a tag, a branch, a commit, and a tag under another directory
// name. forge 1.3.0, the first to write foundry.lock, writes its keys in a
// hash map's order, a new one each run; 1.3.2 and later sort them.
//
// The rest are forge 1.8.3's. synced: the same project, its lockfile
// deleted and written again by forge install, which records each
// submodule's commit, and a branch for one .gitmodules gives a branch.
// monorepo: a project in packages/contracts of a repository with a
// submodule of its own outside it, which forge records by a path up and
// out of the project. removed: every dependency removed again, which
// leaves `{}`. short: a commit given by a short hash, which forge install
// writes as it is given, and forge build --locked then refuses.
//
// Each lockfile but short's is one forge build --locked takes.

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/foundry/fixtures/', import.meta.url))

const SOLMATE = 'transmissions11/solmate'
const COMMIT = 'c93f7716c9909175d45f6ef80a34a650e2d24e56'
const DEPENDENCIES = ['foundry-rs/forge-std@v1.9.7', `${SOLMATE}@main`, `pinned=${SOLMATE}@${COMMIT}`, `v6=${SOLMATE}@v6`]

// What forge init writes, less the comment.
const FOUNDRY_TOML = '[profile.default]\nsrc = "src"\nout = "out"\nlibs = ["lib"]\n'

const env = { ...process.env, GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' }
const run = (command, args, cwd) => execFileSync(command, args, { cwd, env, stdio: ['ignore', 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'] })

const work = mkdtempSync(join(tmpdir(), 'record-foundry-'))
process.on('exit', () => rmSync(work, { recursive: true, force: true }))

// forge of a release, from GitHub, for this machine.
function forge(version) {
  const dir = join(work, `forge-${version}`)
  if (existsSync(join(dir, 'forge'))) return join(dir, 'forge')
  const os = { linux: 'linux', darwin: 'darwin' }[platform()]
  const cpu = { x64: 'amd64', arm64: 'arm64' }[arch()]
  if (os === undefined || cpu === undefined) throw new Error(`no forge release for ${platform()} ${arch()}`)
  mkdirSync(dir)
  const archive = join(dir, 'foundry.tar.gz')
  run('curl', ['-fsSL', '-o', archive, `https://github.com/foundry-rs/foundry/releases/download/v${version}/foundry_v${version}_${os}_${cpu}.tar.gz`])
  run('tar', ['-xzf', archive, '-C', dir])
  return join(dir, 'forge')
}

// A git repository with a project of forge's at `project` in it.
function repository(name, version, project = '.') {
  const root = join(work, name)
  mkdirSync(join(root, project), { recursive: true })
  run('git', ['init', '-q'], root)
  writeFileSync(join(root, project, 'foundry.toml'), FOUNDRY_TOML)
  return { root, dir: join(root, project), forge: (...args) => run(forge(version), args, join(root, project)) }
}

function locked({ dir }, expected) {
  const { status } = spawnSync(forge('1.8.3'), ['build', '--locked'], { cwd: dir, env, stdio: 'ignore' })
  if ((status === 0) !== expected) throw new Error(`forge build --locked ${expected ? 'refused' : 'took'} the lockfile in ${dir}`)
}

function record(name, { root, dir }) {
  copyFileSync(join(dir, 'foundry.lock'), join(OUT, `${name}.lock`))
  const gitmodules = join(root, '.gitmodules')
  writeFileSync(join(OUT, `${name}.gitmodules`), existsSync(gitmodules) ? readFileSync(gitmodules) : '')
}

const RUNS = {
  'forge-1.3.0': () => {
    const repo = repository('v1.3.0', '1.3.0')
    repo.forge('install', ...DEPENDENCIES)
    locked(repo, true)
    return repo
  },
  'forge-1.8.3': () => {
    const repo = repository('v1.8.3', '1.8.3')
    repo.forge('install', ...DEPENDENCIES)
    locked(repo, true)
    return repo
  },
  'forge-1.8.3-synced': () => {
    const repo = repository('synced', '1.8.3')
    repo.forge('install', ...DEPENDENCIES)
    rmSync(join(repo.dir, 'foundry.lock'))
    repo.forge('install')
    locked(repo, true)
    return repo
  },
  'forge-1.8.3-monorepo': () => {
    const repo = repository('monorepo', '1.8.3', 'packages/contracts')
    run('git', ['submodule', 'add', '-q', `https://github.com/${SOLMATE}`, 'other/lib/solmate'], repo.root)
    repo.forge('install', 'foundry-rs/forge-std@v1.9.7')
    locked(repo, true)
    return repo
  },
  'forge-1.8.3-removed': () => {
    const repo = repository('removed', '1.8.3')
    repo.forge('install', 'foundry-rs/forge-std@v1.9.7', `${SOLMATE}@main`)
    repo.forge('remove', '--force', 'lib/forge-std', 'lib/solmate')
    locked(repo, true)
    return repo
  },
  'forge-1.8.3-short': () => {
    const repo = repository('short', '1.8.3')
    repo.forge('install', 'foundry-rs/forge-std@v1.9.7', `short=${SOLMATE}@${COMMIT.slice(0, 7)}`)
    locked(repo, false)
    return repo
  },
}

const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(RUNS)
const unknown = names.find((name) => !(name in RUNS))
if (unknown !== undefined) throw new Error(`no run named ${unknown}, of ${Object.keys(RUNS).join(', ')}`)
mkdirSync(OUT, { recursive: true })
for (const name of names) {
  record(name, RUNS[name]())
  console.log(`recorded ${name}`)
}
