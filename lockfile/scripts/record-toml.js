// Records the TOML fixtures in tests/toml/fixtures/ and, beside each, the
// .json of what Python's tomllib reads from it. Needs cargo, uv, poetry and
// python3 of 3.11 or later, with network access to crates.io, PyPI and
// GitHub; the names of groups below, if given, record those alone:
//
//     node lockfile/scripts/record-toml.js [cargo uv poetry pip foundry crates]
//
// A lockfile of each kind, written by its own tool for a small project:
// Cargo.lock from cargo with registry, path, git and target-specific
// dependencies; uv.lock from uv with extras, markers, an optional and a
// dependency group, and the same project exported by uv as pylock.uv.toml,
// whose upload times are TOML date-times; poetry.lock from poetry; and
// pylock.pip.toml from pip's own `pip lock`, which writes its wheels as
// arrays of tables. Beside them, the foundry.toml of three MIT-licensed
// projects at a fixed commit each, and Cargo.toml as crates.io serves it
// for two crates at a fixed version, with multi-line strings: regex's
// description, in the manifest cargo publishes and in the one its authors
// wrote, and toml_edit's replacements for cargo-release.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { tomllib } from '../tests/toml/reference.js'

const OUT = new URL('../tests/toml/fixtures/', import.meta.url)

const FOUNDRY = {
  'foundry.forge-std.toml': 'foundry-rs/forge-std/6b72d0fcba36f39e07cf08bbe66a0d1525011e1f',
  'foundry.solady.toml': 'Vectorized/solady/2afba69bf67b78dd4abeadcc696052b3a6f71499',
  'foundry.openzeppelin.toml': 'OpenZeppelin/openzeppelin-contracts/32b5b8c4655448291e27272d43607b9e3ae8c1d8',
}

// Each fixture, and the file it is in the .crate, as `name-version/file`.
const CRATES = {
  'Cargo.regex.toml': 'regex-1.11.1/Cargo.toml',
  'Cargo.regex.toml.orig': 'regex-1.11.1/Cargo.toml.orig',
  'Cargo.toml_edit.toml': 'toml_edit-0.22.24/Cargo.toml',
}

const CARGO = `
serde = { version = "1.0.200", features = ["derive"] }
itoa = "=1.0.11"
localcrate = { path = "../localcrate" }
semver = { git = "https://github.com/dtolnay/semver", tag = "1.0.23" }

[target.'cfg(windows)'.dependencies]
winapi-util = "0.1"
`

const PYPROJECT = (name, dependencies) => `[project]
name = "${name}"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [${dependencies.map((spec) => JSON.stringify(spec)).join(', ')}]
`

const UV = `${PYPROJECT('uv-demo', ['anyio>=4', 'requests[socks]==2.32.3', "colorama; sys_platform == 'win32'"])}
[project.optional-dependencies]
dev = ["pytest==8.2.0"]

[dependency-groups]
lint = ["ruff==0.4.4"]
`

const POETRY = `${PYPROJECT('poetry-demo', ['requests[socks] (==2.32.3)', "colorama (>=0.4) ; sys_platform == 'win32'"])}
[tool.poetry.group.dev.dependencies]
pytest = "8.2.0"
`

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', 'ignore', 'inherit'] })

function inTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'record-toml-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const recorded = []
const keep = (from, name) => {
  copyFileSync(from, new URL(name, OUT))
  recorded.push(name)
}

const GROUPS = {
  cargo: () => inTemp((dir) => {
    mkdirSync(join(dir, 'localcrate/src'), { recursive: true })
    writeFileSync(join(dir, 'localcrate/Cargo.toml'), '[package]\nname = "localcrate"\nversion = "0.1.0"\nedition = "2021"\n')
    writeFileSync(join(dir, 'localcrate/src/lib.rs'), '')
    run('cargo', ['new', '--quiet', '--lib', 'demo'], dir)
    writeFileSync(join(dir, 'demo/Cargo.toml'), `${readFileSync(join(dir, 'demo/Cargo.toml'), 'utf8')}${CARGO}`)
    run('cargo', ['generate-lockfile'], join(dir, 'demo'))
    keep(join(dir, 'demo/Cargo.lock'), 'Cargo.lock')
  }),
  uv: () => inTemp((dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), UV)
    run('uv', ['lock', '--quiet'], dir)
    run('uv', ['export', '--quiet', '--format', 'pylock.toml', '--output-file', 'pylock.toml'], dir)
    keep(join(dir, 'uv.lock'), 'uv.lock')
    keep(join(dir, 'pylock.toml'), 'pylock.uv.toml')
  }),
  poetry: () => inTemp((dir) => {
    writeFileSync(join(dir, 'pyproject.toml'), POETRY)
    run('poetry', ['lock', '--quiet'], dir)
    keep(join(dir, 'poetry.lock'), 'poetry.lock')
  }),
  pip: () => inTemp((dir) => {
    run('uvx', ['--quiet', '--from', 'pip==26.2.1', 'pip', 'lock', '--quiet', 'attrs==25.1.0', 'idna==3.10', '--output', 'pylock.toml'], dir)
    keep(join(dir, 'pylock.toml'), 'pylock.pip.toml')
  }),
  async foundry() {
    for (const [name, path] of Object.entries(FOUNDRY)) {
      const response = await fetch(`https://raw.githubusercontent.com/${path}/foundry.toml`)
      if (!response.ok) throw new Error(`${path}: ${response.status}`)
      writeFileSync(new URL(name, OUT), await response.text())
      recorded.push(name)
    }
  },
  async crates() {
    for (const [name, path] of Object.entries(CRATES)) {
      const crate = path.split('/')[0]
      const response = await fetch(`https://static.crates.io/crates/${crate.replace(/-[^-]+$/u, '')}/${crate}.crate`)
      if (!response.ok) throw new Error(`${crate}: ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      inTemp((dir) => {
        writeFileSync(join(dir, 'crate.tar.gz'), bytes)
        run('tar', ['-xzf', 'crate.tar.gz', path], dir)
        keep(join(dir, path), name)
      })
    }
  },
}

mkdirSync(OUT, { recursive: true })
const only = process.argv.slice(2)
for (const group of only) if (!(group in GROUPS)) throw new Error(`no group ${group}`)
for (const [group, record] of Object.entries(GROUPS)) {
  if (only.length === 0 || only.includes(group)) await record()
}

const texts = recorded.map((name) => readFileSync(new URL(name, OUT), 'utf8'))
const results = tomllib(texts)
if (results === undefined) throw new Error('python3 with tomllib is needed')
for (const [index, name] of recorded.entries()) {
  if (results[index].error !== undefined) throw new Error(`${name}: ${results[index].error}`)
  writeFileSync(new URL(`${name}.json`, OUT), `${JSON.stringify(results[index].value, null, 2)}\n`)
}
