import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parsePodfileLock } from '../../cocoapods.js'
import { FIXTURES } from './fixtures.js'

// Real lockfiles, as CocoaPods writes them: one iOS app that asks for every
// kind of pod a Podfile.lock records, by CocoaPods 1.17, 1.16, 1.15, 1.12
// and 1.10, and one with no pods. scripts/record-cocoapods.js records them,
// and the Podfile of each, into fixtures.json.br; its header says what is
// in them.

const text = (name) => FIXTURES[name].lock
const podfile = (name) => FIXTURES[name].podfile
const read = (name) => parsePodfileLock(text(name), { podfile: podfile(name) })
const VERSIONS = ['1.17.0', '1.16.2', '1.15.2', '1.12.1', '1.10.2']
const plain = (value) => structuredClone(value)

const COMMIT = '529bfcb6a47276296d202b94a9c49ad6a10b6da2'

describe('every version reads to the same lockfile', () => {
  const locks = Object.fromEntries(VERSIONS.map((version) => [version, read(`cocoapods-${version}`)]))

  it('but for the version that wrote it', () => {
    for (const version of VERSIONS) {
      const { cocoapods, ...rest } = locks[version]
      assert.equal(cocoapods, version)
      const { cocoapods: _, ...latest } = locks['1.17.0']
      assert.deepEqual(plain(rest), plain(latest), version)
    }
  })
})

describe('CocoaPods 1.17', () => {
  const lock = read('cocoapods-1.17.0')

  it('every pod, roots and subspecs, with what each podspec depends on', () => {
    assert.equal(Object.keys(lock.pods).length, 17)
    assert.deepEqual(plain(lock.pods.Moya), { name: 'Moya', root: 'Moya', version: '15.0.0', dependencies: [{ name: 'Moya/Core', requirements: ['= 15.0.0'] }] })
    assert.deepEqual(plain(lock.roots.Reusable.pods), ['Reusable', 'Reusable/Storyboard', 'Reusable/View'])
    assert.deepEqual(plain(lock.roots.LocalPod.pods), ['LocalPod', 'LocalPod/Core', 'LocalPod/Extra', 'LocalPod/Tests'])
  })

  it('a dependency on macOS alone, of a pod nothing installs there', () => {
    assert.deepEqual(plain(lock.pods['LocalPod/Extra'].dependencies), [{ name: 'Kingfisher', requirements: ['~> 7.0'] }, { name: 'LocalPod/Core', requirements: [] }])
    assert.equal(lock.pods.Kingfisher, undefined)
  })

  it('what the Podfile asks for, by requirements and by external sources', () => {
    const byName = Object.fromEntries(lock.dependencies.map((dependency) => [dependency.name, dependency]))
    assert.deepEqual(plain(byName.SnapKit), { name: 'SnapKit', requirements: ['< 6.0', '>= 5.0'], external: false })
    assert.deepEqual(plain(byName['Artsy+UIColors']), { name: 'Artsy+UIColors', requirements: ['= 3.0.1'], external: false })
    assert.deepEqual(lock.dependencies.filter((dependency) => dependency.external).map((dependency) => dependency.name), [
      'HttpPod', 'KeychainAccess', 'LocalPod', 'LocalPod/Extra', 'LocalPod/Tests', 'Reusable', 'SpecPod', 'SwiftyJSON', 'Then',
    ])
  })

  it('the spec repos, the trunk CDN\'s and one of its own, of a name CocoaPods quotes', () => {
    const repos = Object.fromEntries(Object.values(lock.roots).filter((root) => root.repo !== undefined).map((root) => [root.name, root.repo]))
    assert.deepEqual(repos, { Alamofire: 'trunk', 'Artsy+UIColors': 'https://github.com/artsy/Specs.git', Moya: 'trunk', SnapKit: 'trunk' })
  })

  it('every kind of external source, and what CocoaPods downloaded each by', () => {
    const { roots } = lock
    assert.deepEqual([roots.Then.external.branch, roots.Then.checkout.commit, roots.Then.checkout.branch], ['main', COMMIT, undefined])
    assert.deepEqual([roots.SwiftyJSON.external.tag, roots.SwiftyJSON.checkout.tag, roots.SwiftyJSON.checkout.commit], ['5.0.2', '5.0.2', undefined])
    assert.equal(roots.KeychainAccess.checkout.commit, roots.KeychainAccess.external.commit)
    assert.deepEqual([roots.Reusable.external.submodules, roots.Reusable.checkout.submodules], [true, true])
    assert.deepEqual(plain(roots.LocalPod.external), { type: 'path', path: 'LocalPod', options: {} })
    assert.equal(roots.LocalPod.checkout, undefined)
    assert.deepEqual(plain(roots.SpecPod.external), { type: 'podspec', podspec: 'specs/SpecPod.podspec', options: {} })
    assert.deepEqual([roots.SpecPod.checkout.url, roots.SpecPod.checkout.commit], ['https://github.com/devxoul/Then.git', COMMIT])
    assert.deepEqual(plain(roots.HttpPod.checkout), plain(roots.HttpPod.external))
    assert.deepEqual([roots.HttpPod.external.url, roots.HttpPod.external.fileType], ['http://127.0.0.1:8137/HttpPod.tgz', 'tgz'])
    assert.match(roots.HttpPod.external.sha256, /^[\da-f]{64}$/u)
  })

  it('a checksum of every root\'s podspec', () => {
    assert.ok(Object.values(lock.roots).every((root) => /^[\da-f]{40}$/u.test(root.checksum)))
    assert.equal(lock.roots.Alamofire.checksum, '3ca42e259043ee0dc5c0cdd76c4bc568b8e42af7')
  })

  it('a description of a file by Hash#inspect, of Ruby 3.4 too', () => {
    const ruby34 = text('cocoapods-1.17.0').replace(/\{:http=>\\"(.*?)\\", :type=>\\"tgz\\", :sha256=>\\"(.*?)\\"\}/u, '{sha256: \\"$2\\", http: \\"$1\\", type: \\"tgz\\"}')
    assert.notEqual(ruby34, text('cocoapods-1.17.0'))
    assert.deepEqual(plain(parsePodfileLock(ruby34)), plain(lock))
  })

  it('the Podfile it was written for, and no other', () => {
    assert.match(lock.podfileChecksum, /^[\da-f]{40}$/u)
    assert.throws(() => parsePodfileLock(text('cocoapods-1.17.0'), { podfile: podfile('cocoapods-1.17.0-empty') }), /the lockfile was written for another Podfile/u)
    assert.equal(parsePodfileLock(text('cocoapods-1.17.0'), { podfile: new TextEncoder().encode(podfile('cocoapods-1.17.0')) }).podfileChecksum, lock.podfileChecksum)
  })
})

describe('CocoaPods 1.17, of no pods', () => {
  it('the Podfile\'s checksum and the version alone', () => {
    const lock = read('cocoapods-1.17.0-empty')
    assert.deepEqual([lock.cocoapods, Object.keys(lock.pods), Object.keys(lock.roots), lock.dependencies], ['1.17.0', [], [], []])
    assert.match(lock.podfileChecksum, /^[\da-f]{40}$/u)
  })
})
