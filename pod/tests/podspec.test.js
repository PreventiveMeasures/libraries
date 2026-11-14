import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { podspecJson } from '../src/podspec/read.js'

// Each fixture is a podspec in the form read, with the JSON CocoaPods 1.16.2 itself writes of it beside it,
// Specification.from_file(...).to_pretty_json, by a Ruby whose json writes an empty list over lines.
const FIXTURES = new URL('fixtures/podspecs/', import.meta.url).pathname
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const convert = (source, files = {}, context = undefined) => podspecJson('/pod/Name.podspec', source, { read: (path) => files[path] }, 'pods["Name"]', context).forms
const spec = (body, before = '') => `${before}Pod::Spec.new do |s|\n  s.name = 'Name'\n${body}end\n`

describe('podspecJson', () => {
  for (const path of ['Plain/ios/Plain.podspec', 'Rich/Rich.podspec']) {
    it(`reads ${path} as CocoaPods does`, () => {
      const [lines, compact] = podspecJson(`${FIXTURES}${path}`, read(`${FIXTURES}${path}`), { read }, path).forms
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

  it('reads a file from the directory of the podspec, a package.json as what it says', () => {
    const files = { '/pod/package.json': '{ "version": "2.0.0", "author": { "name": "A" } }', '/package.json': '{ "version": "3.0.0" }' }
    const body = "  s.version = package['version']\n  s.authors = package['author']\n  s.homepage = package['homepage']\n"
    const parsed = (call) => JSON.parse(convert(spec(body, `require 'json'\npackage = JSON.parse(File.read(${call}))\n`), files)[1])
    assert.deepEqual([parsed("File.join(__dir__, 'package.json')").version, parsed("'package.json'").authors, parsed("File.expand_path('../package.json', __dir__)").version, parsed("File.join(File.dirname(__FILE__), 'package.json')").homepage], ['2.0.0', { name: 'A' }, '3.0.0', null])
    assert.equal(JSON.parse(convert(spec("  s.prepare_command = File.read('../scripts/prepare.sh')\n  s.summary = File.read('note.txt').strip\n"), { '/scripts/prepare.sh': 'make\n', '/pod/note.txt': ' A note.\n' })[1]).prepare_command, 'make')
    assert.throws(() => parsed("'LICENSE'"), /its podspec reads \/pod\/LICENSE, which is not there/u)
    assert.throws(() => convert(spec('', "package = JSON.parse(File.read('note.txt'))\n"), { '/pod/note.txt': 'A note.' }), /its podspec reads as JSON what is not/u)
    assert.throws(() => parsed("'missing/package.json'"), /its podspec reads \/pod\/missing\/package\.json, which is not there/u)
  })

  it('refuses what is not in the form, by its line', () => {
    for (const [source, message] of [
      [spec("  while ENV['X']\n  end\n"), /line 3: `while`/u],
      [spec("  s.version = ENV['A'] === '1' ? '1' : '2'\n"), /line 3: `===`/u],
      [spec("  s.version = ENV.fetch('A')\n"), /line 3: `\.` where `\[` is expected/u],
      [spec("  s.version = `git describe`\n"), /line 3: ``git describe``/u],
      [spec("  s.version = '1.0'.upcase\n"), /line 3: `\.` after a statement/u],
      [spec('  use_helper(s)\n'), /line 3: `use_helper`/u],
      [spec("  s.source_files = Dir['ios/*']\n"), /line 3: `\[` where `\.` is expected/u],
      [spec("  s.source_files = Dir.glob('ios/*')\n"), /line 3: the call `Dir\.glob`/u],
      [spec("  s.unknown = 1\n"), /line 3: the attribute "unknown"/u],
      [spec("  s.version = 1.5\n"), /line 3: a number with a fraction/u],
      [spec("  s.ios.name = 'Other'\n"), /line 3: "name" set for a platform/u],
      [spec("  s.dependency 'A', :path => '../a'\n"), /line 3: `=>` after a statement/u],
      [spec('  s.summary = "#{@ivar}"\n'), /line 3: `@ivar`/u],
      [spec("  s.summary = %q(a)\n"), /line 3: a `%q` literal/u],
      [spec('', "require 'shellwords'\n"), /line 1: `require`/u],
      [spec('', 'def helper; end\n'), /line 1: `def`/u],
      [`${spec('')}puts 'done'\n`, /line 4: more after the specification/u],
      ["Pod::Spec.new do |s|\n  s.version = '1'\nend\n", /its podspec gives no name/u],
    ]) assert.throws(() => convert(source), (error) => error.name === 'PodError' && message.test(error.message), source)
  })

  it('reads the branch of a condition that holds, by the environment it is given', () => {
    const body = `  if ENV['MODE'] == 'a' then
    s.summary = 'A'
  elsif ENV['MODE'] == 'b' && !ENV['OFF']
    s.summary = 'B'
  else
    s.summary = ENV['MODE'] != nil || ENV['OFF'] ? 'other' : 'none'
  end
  unless debug
    s.frameworks = flags.join(' ')
  end
  s.requires_arc = true unless ENV['MODE']
  s.libraries = 'c++' if (ENV['MODE'] == 'a' || ENV['MODE'] == 'b') && s.respond_to?(:visionos)
`
    const before = "debug = ENV['DEBUG'] == '1'\nflags = ['-DA']\nflags << '-DB' if debug\nif debug\n  flags << '-DC'\nend\n"
    const by = (env) => {
      const { forms, conditions } = podspecJson('/pod/Name.podspec', spec(body, before), () => undefined, 'pods["Name"]', { env: new Map(Object.entries(env)), prebuilt: {} })
      const said = JSON.parse(forms[1])
      return [Object.fromEntries(['summary', 'frameworks', 'requires_arc', 'libraries'].filter((key) => key in said).map((key) => [key, said[key]])), conditions]
    }
    assert.deepEqual(by({}), [{ summary: 'none', frameworks: '-DA', requires_arc: true }, ['DEBUG not set', 'MODE not set', 'OFF not set']])
    assert.deepEqual(by({ MODE: 'a', OFF: null })[0], { summary: 'A', frameworks: '-DA', libraries: 'c++' })
    assert.deepEqual(by({ MODE: 'b', DEBUG: '0' }), [{ summary: 'B', frameworks: '-DA', libraries: 'c++' }, ['DEBUG=0', 'MODE=b', 'OFF not set']])
    assert.deepEqual(by({ MODE: 'b', OFF: '' })[0], { summary: 'other', frameworks: '-DA', libraries: 'c++' })
    assert.deepEqual(by({ MODE: 'c', DEBUG: '1' })[0], { summary: 'other' })
  })

  it('passes over the branch that does not hold, whatever is in it, and refuses what it comes to', () => {
    const body = "  if ENV['X']\n    Pod::UI.puts `tput cols` + /x/ if tty? { |io| io.end }\n    s.dependency 'A' unless a?\n    list.each do |one|\n      puts one\n    end\n  else\n    s.summary = 'B'\n  end\n"
    assert.throws(() => convert(spec(body)), /line 4: `\/x\/`/u, 'what is no word of a podspec is not passed over')
    const passable = body.replace(' + /x/', '')
    assert.equal(JSON.parse(convert(spec(passable))[1]).summary, 'B')
    assert.throws(() => convert(spec(passable), {}, { env: new Map([['X', '1']]), prebuilt: {} }), /line 4: `tty\?`/u)
    for (const [source, message] of [
      [spec("  if ENV['X']\n    while true\n    end\n  end\n"), /line 4: `while` where a condition does not hold/u],
      [spec("  if ENV['X']\n    s.summary = 'A'\n"), /line 6: `end of file`/u],
      [spec('', "if ENV['X']\n  a = 1\n"), /line 6: a condition, or a block, without its end/u],
      [spec("  s.summary = `uname`\n"), /line 3: ``uname``/u],
      [spec("  s.summary = ['a'] != ['b'] ? 'A' : 'B'\n"), /line 3: a `!=` of what is no text/u],
      [spec("  s.summary = 'a' << 'b'\n"), /line 3: `<<` after a statement/u],
      [spec("  s.summary = name\n", "name = 'a'\nother = [name]\nname << 'b'\n"), /line 3: a `<<` to a text that may not be added to, or that something else may have/u],
      [spec("  s.summary = name\n", "# frozen_string_literal: true\nname = 'a'\nname << 'b'\n"), /line 3: a `<<` to a text that may not be added to/u],
      [spec("  s.summary = name\n", "name = 1\nname << 'b'\n"), /line 2: a `<<` to what is no list/u],
      [spec("  s.summary = ENV['X'] ? list.concat(['b']).join : 'A'\n", "list = ['a']\n"), /line 4: a change in the side of a condition that is not taken/u],
      [spec("  s.summary = ENV['X'] && install_modules_dependencies(s)\n"), /line 3: `install_modules_dependencies` needs React Native/u],
      [spec("  s.summary = 'A' if respond_to?(:install_modules_dependencies)\n"), /line 3: `\)` where `,` is expected/u],
      [spec("  s.summary = 'A' if defined?(use_helper)\n"), /line 3: `defined\?` of `use_helper`/u],
    ]) assert.throws(() => convert(source), (error) => error.name === 'PodError' && message.test(error.message), source)
  })
})
