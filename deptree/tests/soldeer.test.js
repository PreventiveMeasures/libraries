import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createVfs } from '@preventive/vfs'
import { LockfileError, buildSoldeerTree } from '../soldeer.js'
import { rawZip, sha256, slowed, stubSoldeer } from './registry.js'

const HOST = Object.freeze({ soldeer: '0.12.0', os: 'linux' })
const ZERO = '0'.repeat(64)

const dependency = (name, version, entries) => ({ name, version, bytes: rawZip(entries) })

// soldeer.lock for the zips, as Soldeer 0.12 writes it, sorted by name.
function lockOf(zips, extra = []) {
  const entries = [
    ...zips.map((z) => ({ name: z.name, text: `name = "${z.name}"\nversion = "${z.version}"\nurl = "https://soldeer-revisions.s3.amazonaws.com/${z.name}/x.zip"\nchecksum = "${sha256(z.bytes)}"\nintegrity = "${ZERO}"` })),
    ...extra,
  ].toSorted((a, b) => (a.name < b.name ? -1 : 1))
  return `version = 2\n\n${entries.map((e) => `[[dependencies]]\n${e.text}`).join('\n\n')}\n`
}

const configOf = (zips) => `[dependencies]\n${zips.map((z) => `${z.name} = "${z.version}"`).join('\n')}\n`

function listing(vfs) {
  const out = {}
  for (const { path, type } of vfs.walk('/')) {
    if (path === '/') continue
    const { mode } = vfs.lstat(path)
    out[path.slice(1)] = type === 'directory' ? `dir ${mode.toString(8)}` : `${mode.toString(8)} ${vfs.readText(path)}`
  }
  return out
}

// soldeer.toml is the zips' config unless `foundry` or `soldeer` is given,
// which is left out where it is undefined.
async function build(zips, { foundry, lockfile = lockOf(zips), host = HOST, vfs, ...rest } = {}) {
  stubSoldeer(zips)
  const soldeer = 'soldeer' in rest || foundry !== undefined ? rest.soldeer : configOf(zips)
  return await buildSoldeerTree({ lockfile, foundry, soldeer, host, vfs })
}

describe('buildSoldeerTree', () => {
  it('extracts each zip in a folder of its own, as Soldeer does', async () => {
    const zip = dependency('forge-std', '1.9.4', [
      { name: 'src/Test.sol', data: 'test' },
      { name: 'run.sh', data: 'run', mode: 0o100775 },
      { name: 'suid', data: 's', mode: 0o104755 },
      { name: 'open', data: 'o', mode: 0o100666 },
      { name: 'unix-none', data: 'u', attributes: 0x20 },
      { name: 'dos', data: 'd', system: 0, attributes: 0x20 },
      { name: 'dos-ro', data: 'r', system: 0, attributes: 0x21 },
      { name: 'ntfs', data: 'n', system: 10, attributes: 0 },
      { name: 'ntfs-mode', data: 'm', system: 10, mode: 0o100700 },
      { name: 'link', data: 'src/Test.sol', mode: 0o120777 },
      { name: 'only/', mode: 0o40700 },
      { name: 'deep/er/f', data: 'f' },
      { name: '.gitignore', data: 'g' },
      { name: '.gitx/', mode: 0o40755 },
      { name: '.git/config', data: 'c' },
      { name: 'sub/.GIT./x', data: 'x' },
      { name: 'sub/.git /y', data: 'y' },
    ])
    // Soldeer passes over what is under a `.git` before it makes any
    // directory on the way, so `sub` is not made.
    const { vfs, stats } = await build([zip])
    assert.deepEqual(listing(vfs), {
      'dependencies': 'dir 755',
      'dependencies/forge-std-1.9.4': 'dir 755',
      'dependencies/forge-std-1.9.4/src': 'dir 755',
      'dependencies/forge-std-1.9.4/src/Test.sol': '644 test',
      'dependencies/forge-std-1.9.4/run.sh': '755 run',
      'dependencies/forge-std-1.9.4/suid': '755 s',
      'dependencies/forge-std-1.9.4/open': '644 o',
      'dependencies/forge-std-1.9.4/unix-none': '0 u',
      'dependencies/forge-std-1.9.4/dos': '644 d',
      'dependencies/forge-std-1.9.4/dos-ro': '444 r',
      'dependencies/forge-std-1.9.4/ntfs': '644 n',
      'dependencies/forge-std-1.9.4/ntfs-mode': '700 m',
      'dependencies/forge-std-1.9.4/link': '644 src/Test.sol',
      'dependencies/forge-std-1.9.4/only': 'dir 755',
      'dependencies/forge-std-1.9.4/deep': 'dir 755',
      'dependencies/forge-std-1.9.4/deep/er': 'dir 755',
      'dependencies/forge-std-1.9.4/deep/er/f': '644 f',
      'dependencies/forge-std-1.9.4/.gitignore': '644 g',
      'dependencies/forge-std-1.9.4/.gitx': 'dir 755',
    })
    assert.deepEqual(stats, { dependencies: 1, files: 12, bytes: 28 })
  })

  it('lists what it installs, as an SBOM would take it, in the lockfile\'s order', async () => {
    const zips = [dependency('solady', '0.1.0', [{ name: 'a', data: 'a' }]), dependency('forge-std', '1.9.4', [{ name: 'b', data: 'b' }])]
    const { installed } = await build(zips)
    assert.deepEqual(installed, [
      { path: 'dependencies/forge-std-1.9.4', name: 'forge-std', version: '1.9.4', checksum: sha256(zips[1].bytes) },
      { path: 'dependencies/solady-0.1.0', name: 'solady', version: '0.1.0', checksum: sha256(zips[0].bytes) },
    ])
  })

  // The zip crate keys entries by name: of two, the later is read, where
  // the first was. The archive reader takes both, as it reads one mode of
  // them, from neither's Unix attributes.
  it('extracts the later of two entries of one name', async () => {
    const entries = [{ name: 'dup', data: 'x', system: 10, attributes: 0 }, { name: 'dup', data: 'x', system: 0, attributes: 0x01 }]
    const modeOf = async (zip) => (await build([zip])).vfs.lstat(`/dependencies/${zip.name}-${zip.version}/dup`).mode
    assert.equal(await modeOf(dependency('dup-pkg', '1.0.0', entries)), 0o444)
    assert.equal(await modeOf(dependency('dup-pkg', '1.0.1', entries.toReversed())), 0o644)
  })

  it('reads foundry.toml where it has a [dependencies] table, else soldeer.toml', async () => {
    const zip = dependency('solady', '0.0.238', [{ name: 'src/A.sol', data: 'a' }])
    const installed = async (options) => Object.keys(listing((await build([zip], options)).vfs)).length
    assert.equal(await installed({ foundry: `[profile.default]\nlibs = ["lib", { a = 1 }]\n\n${configOf([zip])}` }), 4)
    assert.equal(await installed({ foundry: `dependencies.solady = "0.0.238"\n` }), 4)
    assert.equal(await installed({ foundry: `[dependencies.solady]\nversion = "0.0.238"\n` }), 4)
    assert.equal(await installed({}), 4)
    const refused = (options, message) => assert.rejects(build([zip], options), message)
    await refused({ foundry: 'dependencies = { solady = "0.0.238" }\n' }, /^DeptreeError: foundry\.toml: no \[dependencies\] table, so Soldeer asks which file to make its config, which is not supported$/u)
    await refused({ foundry: '[profile.default]\n' }, /^DeptreeError: foundry\.toml: no \[dependencies\] table/u)
    await refused({ soldeer: 'dependencies = { solady = "0.0.238" }\n' }, /^DeptreeError: soldeer\.toml: dependencies: not a table, which Soldeer reads no dependencies from, is not supported$/u)
    await refused({ soldeer: undefined }, /^DeptreeError: neither foundry\.toml nor soldeer\.toml is there, so Soldeer asks which file to make its config, which is not supported$/u)
    await refused({ foundry: `profile = 1\n${configOf([zip])}` }, /^DeptreeError: foundry\.toml: profile: not a table, which Soldeer fails on$/u)
    await refused({ foundry: `[profile]\ndefault = { libs = [] }\n${configOf([zip])}` }, /^DeptreeError: foundry\.toml: profile\.default: not a table, which Soldeer fails on$/u)
    await refused({ foundry: `[profile.default]\nlibs = "lib"\n${configOf([zip])}` }, /^DeptreeError: foundry\.toml: profile\.default\.libs: not an array, which Soldeer fails on$/u)
    await refused({ foundry: `[[profile.default.libs]]\na = 1\n${configOf([zip])}` }, /^DeptreeError: foundry\.toml: profile\.default\.libs: not an array/u)
    await refused({ foundry: `${configOf([zip])}x = \n` }, /^DeptreeError: foundry\.toml: not TOML read here: /u)
  })

  it('holds the [soldeer] settings to what Soldeer reads', async () => {
    const zip = dependency('solady', '0.0.238', [{ name: 'a', data: 'a' }])
    const withSettings = (settings) => build([zip], { soldeer: `${settings}\n${configOf([zip])}` })
    await withSettings('[soldeer]\nremappings_generate = false\nremappings_location = "config"\nremappings_prefix = "@"\nother = [1]')
    await withSettings('soldeer = { recursive_deps = false }')
    const refused = (settings, message) => assert.rejects(withSettings(settings), message)
    await refused('[soldeer]\nremappings_version = "yes"', /^DeptreeError: soldeer\.toml: soldeer\.remappings_version: not true or false, which Soldeer fails on$/u)
    await refused('[soldeer]\nremappings_location = "toml"', /^DeptreeError: soldeer\.toml: soldeer\.remappings_location: not "txt" or "config", which Soldeer fails on$/u)
    await refused('[soldeer]\nremappings_prefix = 1', /^DeptreeError: soldeer\.toml: soldeer\.remappings_prefix: not a string/u)
    await refused('soldeer = 1', /^DeptreeError: soldeer\.toml: soldeer: not a table, which Soldeer fails on$/u)
    await refused('[soldeer]\nrecursive_deps = true', /^DeptreeError: soldeer\.toml: soldeer\.recursive_deps: has Soldeer install what each dependency depends on too, which is not supported$/u)
  })

  it('refuses in a zip what Soldeer fails on, or the zip crate reads otherwise', async () => {
    const timestamp = (body) => Buffer.concat([Buffer.from([0x55, 0x54, body.length, 0]), Buffer.from(body)])
    const ntfs = (tag) => { const body = Buffer.alloc(36); body.writeUInt16LE(0x000a, 0); body.writeUInt16LE(32, 2); body.writeUInt16LE(tag, 8); body.writeUInt16LE(24, 10); return body }
    let version = 0
    const refused = (entry, message) => assert.rejects(build([dependency('zip-pkg', `1.0.${version++}`, [entry])]), message)
    await refused({ name: 'x/a:b', data: '' }, /^DeptreeError: dependencies\["zip-pkg"\]: "x\/a:b": a name with a ":" in it, which Soldeer fails on$/u)
    await refused({ name: 'a', data: '', extra: timestamp([]) }, /: an extended timestamp the zip crate does not read, which Soldeer fails on$/u)
    await refused({ name: 'a', data: '', extra: timestamp([1, 0, 0, 0, 0, 0, 0, 0, 0]) }, /an extended timestamp the zip crate does not read/u)
    await refused({ name: 'a', data: '', extra: ntfs(2) }, /: an NTFS extra field the zip crate does not read, which Soldeer fails on$/u)
    await refused({ name: 'a', data: '', extra: Buffer.from([0x01, 0x99, 0, 0]) }, /: an AES extra field, which has the zip crate decrypt the entry, which Soldeer fails on$/u)
    await refused({ name: 'é', data: '' }, /: a name not flagged UTF-8, which Soldeer reads as CP437, is not supported$/u)
    await refused({ name: '../a', data: '' }, /^DeptreeError: dependencies\["zip-pkg"\]: its zip cannot be read: /u)
    // A leading U+FEFF is part of a name, as Soldeer extracts it.
    const fine = [{ name: 'é', data: '', flags: 0x800 }, { name: '\uFEFFb', data: '', flags: 0x800 }, { name: 'a', data: '', extra: Buffer.concat([timestamp([1, 0, 0, 0, 0]), timestamp([3, 0, 0, 0, 0, 0, 0, 0, 0]), ntfs(1)]) }]
    const { vfs } = await build([dependency('zip-pkg', '2.0.0', fine)])
    assert.deepEqual(vfs.readdir('/dependencies/zip-pkg-2.0.0').sort(), ['a', 'é', '\uFEFFb'])
  })

  it('refuses a dependency from anywhere but the registry', async () => {
    const zip = dependency('forge-std', '1.9.4', [{ name: 'a', data: 'a' }])
    const git = { name: 'isarray', text: `name = "isarray"\nversion = "2.0.5"\ngit = "https://github.com/juliangruber/isarray.git"\nrev = "${'6'.repeat(40)}"` }
    await assert.rejects(build([zip], { lockfile: lockOf([zip], [git]), soldeer: `${configOf([zip])}isarray = { version = "2.0.5", git = "https://github.com/juliangruber/isarray.git" }\n` }), /^DeptreeError: dependencies\["isarray"\]: a git dependency, which Soldeer clones with its history, is not supported$/u)
    const priv = { name: 'secret', text: `name = "secret"\nversion = "1.0.0"\nchecksum = "${ZERO}"\nintegrity = "${ZERO}"` }
    await assert.rejects(build([zip], { lockfile: lockOf([zip], [priv]), soldeer: `${configOf([zip])}secret = "1.0.0"\n` }), /^DeptreeError: dependencies\["secret"\]: a private dependency, which the registry hands out to those signed in alone, is not supported$/u)
    await assert.rejects(build([zip], { soldeer: '[dependencies]\nforge-std = { version = "1.9.4", url = "https://soldeer-revisions.s3.amazonaws.com/forge-std/x.zip" }\n' }), /^DeptreeError: dependencies\["forge-std"\]: a dependency from a URL of its own, rather than the registry, is not supported$/u)
  })

  it('holds each zip to the lockfile\'s checksum, and the lockfile to the config', async () => {
    const zip = dependency('forge-std', '1.9.4', [{ name: 'a', data: 'a' }])
    await assert.rejects(build([{ ...zip, bytes: rawZip([{ name: 'a', data: 'b' }]) }], { lockfile: lockOf([zip]) }), /integrity mismatch/u)
    await assert.rejects(build([zip], { soldeer: '[dependencies]\nforge-std = "1.9.5"\n' }), LockfileError)
  })

  it('refuses a folder another dependency\'s zip is downloaded as', async () => {
    const zips = [dependency('foo', '1-0', [{ name: 'a', data: 'a' }]), dependency('foo-1', '0.zip', [{ name: 'a', data: 'a' }])]
    const calls = stubSoldeer(zips)
    await assert.rejects(buildSoldeerTree({ lockfile: lockOf(zips), soldeer: configOf(zips), host: HOST }), /^DeptreeError: dependencies\["foo"\]: its zip is downloaded as "foo-1-0\.zip", a folder Soldeer installs another dependency in$/u)
    assert.deepEqual(calls, [])
    // On macOS, a folder of another case is the zip's too.
    const cased = [zips[0], dependency('foo-1', '0.ZIP', [{ name: 'a', data: 'a' }])]
    await build(cased)
    await assert.rejects(build(cased, { host: { ...HOST, os: 'darwin' } }), /^DeptreeError: dependencies\["foo"\]: its zip is downloaded as "foo-1-0\.zip", a folder Soldeer installs another dependency in$/u)
  })

  it('refuses a zip whose entries come to more than 512 MiB', async () => {
    const zip = dependency('big-pkg', '1.0.0', [{ name: 'a', data: 'a', deflate: true, size: 512 * 1024 * 1024 + 1 }])
    await assert.rejects(build([zip]), /^DeptreeError: dependencies\["big-pkg"\]: its zip cannot be read: the entries come to more than 536870912 bytes/u)
  })

  it('refuses once every fetch started has ended', async () => {
    const zips = [dependency('aaa-pkg', '1.0.0', [{ name: 'a', data: 'a' }]), dependency('bbb-pkg', '1.0.0', [{ name: 'b', data: 'b' }])]
    stubSoldeer(zips)
    // aaa-pkg's registry answers it has none, at once; bbb-pkg's zip comes late.
    const count = slowed(20, (input) => (input.includes('aaa-pkg') ? Response.json({ status: 'success', data: [] }) : undefined))
    await assert.rejects(buildSoldeerTree({ lockfile: lockOf(zips), soldeer: configOf(zips), host: HOST }), /^DeptreeError: dependencies\["aaa-pkg"\]: /u)
    assert.equal(count.open, 0)
  })

  it('fetches eight zips at a time', async () => {
    const zips = Array.from({ length: 12 }, (_, i) => dependency(`pkg-${String.fromCodePoint(108 - i)}`, '1.0.0', [{ name: 'a', data: String(i) }]))
    stubSoldeer(zips)
    const count = slowed(5)
    const { vfs, stats } = await buildSoldeerTree({ lockfile: lockOf(zips), soldeer: configOf(zips), host: HOST })
    assert.equal(count.most, 8)
    assert.equal(stats.dependencies, 12)
    assert.deepEqual(vfs.readdir('/dependencies'), zips.map((z) => `${z.name}-1.0.0`).sort())
  })

  it('refuses on macOS two names that are one there', async () => {
    const zip = dependency('case-pkg', '1.0.0', [{ name: 'A.sol', data: 'a' }, { name: 'a.sol', data: 'b' }])
    await build([zip])
    await assert.rejects(build([zip], { host: { ...HOST, os: 'darwin' } }), /^DeptreeError: "\/dependencies\/case-pkg-1\.0\.0": "A\.sol" and "a\.sol" are one name on macOS$/u)
  })

  it('takes the host, the files and the Vfs it is given, and nothing else', async () => {
    const zip = dependency('forge-std', '1.9.4', [{ name: 'a', data: 'a' }])
    await assert.rejects(build([zip], { host: { ...HOST, soldeer: '0.11.0' } }), /^DeptreeError: host\.soldeer: Soldeer "0\.11\.0" is not supported: only Soldeer 0\.12\.0 is$/u)
    await assert.rejects(build([zip], { host: { ...HOST, os: 'win32' } }), /^DeptreeError: host\.os: Windows is not supported/u)
    await assert.rejects(buildSoldeerTree({ host: HOST }), TypeError)
    await assert.rejects(buildSoldeerTree({ lockfile: lockOf([zip]), soldeer: 1, host: HOST }), TypeError)

    const project = createVfs({ 'soldeer.toml': configOf([zip]), 'soldeer.lock': lockOf([zip]), node_modules: { type: 'directory' } })
    stubSoldeer([zip])
    const { vfs } = await buildSoldeerTree({ project, host: HOST, vfs: project })
    assert.equal(vfs, project)
    assert.deepEqual(project.readdir('/').sort(), ['dependencies', 'node_modules', 'soldeer.lock', 'soldeer.toml'])
    assert.equal(project.readText('/dependencies/forge-std-1.9.4/a'), 'a')
    await assert.rejects(buildSoldeerTree({ project, host: HOST, vfs: project }), /^DeptreeError: vfs\["\/dependencies"\]: a dependencies folder is there already, which is neither kept beside the tree nor removed$/u)
    // soldeer.toml is not read where foundry.toml is, whatever it is.
    const foundry = createVfs({ 'foundry.toml': configOf([zip]), 'soldeer.lock': lockOf([zip]), 'soldeer.toml': { type: 'directory' } })
    assert.equal((await buildSoldeerTree({ project: foundry, host: HOST })).stats.dependencies, 1)
    project.unlink('/soldeer.lock')
    await assert.rejects(buildSoldeerTree({ project, host: HOST }), /^DeptreeError: the project has no soldeer\.lock, without which Soldeer resolves each dependency anew$/u)
  })
})
