// Records what uv, Poetry, pip and PDM write for the projects below into
// tests/uv/fixtures/, tests/poetry/fixtures/ and tests/pylock/fixtures/.
// Needs uv, which fetches each tool at its version, git, and network access
// to PyPI and github.com:
//
//     node lockfile/scripts/record-python.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// VERBOSE=1 shows what the tools say as they run.
//
// workspace: a uv workspace of a project and a member, which asks for
// every kind of source uv locks: registry packages, one with an extra and
// one at two versions by a marker, which forks the resolution; a
// directory, an editable one, a wheel by path, built here, a git branch
// and a wheel by URL; an optional extra and a dependency group, and the
// member's group. uv 0.12 writes revision 3; 0.6 revision 2, its upload
// times as `upload_time`; 0.4 no revision. Its uv export is
// pylock/uv-<version>.toml.
//
// conflicts: one project of what else a uv.lock holds: two extras that
// conflict, a package of a dynamic version, an sdist by URL, a git commit,
// environments that fork it, and the resolver's options.
//
// poetry: the workspace's project for Poetry, which writes lock-version 2.1
// from 2.0, with the groups and markers of each package; poetry-1.8.5:
// the same for Poetry 1.8, of lock-version 2.0, with an index of its own.
//
// pip: `pip lock` of registry packages, a directory, a git commit, and an
// sdist and a wheel by URL. pdm: PDM's export of a project with extras and
// groups, whose markers test `dependency_groups`.
//
// uv's runs exclude what was uploaded after 2026-09-30; the others resolve
// against PyPI as it is, and record what it has that day.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TESTS = fileURLToPath(new URL('../tests/', import.meta.url))
const UV = '0.12.21'

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', process.env.VERBOSE ? 'inherit' : 'ignore', process.env.VERBOSE ? 'inherit' : 'ignore'] })
const uv = (version, args, cwd) => run('uvx', ['--quiet', '--from', `uv==${version}`, 'uv', ...args], cwd)
const tool = (spec, name, args, cwd) => run('uvx', ['--quiet', '--from', spec, name, ...args], cwd)

const SIX = 'https://files.pythonhosted.org/packages/d9/5a/e7c31adbe875f2abbb91bd84cf2dc52d792b5a01506781dbcf25c91daf11/six-1.16.0-py2.py3-none-any.whl'
const PEPPERCORN = 'https://files.pythonhosted.org/packages/e4/77/93085de7108cdf1a0b092ff443872a8f9442c736d7ddebdf2f27627935f4/peppercorn-0.6.tar.gz'
const SAMPLE = 'https://github.com/pypa/sampleproject'
const COMMIT = '621e4974ca25ce531773def586ba3ed8e736b3fc'

const BUILD = '[build-system]\nrequires = ["uv_build>=0.8,<0.13"]\nbuild-backend = "uv_build"\n'
const project = (name, dependencies, rest = '') => `[project]\nname = "${name}"\nversion = "0.1.0"\nrequires-python = ">=3.11"\ndependencies = [${dependencies.map((spec) => JSON.stringify(spec)).join(', ')}]\n${rest}`

// A package of its own, with a module, in `dir`.
function local(dir, name, text = `${project(name, [])}\n${BUILD}`) {
  mkdirSync(join(dir, 'src', name), { recursive: true })
  writeFileSync(join(dir, 'src', name, '__init__.py'), '')
  writeFileSync(join(dir, 'pyproject.toml'), text)
}

// The workspace's local packages, and the wheel of one, in dist/.
function packages(dir) {
  local(join(dir, 'localpkg'), 'localpkg')
  local(join(dir, 'editpkg'), 'editpkg')
  local(join(dir, 'wheelpkg'), 'wheelpkg')
  uv(UV, ['build', '--wheel', '--out-dir', '../dist'], join(dir, 'wheelpkg'))
}

const WORKSPACE = `${project('uv-demo', [
  'anyio>=4', 'requests[socks]==2.32.3', "colorama; sys_platform == 'win32'",
  "iniconfig==2.0.0; python_version < '3.12'", "iniconfig==2.1.0; python_version >= '3.12'",
  'member', 'localpkg', 'editpkg', 'wheelpkg', 'sampleproject', `six @ ${SIX}`,
])}
[project.optional-dependencies]
dev = ["pytest==8.2.0"]

[dependency-groups]
lint = ["ruff==0.4.4"]

[tool.uv]
exclude-newer = "2026-09-30T00:00:00Z"
constraint-dependencies = ["urllib3<3"]

[tool.uv.workspace]
members = ["packages/*"]

[tool.uv.sources]
member = { workspace = true }
localpkg = { path = "localpkg" }
editpkg = { path = "editpkg", editable = true }
wheelpkg = { path = "dist/wheelpkg-0.1.0-py3-none-any.whl" }
sampleproject = { git = "${SAMPLE}", branch = "main" }
`

const MEMBER = `${project('member', ['idna'])}
[dependency-groups]
test = ["iniconfig"]

${BUILD}`

function workspace(dir) {
  packages(dir)
  local(join(dir, 'packages', 'member'), 'member', MEMBER)
  writeFileSync(join(dir, 'pyproject.toml'), WORKSPACE)
}

const CONFLICTS = `${project('uv-conflicts', ['dynpkg', `peppercorn @ ${PEPPERCORN}`, `sampleproject @ git+${SAMPLE}@${COMMIT}`])}
[project.optional-dependencies]
old = ["iniconfig==2.0.0"]
new = ["iniconfig==2.1.0"]

[dependency-groups]
dev = ["packaging<26"]

[tool.uv]
exclude-newer = "2026-09-30T00:00:00Z"
resolution = "lowest-direct"
prerelease = "allow"
conflicts = [[{ extra = "old" }, { extra = "new" }]]
environments = ["sys_platform == 'linux'", "sys_platform == 'darwin'"]
required-environments = ["sys_platform == 'linux'"]

[tool.uv.sources]
dynpkg = { path = "dynpkg", editable = true }
`

// A package whose version its build backend reads from its module.
const DYNAMIC = `[project]
name = "dynpkg"
dynamic = ["version"]
requires-python = ">=3.11"

[build-system]
requires = ["setuptools>=61"]
build-backend = "setuptools.build_meta"

[tool.setuptools.dynamic]
version = { attr = "dynpkg.__version__" }
`

function conflicts(dir) {
  local(join(dir, 'dynpkg'), 'dynpkg', DYNAMIC)
  writeFileSync(join(dir, 'dynpkg', 'src', 'dynpkg', '__init__.py'), '__version__ = "0.3.0"\n')
  writeFileSync(join(dir, 'pyproject.toml'), CONFLICTS)
}

const POETRY = `${project('poetry-demo', [
  'requests[socks] (==2.32.3)', "colorama (>=0.4) ; sys_platform == 'win32'",
  "iniconfig (==2.0.0) ; python_version < '3.12'", "iniconfig (==2.1.0) ; python_version >= '3.12'",
  'localpkg', 'editpkg', 'wheelpkg', 'sampleproject', 'six',
])}
[project.optional-dependencies]
fast = ["anyio (>=4)"]

[tool.poetry.dependencies]
localpkg = { path = "localpkg" }
editpkg = { path = "editpkg", develop = true }
wheelpkg = { path = "dist/wheelpkg-0.1.0-py3-none-any.whl" }
sampleproject = { git = "${SAMPLE}", branch = "main" }
six = { url = "${SIX}" }

[tool.poetry.group.dev.dependencies]
pytest = "8.2.0"

[tool.poetry.group.lint]
optional = true

[tool.poetry.group.lint.dependencies]
ruff = "0.4.4"

[build-system]
requires = ["poetry-core>=2.0.0,<3.0.0"]
build-backend = "poetry.core.masonry.api"
`

// Poetry 1.8 reads [tool.poetry] alone.
const POETRY_1 = `[tool.poetry]
name = "poetry-demo"
version = "0.1.0"
description = ""
authors = ["fixture <fixture@example.com>"]
package-mode = false

[tool.poetry.dependencies]
python = "^3.11"
requests = { version = "2.32.3", extras = ["socks"] }
colorama = { version = ">=0.4", markers = "sys_platform == 'win32'" }
iniconfig = [
    { version = "2.0.0", python = "<3.12" },
    { version = "2.1.0", python = ">=3.12" },
]
anyio = { version = ">=4", optional = true }
localpkg = { path = "localpkg" }
editpkg = { path = "editpkg", develop = true }
wheelpkg = { path = "dist/wheelpkg-0.1.0-py3-none-any.whl" }
sampleproject = { git = "${SAMPLE}", rev = "${COMMIT}" }
six = { url = "${SIX}" }
ruff = { version = "0.4.4", source = "mirror" }

[tool.poetry.extras]
fast = ["anyio"]

[tool.poetry.group.dev.dependencies]
pytest = "8.2.0"

[[tool.poetry.source]]
name = "mirror"
url = "https://pypi.org/simple/"
priority = "explicit"
`

const PDM = `${project('pdm-demo', ['requests[socks]==2.32.3', "colorama>=0.4; sys_platform == 'win32'"])}
[project.optional-dependencies]
fast = ["anyio>=4"]

[dependency-groups]
dev = ["pytest==8.2.0"]

[tool.pdm]
distribution = false
`

const PIP = ['attrs==25.1.0', 'requests[socks]==2.32.3', './localpkg', `sampleproject @ git+${SAMPLE}@${COMMIT}`, `six @ ${SIX}`, `peppercorn @ ${PEPPERCORN}`]

const keep = (dir, from, to) => {
  mkdirSync(join(TESTS, dir), { recursive: true })
  writeFileSync(join(TESTS, dir, to), readFileSync(from, 'utf8'))
}

const lockUv = (version, name, setup, exported) => (dir) => {
  setup(dir)
  uv(version, ['lock'], dir)
  keep('uv/fixtures', join(dir, 'uv.lock'), `${name}.lock`)
  if (!exported) return
  uv(version, ['export', '--all-extras', '--all-groups', '--format', 'pylock.toml', '--output-file', 'pylock.toml'], dir)
  keep('pylock/fixtures', join(dir, 'pylock.toml'), `uv-${version}.toml`)
}

const RUNS = {
  [`uv-${UV}`]: lockUv(UV, `uv-${UV}`, workspace, true),
  'uv-0.6.17': lockUv('0.6.17', 'uv-0.6.17', workspace, false),
  'uv-0.4.30': lockUv('0.4.30', 'uv-0.4.30', workspace, false),
  [`uv-${UV}-conflicts`]: lockUv(UV, `uv-${UV}-conflicts`, conflicts, false),
  'poetry-2.3.3': (dir) => {
    packages(dir)
    writeFileSync(join(dir, 'pyproject.toml'), POETRY)
    tool('poetry==2.3.3', 'poetry', ['lock'], dir)
    keep('poetry/fixtures', join(dir, 'poetry.lock'), 'poetry-2.3.3.lock')
  },
  'poetry-1.8.5': (dir) => {
    packages(dir)
    writeFileSync(join(dir, 'pyproject.toml'), POETRY_1)
    tool('poetry==1.8.5', 'poetry', ['lock', '--no-update'], dir)
    keep('poetry/fixtures', join(dir, 'poetry.lock'), 'poetry-1.8.5.lock')
  },
  'pip-26.2.1': (dir) => {
    local(join(dir, 'localpkg'), 'localpkg')
    tool('pip==26.2.1', 'pip', ['lock', ...PIP, '--output', 'pylock.toml'], dir)
    keep('pylock/fixtures', join(dir, 'pylock.toml'), 'pip-26.2.1.toml')
  },
  'pdm-2.29.2': (dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), PDM)
    tool('pdm==2.29.2', 'pdm', ['lock'], dir)
    tool('pdm==2.29.2', 'pdm', ['export', '--format', 'pylock', '--output', 'pylock.toml'], dir)
    keep('pylock/fixtures', join(dir, 'pylock.toml'), 'pdm-2.29.2.toml')
  },
}

const only = process.argv.slice(2)
for (const name of only) if (!(name in RUNS)) throw new Error(`no run ${name}`)

for (const [name, record] of Object.entries(RUNS)) {
  if (only.length > 0 && !only.includes(name)) continue
  const dir = mkdtempSync(join(tmpdir(), `record-python-${name}-`))
  try {
    record(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
