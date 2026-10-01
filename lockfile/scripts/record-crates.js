// Records what the Rust crates src/crate/ ports make of a grid of inputs
// into tests/fixtures/crates.json, by the program in crates-oracle/: semver
// 1.0.28, which version parses and which requirement it satisfies, and
// sanitize-filename 0.6.0, on Unix and on Windows, as Soldeer calls it.
// Needs cargo and network access to crates.io:
//
//     node lockfile/scripts/record-crates.js
//
// The grid is the same at every run: versions of every major, minor and
// patch up to 2 with and without a prerelease, and others drawn at random
// from parts the crate reads and refuses, as the requirements are.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = fileURLToPath(new URL('../tests/fixtures/crates.json', import.meta.url))

let seed = 42
function random(n) {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed % n
}
const pick = (list) => list[random(list.length)]

const numbers = ['0', '1', '2', '10', '01', '18446744073709551615', '18446744073709551616']
const pres = ['', '-alpha', '-alpha.1', '-alpha.beta', '-1', '-01', '-0a', '-beta.11', '-rc-1', '-', '-a..b', '-alpha.10', '-alpha.9']
const builds = ['', '+build', '+001', '+', '+a.b']
const versions = new Set(['1', '1.2', 'v1.2.3', ' 1.2.3', '1.2.3 ', '0.0.0', '1.0.0-rc.1', ''])
for (const x of ['0', '1', '2']) for (const y of ['0', '1', '2']) for (const z of ['0', '1', '2']) for (const pre of ['', '-alpha', '-alpha.1', '-beta']) versions.add(`${x}.${y}.${z}${pre}`)
while (versions.size < 180) versions.add(`${pick(numbers.slice(0, 4))}.${pick(numbers.slice(0, 4))}.${pick(numbers)}${pick(pres)}${pick(builds)}`)

const ops = ['', '=', '>', '>=', '<', '<=', '~', '^', '= ', '>= ', '==', '=>']
const parts = ['1', '1.2', '1.1.1', '0', '0.0', '0.0.1', '0.1', '0.1.2', '1.1.1-alpha', '1.1.1-alpha.1', '0.0.1-beta', '1.*', '1.1.*', '1.x', '1.X', '1.*.*', '1.*.1', '2', '2.0.0-rc-1', '1.2-pre', '01.2', '1.1.1+meta', '18446744073709551616']
const requirements = new Set(['*', 'x', 'X', ' * ', '*, 1', '1.*.*', '1.x.X', '1.*.1', '', ',', '1,', ', 1', '>= 1.1, < 2', 'latest', 'v1', '1 2', Array.from({ length: 33 }, () => '>=0').join(','), Array.from({ length: 32 }, () => '>=0').join(',')])
while (requirements.size < 260) {
  const items = Array.from({ length: 1 + random(3) }, () => `${pick([' ', '', ''])}${pick(ops)}${pick(parts)}${pick(['', '', ' '])}`)
  requirements.add(items.join(pick([',', ', ', ' ,'])))
}

const names = ['a/b', 'a:b*c?d', 'con', 'CON.txt', 'com5.zip', 'lpt1', 'aux', 'nul.', 'a. ', '..', '.', '...', 'a\u0085b', 'a\u007Fb', 'a\tb', 'é'.repeat(200), 'x'.repeat(300), 'forge-std-1.9.4', '@openzeppelin-contracts-5.1.0']

const ORACLE = fileURLToPath(new URL('crates-oracle/', import.meta.url))
const hex = (text) => `x${Buffer.from(text).toString('hex')}`
const unhex = (line) => Buffer.from(line, 'hex').toString()

const target = mkdtempSync(join(tmpdir(), 'crates-'))
try {
  execFileSync('cargo', ['build', '--release', '--locked', '--quiet', '--target-dir', target], { cwd: ORACLE, stdio: 'inherit' })
  const input = [[...versions], [...requirements], names].map((list) => `${list.map(hex).join('\n')}\n`).join('\n')
  const out = execFileSync(join(target, 'release', 'crates-oracle'), { input: `${input}\n`, encoding: 'utf8' }).trimEnd().split('\n')
  const rows = out.slice(0, requirements.size)
  const folders = out.slice(requirements.size).map(unhex)
  // JSON, an item a line.
  const lines = (list) => `[\n${list.map((item) => JSON.stringify(item)).join(',\n')}\n]`
  const semver = `{"versions":${lines([...versions])},"requirements":${lines([...requirements].map((text, index) => [text, rows[index] === '-' ? null : rows[index]]))}}`
  writeFileSync(OUT, `{"semver":${semver},"sanitize":${lines(names.map((name, index) => [name, folders[2 * index], folders[2 * index + 1]]))}}\n`)
} finally {
  rmSync(target, { recursive: true, force: true })
}
