import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { podspecJson } from '../src/podspec-read.js'

// Each fixture is a podspec in the form read, with the JSON CocoaPods 1.16.2 itself writes of it beside it,
// Specification.from_file(...).to_pretty_json, by a Ruby whose json writes an empty list over lines.
const FIXTURES = new URL('fixtures/podspecs/', import.meta.url).pathname
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const convert = (source, files = {}) => podspecJson('/pod/Name.podspec', source, (path) => files[path], 'pods["Name"]')
const spec = (body, before = '') => `${before}Pod::Spec.new do |s|\n  s.name = 'Name'\n${body}end\n`

describe('podspecJson', () => {
  for (const path of ['Plain/ios/Plain.podspec', 'Rich/Rich.podspec']) {
    it(`reads ${path} as CocoaPods does`, () => {
      const [lines, compact] = podspecJson(`${FIXTURES}${path}`, read(`${FIXTURES}${path}`), read, path)
      const expected = read(`${FIXTURES}${path}.json`)
      assert.equal(lines, expected)
      assert.equal(compact, expected.replaceAll(/\[\n\n\s*\]/gu, '[]').replaceAll(/\{\n\s*\}/gu, '{}'))
    })
  }

  it('writes what a podspec says in its order, every platform where it names none', () => {
    const [, json] = convert(spec("  s.version = '1.0'\n  s.frameworks = 'A', 'B'\n  s.ios.frameworks = %w(C)\n  s.summary = <<~TEXT\n    Two\n      lines.\n  TEXT\n"))
    assert.deepEqual(JSON.parse(json), { name: 'Name', version: '1.0', frameworks: ['A', 'B'], ios: { frameworks: ['C'] }, summary: 'Two\n  lines.', platforms: { osx: null, ios: null, tvos: null, visionos: null, watchos: null } })
    assert.deepEqual(Object.keys(JSON.parse(json)), ['name', 'version', 'frameworks', 'ios', 'summary', 'platforms'])
  })

  it('reads a package.json, and no other file', () => {
    const files = { '/pod/package.json': '{ "version": "2.0.0", "author": { "name": "A" } }', '/package.json': '{ "version": "3.0.0" }' }
    const body = "  s.version = package['version']\n  s.authors = package['author']\n  s.homepage = package['homepage']\n"
    const parsed = (call) => JSON.parse(convert(spec(body, `require 'json'\npackage = JSON.parse(File.read(${call}))\n`), files)[1])
    assert.deepEqual([parsed("File.join(__dir__, 'package.json')").version, parsed("'package.json'").authors, parsed("File.expand_path('../package.json', __dir__)").version, parsed("File.join(File.dirname(__FILE__), 'package.json')").homepage], ['2.0.0', { name: 'A' }, '3.0.0', null])
    assert.throws(() => parsed("'LICENSE'"), /line 2: a file read that is no package\.json/u)
    assert.throws(() => parsed("'missing/package.json'"), /its podspec reads \/pod\/missing\/package\.json, which is not there/u)
  })

  it('refuses what is not in the form, by its line', () => {
    for (const [source, message] of [
      [spec("  if ENV['X']\n  end\n"), /line 3: `if`/u],
      [spec("  s.version = ENV['RCT_NEW_ARCH_ENABLED'] == '1' ? '1' : '2'\n"), /line 3: `==`/u],
      [spec("  s.version = `git describe`\n"), /line 3: ``git`/u],
      [spec("  s.version = '1.0'.strip\n"), /line 3: `\.` after a statement/u],
      [spec("  install_modules_dependencies(s)\n"), /line 3: `install_modules_dependencies`/u],
      [spec("  s.source_files = Dir['ios/*']\n"), /line 3: `Dir`/u],
      [spec("  s.unknown = 1\n"), /line 3: the attribute "unknown"/u],
      [spec("  s.version = 1.5\n"), /line 3: a number with a fraction/u],
      [spec("  s.ios.name = 'Other'\n"), /line 3: "name" set for a platform/u],
      [spec("  s.dependency 'A', :path => '../a'\n"), /line 3: `=>` after a statement/u],
      [spec('  s.summary = "#{$global}"\n'), /line 3: `\$global`/u],
      [spec('', "require 'shellwords'\n"), /line 1: `require`/u],
      [spec('', 'def helper; end\n'), /line 1: `def`/u],
      [`${spec('')}puts 'done'\n`, /line 4: more after the specification/u],
      ["Pod::Spec.new do |s|\n  s.version = '1'\nend\n", /its podspec gives no name/u],
    ]) assert.throws(() => convert(source), (error) => error.name === 'PodError' && message.test(error.message), source)
  })
})
