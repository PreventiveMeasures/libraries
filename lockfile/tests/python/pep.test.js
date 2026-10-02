import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { DIGESTS, checkHash, parseSdistName, parseWheelName } from '../../src/python/files.js'
import { checkNormalVersion, checkSpecifiers, normalVersion, parseVersion, versionKey } from '../../src/python/pep440.js'
import { checkMarker, checkNormalName, checkRequirementText, isName, normalName } from '../../src/python/pep508.js'

// What the PEP 440 and PEP 508 readers make of the cases each tool's
// lockfile meets; differential.test.js holds them to Python's packaging.

const reads = (check) => (text) => {
  try {
    check(text, 'here')
    return true
  } catch (error) {
    assert.equal(error.name, 'LockfileError')
    return false
  }
}

describe('PEP 440', () => {
  it('a version in any spelling, and its normal form', () => {
    const cases = {
      '1.0': '1.0', 'v1.0': '1.0', '1!1.0': '1!1.0', '0!1.0': '1.0', '01.002': '1.2', '1.0-alpha.2': '1.0a2', '1.0.beta': '1.0b0', '1.0c1': '1.0rc1',
      '1.0-1': '1.0.post1', '1.0.rev': '1.0.post0', '1.0_DEV-3': '1.0.dev3', '1.0+Ubuntu-01_a': '1.0+ubuntu.1.a', '2026.7.22': '2026.7.22',
    }
    for (const [text, normal] of Object.entries(cases)) assert.equal(normalVersion(parseVersion(text)), normal, text)
    for (const text of ['', '1.', '.1', '1.0-final', '1.0+', ' 1.0', '1.0 ', '1..0', '1.0.*', 'v']) assert.equal(parseVersion(text), undefined, text)
  })

  it('a version in normal form, as uv writes every one', () => {
    assert.ok(reads(checkNormalVersion)('1.0.post1'))
    assert.throws(() => checkNormalVersion('1.0-1', 'v'), /"1\.0-1" is not a version in normal form, "1\.0\.post1"/u)
  })

  it('equal versions, by their release less trailing zeros', () => {
    const key = (text) => versionKey(parseVersion(text))
    assert.equal(key('1.0'), key('1.0.0'))
    assert.equal(key('1'), key('1.0.0'))
    assert.notEqual(key('1.0'), key('1.0.post0'))
    assert.notEqual(key('1.0+a'), key('1.0'))
    assert.equal(key('1.0+A.01'), key('1.0+a.1'))
  })

  it('specifiers, as packaging reads them, less an empty clause', () => {
    for (const text of ['>=3.11', '>=3.8, <4', '==1.0.*', '!=1.5.7', '~=1.4.2', '===foo', '==1.0+local', ' >= 1 ,< 2 ']) assert.ok(reads(checkSpecifiers)(text), text)
    for (const text of ['', '>=3.11,', '3.8', '~=1', '<1.0+local', '==1.0.*+x', '>=1.0.*', '=== ', '>=1;']) assert.ok(!reads(checkSpecifiers)(text), text)
  })
})

describe('PEP 508', () => {
  it('names, and their normal form', () => {
    assert.ok(isName('zope.interface') && isName('A_b') && !isName('-a') && !isName('a b') && !isName(''))
    assert.equal(normalName('Zope.Interface__x'), 'zope-interface-x')
    assert.ok(reads(checkNormalName)('typing-extensions'))
    assert.throws(() => checkNormalName('typing_extensions', 'n'), /is not a name in normal form, "typing-extensions"/u)
    assert.throws(() => checkNormalName('x--y', 'n'), /is not a name in normal form, "x-y"/u)
  })

  it('markers: comparisons of a variable and a string, `and`, `or` and brackets', () => {
    for (const text of ["python_version < '3.12'", '"win32" == sys_platform', "extra == 'socks' and (os_name == 'nt' or platform_machine != 'x')", "'dev' in dependency_groups", "'x' not in extras", "python_version<'3'and os_name=='nt'"]) {
      assert.ok(reads(checkMarker)(text), text)
    }
    for (const text of ['', "os.name == 'nt'", "'a' == 'b'", 'python_version == python_version', "python_version == '3' and", "(python_version == '3'", "python_version notin 'x'", "python_version == '3\n'"]) {
      assert.ok(!reads(checkMarker)(text), text)
    }
  })

  it('blanks around a specifier or a requirement\'s parts, in time linear in their run', () => {
    const blanks = ' \t'.repeat(100_000)
    assert.ok(reads(checkSpecifiers)(`>=1${blanks},<2${blanks}`))
    assert.ok(!reads(checkSpecifiers)(`>=1${blanks}x`))
    assert.ok(reads(checkRequirementText)(`a (>=1${blanks})${blanks};${blanks}os_name == 'nt'${blanks}`))
    assert.ok(!reads(checkRequirementText)(`a >=1${blanks}x`))
  })

  it('markers nested deep, refused past 64 brackets, in time linear in their length', () => {
    const nested = (depth) => `${'('.repeat(depth)}os_name == 'nt'${')'.repeat(depth)}`
    assert.ok(reads(checkMarker)(nested(64)))
    assert.ok(!reads(checkMarker)(nested(65)))
    assert.ok(reads(checkMarker)(Array.from({ length: 20000 }, () => "os_name == 'nt'").join(' and ')))
  })

  it('requirements in PEP 508\'s text', () => {
    for (const text of ['requests', 'requests[socks]>=2', 'PySocks (>=1.5.6,!=1.5.7)', 'brotli (>=1.2.0) ; platform_python_implementation == "CPython"', 'a @ https://example.com/a.whl ; os_name == "nt"', 'a[] ; extra == "x"']) {
      assert.ok(reads(checkRequirementText)(text), text)
    }
    for (const text of ['', '-a', 'a (>=1', 'a @ ', 'a @ https://example.com/a.whl; os_name == "nt"', 'a ; ', 'a [b c]']) assert.ok(!reads(checkRequirementText)(text), text)
  })
})

describe('files', () => {
  it('a wheel\'s name and version, its name in normal form', () => {
    const { name, version } = parseWheelName('Zope.Interface-5.0.0rc1-1-cp311-cp311-manylinux_2_17_x86_64.manylinux2014_x86_64.whl')
    assert.deepEqual([name, normalVersion(version)], ['zope-interface', '5.0.0rc1'])
    for (const text of ['a-1.0-py3-none-any', 'a-1.0-none-any.whl', 'a__b-1.0-py3-none-any.whl', 'a-1.0-x-py3-none-any.whl', 'a-1.0-3py-none-any.whl', 'a-1.0-py3..x-none-any.whl', 'a-1.0.x-py3-none-any.whl']) {
      assert.equal(parseWheelName(text), undefined, text)
    }
  })

  it('an sdist\'s, by the last dash, of .tar.gz or .zip alone', () => {
    const sdist = (text) => {
      const { name, version } = parseSdistName(text)
      return [name, normalVersion(version)]
    }
    assert.deepEqual(sdist('charset_normalizer-3.5.2.tar.gz'), ['charset-normalizer', '3.5.2'])
    assert.deepEqual(sdist('a-b-1.0.zip'), ['a-b', '1.0'])
    for (const text of ['a-1.0.tar.bz2', 'a.tar.gz', 'a-x.tar.gz']) assert.equal(parseSdistName(text), undefined, text)
  })

  it('hashes, `algorithm:hex`, of the size each algorithm makes', () => {
    assert.equal(checkHash(`sha256:${'a'.repeat(64)}`, 'h', DIGESTS), `sha256:${'a'.repeat(64)}`)
    assert.throws(() => checkHash(`sha256:${'a'.repeat(63)}`, 'h', DIGESTS), /is not a sha256 digest in lowercase hex/u)
    assert.throws(() => checkHash(`sha256=${'a'.repeat(64)}`, 'h', DIGESTS), /is not a hash of md5, sha1/u)
  })
})
