// Records tests/cargo/fixtures/: a small workspace cargo locks and vendors,
// and what cargo itself makes of it, for cargo.js to be held to. Needs
// cargo and rustc, with network access to crates.io and GitHub; the names
// of groups below, if given, record those alone:
//
//     node lockfile/scripts/record-cargo.js [workspace oracle]
//
// workspace: the workspace below, its Cargo.lock and vendor/ as `cargo
// vendor` writes them, and in workspace.json what cargo reports: which
// vendored directory each package is read from (`cargo metadata`, with
// vendor/ in place of crates.io), the graph of the lockfile with each
// edge's kinds and platforms (`cargo metadata --all-features`), and the
// features each package is built with (`cargo build --unit-graph`), for a
// few command lines, under resolver 1 and 2; null where cargo refuses one.
//
// oracle: in oracle.json, what the semver crate reads of some version
// requirements and which versions each matches, and what the
// cargo-platform crate reads of some platforms and whether each matches
// the host.

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'

const OUT = new URL('../tests/cargo/fixtures/', import.meta.url).pathname
const env = { ...process.env, __CARGO_TEST_CHANNEL_OVERRIDE_DO_NOT_USE_THIS: 'nightly', CARGO_TERM_COLOR: 'never' }
const run = (cwd, command, args, input) => execFileSync(command, args, { cwd, env, input, maxBuffer: 1 << 28, stdio: ['pipe', 'pipe', 'inherit'] }).toString()

// Two versions of itoa from crates.io and a third from git; a proc-macro
// member and a build-dependency; memchr asked for different features by
// kind and platform; weak and `dep:` features; a [patch] of cfg-if with a
// path; a path dependency outside the workspace; inherited fields.
const WORKSPACE = {
  'Cargo.toml': `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[workspace]
members = ["crates/*"]
exclude = ["crates/extra", "patched/cfg-if"]

[workspace.package]
version = "0.2.0"
edition = "2021"

[workspace.dependencies]
memchr = { version = "2", default-features = false }
itoa = "1"

[features]
default = ["fast"]
fast = ["memchr/std", "lib/std"]
fmt = ["dep:itoa04", "itoa04?/i128"]
git = ["dep:itoa-git"]

[dependencies]
lib = { path = "crates/lib" }
macros = { path = "crates/macros" }
memchr = { workspace = true }
itoa = { workspace = true }
itoa04 = { package = "itoa", version = "0.4", optional = true, default-features = false }
itoa-git = { package = "itoa", git = "https://github.com/dtolnay/itoa", tag = "1.0.0", optional = true }

[target.'cfg(windows)'.dependencies]
cfg-if = "1"

[build-dependencies]
autocfg = "1"

[dev-dependencies]
paste = "1"

[patch.crates-io]
cfg-if = { path = "patched/cfg-if" }
`,
  'src/lib.rs': '',
  'build.rs': 'fn main() {}\n',
  'crates/lib/Cargo.toml': `[package]
name = "lib"
version.workspace = true
edition.workspace = true

[features]
std = ["memchr?/std"]
extra = ["dep:extra"]

[dependencies]
memchr = { workspace = true, optional = true }
extra = { path = "../extra", optional = true }

[target.'cfg(unix)'.dependencies]
memchr = { workspace = true, features = ["alloc"] }
`,
  'crates/lib/src/lib.rs': '',
  'crates/macros/Cargo.toml': `[package]
name = "macros"
version = "0.1.0"
edition = "2018"

[lib]
proc-macro = true

[dependencies]
memchr = { version = "2", default-features = false, features = ["alloc"] }
`,
  'crates/macros/src/lib.rs': '',
  'crates/extra/Cargo.toml': `[package]
name = "extra"
version = "0.3.0"

[dependencies]
cfg-if = "1"

[dev-dependencies]
paste = "1"
`,
  'crates/extra/src/lib.rs': '',
  'patched/cfg-if/Cargo.toml': `[package]
name = "cfg-if"
version = "1.0.0"
edition = "2018"
`,
  'patched/cfg-if/src/lib.rs': '',
}

const TARGETS = ['x86_64-unknown-linux-gnu', 'x86_64-pc-windows-msvc', 'aarch64-apple-darwin']
const BUILDS = [
  { packages: 'all' },
  { packages: 'all', dev: true },
  { packages: ['app'], features: ['fmt,git'], target: 'x86_64-pc-windows-msvc' },
  { packages: ['app'], noDefaultFeatures: true, features: ['lib/extra memchr/alloc'] },
  { packages: ['lib', 'macros'], features: ['std'], target: 'aarch64-apple-darwin' },
  { packages: 'all', allFeatures: true, target: 'aarch64-apple-darwin' },
]

function recordWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), 'record-cargo-'))
  try {
    for (const [path, text] of Object.entries(WORKSPACE)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true })
      writeFileSync(join(dir, path), text)
    }
    run(dir, 'cargo', ['generate-lockfile'])
    const config = run(dir, 'cargo', ['vendor', '--locked', 'vendor'])
    mkdirSync(join(dir, '.cargo'))
    writeFileSync(join(dir, '.cargo', 'config.toml'), config)

    const out = join(OUT, 'workspace')
    rmSync(out, { recursive: true, force: true })
    for (const path of Object.keys(WORKSPACE).filter((file) => file.endsWith('Cargo.toml'))) cpSync(join(dir, path), join(out, path))
    cpSync(join(dir, 'Cargo.lock'), join(out, 'Cargo.lock'))
    for (const name of readdirSync(join(dir, 'vendor'))) {
      for (const file of ['Cargo.toml', '.cargo-checksum.json']) cpSync(join(dir, 'vendor', name, file), join(out, 'vendor', name, file))
    }

    const meta = JSON.parse(run(dir, 'cargo', ['metadata', '--format-version', '1', '--offline', '--all-features']))
    const keyOf = new Map(meta.packages.map((p) => [p.id, p.source === null ? `${p.name} ${p.version}` : `${p.name} ${p.version} (${p.source})`]))
    const manifests = {}
    const vendored = {}
    for (const p of meta.packages) {
      const path = relative(dir, p.manifest_path).split('\\').join('/')
      if (p.source === null) manifests[keyOf.get(p.id)] = path
      else vendored[keyOf.get(p.id)] = path.split('/')[1]
    }
    const graph = {}
    for (const node of meta.resolve.nodes) {
      graph[keyOf.get(node.id)] = Object.fromEntries(node.deps.map((dep) => [
        keyOf.get(dep.pkg),
        dep.dep_kinds.map((k) => `${k.kind ?? 'normal'} ${k.target ?? '*'}`).sort(),
      ]))
    }
    const cfg = Object.fromEntries(TARGETS.map((target) => [target, run(dir, 'rustc', ['--print', 'cfg', '--target', target]).trim().split('\n')]))
    const host = /host: (\S+)/u.exec(run(dir, 'rustc', ['-vV']))[1]
    const features = {}
    for (const resolver of ['1', '2']) {
      const root = WORKSPACE['Cargo.toml'].replace('[workspace]\n', `[workspace]\nresolver = "${resolver}"\n`)
      writeFileSync(join(dir, 'Cargo.toml'), root)
      features[resolver] = BUILDS.map((build) => {
        const args = [
          'build', '--offline', '--unit-graph', '-Z', 'unstable-options', '--target', build.target ?? host,
          ...(build.packages === 'all' ? ['--workspace'] : build.packages.flatMap((name) => ['-p', name])),
        ]
        if (build.features !== undefined) args.push('--features', build.features.join(' '))
        if (build.allFeatures) args.push('--all-features')
        if (build.noDefaultFeatures) args.push('--no-default-features')
        if (build.dev) args.push('--all-targets')
        let units
        try {
          units = JSON.parse(execFileSync('cargo', args, { cwd: dir, env, maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'] }).toString()).units
        } catch {
          return { ...build, built: null }
        }
        const built = {}
        for (const unit of units) {
          if (unit.target.kind.includes('custom-build')) continue
          built[`${keyOf.get(unit.pkg_id)} ${unit.platform === null ? 'host' : 'normal'}`] = unit.features
        }
        return { ...build, built }
      })
    }
    const members = meta.workspace_members.map((id) => keyOf.get(id))
    writeFileSync(join(OUT, 'workspace.json'), `${JSON.stringify({ host, cfg, members, manifests, vendored, graph, features }, null, 2)}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Requirements and platforms of every form the crates read, and some they
// refuse; each against every version, or the host.
const REQUIREMENTS = [
  '1', '1.2', '1.2.3', '^0.1.2', '^0.0.3', '^0.0', '~1', '~1.2', '~1.2.3', '=1.2.3', '>1.2', '>=1.2.3', '<2', '<=1.2.3',
  '*', 'x', ' * ', '1.*', '1.2.*', '1.x.x', '>=1.*', '>= 1.2, < 1.5', '1.2.3-alpha', '^1.2.3-alpha.1', '>=1.2.3-beta, <2',
  '=0.0.0-0', '1.2.3+build', ' 1', '1, 2', '0.1.0-rc.1, <0.2',
  '', '1.', '01', '1.2.3.4', '~>1', '==1', '=>1', '1.*.3', '1.2-alpha', '>=1 <2', '1 || 2', '*, 1', '1,', 'v1', '1.2.3-', '1.2.3-01',
]
const VERSIONS = ['0.0.0-0', '0.0.3', '0.0.4', '0.1.2', '0.1.9', '0.2.0', '1.0.0', '1.2.0', '1.2.3', '1.2.3-alpha', '1.2.3-alpha.1', '1.2.3-beta', '1.2.4', '1.3.0-rc.1', '1.4.9', '1.5.0', '2.0.0', '2.0.0-alpha']
const PLATFORMS = [
  'cfg(unix)', 'cfg(windows)', 'cfg(r#unix)', 'cfg(target_os = "linux")', 'cfg(target_os="linux")', 'cfg(all())', 'cfg(any())',
  'cfg(all(unix, target_arch = "x86_64",))', 'cfg(not(windows))', 'cfg(true)', 'cfg(false)', 'cfg( unix )', 'x86_64-unknown-linux-gnu',
  'wasm32-unknown-unknown', 'x86_64-pc-windows-msvc.json',
  'cfg()', 'cfg(all)', 'cfg(unix windows)', 'cfg(a = b)', 'cfg("x")', 'cfg(not(a, b))', 'cfg(a\t)', 'foo(bar)', 'cfg(r#1)', 'cfg(a = "x)', '',
  ' cfg(unix)', 'cfg (unix)',
]
const ORACLE = `use std::io::BufRead;
use std::str::FromStr;
fn main() {
    for line in std::io::stdin().lock().lines() {
        let v: serde_json::Value = serde_json::from_str(&line.unwrap()).unwrap();
        let text = v[1].as_str().unwrap();
        let out = if v[0] == "req" {
            match semver::VersionReq::parse(text) {
                Err(_) => serde_json::Value::Null,
                Ok(req) => v[2].as_array().unwrap().iter().map(|ver| serde_json::Value::Bool(req.matches(&semver::Version::parse(ver.as_str().unwrap()).unwrap()))).collect(),
            }
        } else {
            match cargo_platform::Platform::from_str(text) {
                Err(_) => serde_json::Value::Null,
                Ok(p) => {
                    let cfg: Vec<cargo_platform::Cfg> = v[2].as_array().unwrap().iter().map(|l| cargo_platform::Cfg::from_str(l.as_str().unwrap()).unwrap()).collect();
                    serde_json::Value::Bool(p.matches(v[3].as_str().unwrap(), &cfg))
                }
            }
        };
        println!("{}", out);
    }
}
`

function recordOracle() {
  const dir = mkdtempSync(join(tmpdir(), 'record-oracle-'))
  try {
    run(dir, 'cargo', ['init', '--name', 'oracle', '--vcs', 'none', '.'])
    writeFileSync(join(dir, 'Cargo.toml'), readFileSync(join(dir, 'Cargo.toml'), 'utf8') + 'semver = "=1.0.27"\ncargo-platform = "=0.3.0"\nserde_json = "1"\n')
    writeFileSync(join(dir, 'src', 'main.rs'), ORACLE)
    run(dir, 'cargo', ['build', '--release', '--quiet'])
    const host = /host: (\S+)/u.exec(run(dir, 'rustc', ['-vV']))[1]
    const cfg = run(dir, 'rustc', ['--print', 'cfg']).trim().split('\n')
    const cases = [...REQUIREMENTS.map((text) => ['req', text, VERSIONS]), ...PLATFORMS.map((text) => ['cfg', text, cfg, host])]
    const answers = run(dir, join(dir, 'target', 'release', 'oracle'), [], cases.map((c) => JSON.stringify(c)).join('\n') + '\n').trim().split('\n').map((line) => JSON.parse(line))
    const requirements = Object.fromEntries(REQUIREMENTS.map((text, i) => [text, answers[i]]))
    const platforms = Object.fromEntries(PLATFORMS.map((text, i) => [text, answers[REQUIREMENTS.length + i]]))
    writeFileSync(join(OUT, 'oracle.json'), `${JSON.stringify({ versions: VERSIONS, host: { name: host, cfg }, requirements, platforms }, null, 2)}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const GROUPS = { workspace: recordWorkspace, oracle: recordOracle }
mkdirSync(OUT, { recursive: true })
for (const name of process.argv.length > 2 ? process.argv.slice(2) : Object.keys(GROUPS)) {
  if (!(name in GROUPS)) throw new Error(`no group ${name}: expected ${Object.keys(GROUPS).join(', ')}`)
  GROUPS[name]()
}
