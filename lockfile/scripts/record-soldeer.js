// Records what Soldeer writes for the configs below into
// tests/soldeer/fixtures/, each lockfile as <name>.lock and its config as
// <name>.toml. Needs cargo, git, and network access to crates.io, the
// Soldeer registry and github.com:
//
//     node lockfile/scripts/record-soldeer.js [name...]
//
// Named, only those runs are recorded, and the others kept as they are.
// Each Soldeer is built once, with `cargo install --locked`, into
// $SOLDEER_BINS, or a folder under the system's temporary one.
//
// One config pulls in every kind of dependency Soldeer locks without an
// account: registry packages, by a version and by a range, a git
// repository by its tag and by a commit, and a zip by its URL. Soldeer
// 0.12 writes them with `version = 2` at the top, and 0.11 and 0.5, of the
// first format, with no version at all. With no dependencies, 0.12 writes
// an empty array. And 0.12, adding a dependency to a lockfile of 0.11,
// keeps its format, and writes `version = 1`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/soldeer/fixtures/', import.meta.url))
const BINS = process.env.SOLDEER_BINS ?? join(tmpdir(), 'soldeer-bins')

const HEAD = '[soldeer]\nremappings_generate = false\n\n[dependencies]\n'

const EVERY = `${HEAD}forge-std = "1.9.4"
"@openzeppelin-contracts" = "~5.1.0"
solady = { version = "0.0.238" }
isarray = { version = "2.0.5", git = "https://github.com/juliangruber/isarray.git", tag = "v2.0.5" }
is-number = { version = "7.0.0", git = "https://github.com/jonschlinkert/is-number.git", rev = "98e8ff1da1a89f93d1397a24d7413ed15421c139" }
oz = { version = "5.1.0", url = "https://soldeer-revisions.s3.amazonaws.com/@openzeppelin-contracts/5_1_0_19-10-2024_10:28:52_contracts.zip" }
`

const RUNS = [
  { name: 'soldeer-0.12.0', soldeer: '0.12.0', config: EVERY },
  { name: 'soldeer-0.11.0', soldeer: '0.11.0', config: EVERY },
  { name: 'soldeer-0.5.4', soldeer: '0.5.4', config: EVERY },
  { name: 'soldeer-0.12.0-empty', soldeer: '0.12.0', config: HEAD },
  // 0.11 locks forge-std, then 0.12 adds solady to that lockfile.
  { name: 'soldeer-0.12.0-legacy', soldeer: '0.11.0', config: `${HEAD}forge-std = "1.9.4"\n`, after: { soldeer: '0.12.0', add: ['solady~0.0.238'] } },
]

function soldeer(version) {
  const bin = join(BINS, version, 'bin', 'soldeer')
  if (!existsSync(bin)) execFileSync('cargo', ['install', 'soldeer', '--version', version, '--locked', '--root', join(BINS, version)], { stdio: 'inherit' })
  return bin
}

const only = process.argv.slice(2)

for (const run of RUNS.filter(({ name }) => only.length === 0 || only.includes(name))) {
  const dir = mkdtempSync(join(tmpdir(), `${run.name}-`))
  try {
    writeFileSync(join(dir, 'soldeer.toml'), run.config)
    execFileSync(soldeer(run.soldeer), ['install'], { cwd: dir, stdio: 'inherit' })
    if (run.after !== undefined) execFileSync(soldeer(run.after.soldeer), ['install', ...run.after.add], { cwd: dir, stdio: 'inherit' })
    mkdirSync(OUT, { recursive: true })
    writeFileSync(join(OUT, `${run.name}.lock`), readFileSync(join(dir, 'soldeer.lock'), 'utf8'))
    writeFileSync(join(OUT, `${run.name}.toml`), readFileSync(join(dir, 'soldeer.toml'), 'utf8'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
