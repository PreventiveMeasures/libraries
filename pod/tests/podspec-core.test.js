import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { dirGlob } from '../src/pathlist.js'
import { podspecJson } from '../src/podspec/read.js'

const FIXTURES = new URL('fixtures/podspecs/', import.meta.url).pathname
const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const context = ({ env = {}, globals = {}, ...rest } = {}) => ({ env: new Map(Object.entries(env)), globals: new Map(Object.entries(globals)), prebuilt: {}, ...rest })
const NONE = { read: () => undefined }
const convert = (source, given, files = NONE) => podspecJson('/pod/Name.podspec', source, files, 'pods["Name"]', context(given))
const spec = (body, before = '') => `${before}Pod::Spec.new do |s|\n  s.name = 'Name'\n${body}end\n`
const parsed = (source, given, files) => JSON.parse(convert(source, given, files).forms[1])
const refuses = (source, message, given, files) => assert.throws(() => convert(source, given, files), (error) => error.name === 'PodError' && message.test(error.message), source)

// React Native's own podspecs, fixtures/podspecs/core, held to the checksums of them in the lockfiles of
// RocketChat/Rocket.Chat.ReactNative 757e79e (0.86.3, static frameworks, core and dependencies prebuilt) and
// mattermost/mattermost-mobile fca832c (0.83.9, static frameworks, built from source).
const LOCKED = [
  ['React-debug', { reactNative: '0.86.3', frameworks: 'static', prebuilt: { core: true, deps: true } }, '4a1d2ef3086d88dd35f28cfb5da803584f819924'],
  ['React-RCTFBReactNativeSpec', { reactNative: '0.83.9', frameworks: 'static' }, '63a19207a5df13c3302fe55ca075774059bf7b15'],
]

describe("a podspec of React Native's own", () => {
  for (const [name, given, checksum] of LOCKED) {
    it(`reads ${name} as the CocoaPods of a project on React Native ${given.reactNative} did`, () => {
      const path = `${FIXTURES}core/${name}.podspec`
      const read = (file) => (file.endsWith('/package.json') ? JSON.stringify({ version: given.reactNative, license: 'MIT' }) : undefined)
      const { forms, conditions } = podspecJson(path, readFileSync(path, 'utf8'), { read }, name, context(given))
      assert.ok(forms.map(sha1).includes(checksum), forms[1])
      assert.match(conditions.at(-1), new RegExp(`^min_supported_versions, podspec_sources, .* of React Native ${given.reactNative.replaceAll('.', '\\.')}`, 'u'))
    })
  }

  it('has the sources, the frameworks and the dependencies its helpers give, by what is prebuilt', () => {
    const body = "  s.source_files = podspec_sources('*.{cpp,h}', '*.h')\n  s.pod_target_xcconfig = { 'HEADER_SEARCH_PATHS' => ['\"a\"', ' ', '\"b\"'], 'CLANG_CXX_LANGUAGE_STANDARD' => rct_cxx_language_standard() }\n  resolve_use_frameworks(s, header_mappings_dir: '../..', module_name: 'React_name')\n  add_dependency(s, 'React-jsinspector', :framework_name => 'jsinspector_modern', :version => '1.0')\n  add_dependency(s, 'ReactCommon', :subspec => 'turbomodule/core', :additional_framework_paths => ['react/nativemodule/core'])\n  depend_on_js_engine(s)\n  s.platforms = min_supported_versions\n"
    const built = parsed(spec(body), { reactNative: '0.85.1', frameworks: 'static' })
    const frameworks = '${PODS_CONFIGURATION_BUILD_DIR}'
    assert.deepEqual([built.source_files, built.module_name, built.header_mappings_dir, built.platforms], ['*.{cpp,h}', 'React_name', '../..', { ios: '15.1' }])
    assert.deepEqual(built.pod_target_xcconfig, { HEADER_SEARCH_PATHS: `"a" "b" "${frameworks}/React-jsinspector/jsinspector_modern.framework/Headers" "${frameworks}/ReactCommon/ReactCommon.framework/Headers" "${frameworks}/ReactCommon/ReactCommon.framework/Headers/react/nativemodule/core"`, CLANG_CXX_LANGUAGE_STANDARD: 'c++20' })
    // The subspec add_dependency is given by name is not passed on, in React Native's Ruby either.
    assert.deepEqual(built.dependencies, { 'React-jsinspector': ['1.0'], ReactCommon: [], 'hermes-engine': [] })
    const prebuilt = parsed(spec(body), { reactNative: '0.85.1', frameworks: 'static', prebuilt: { core: true }, env: { USE_THIRD_PARTY_JSC: '1' } })
    assert.deepEqual([prebuilt.source_files, prebuilt.module_name, prebuilt.header_mappings_dir, Object.keys(prebuilt.dependencies).at(-1)], ['*.h', 'React_name', undefined, 'React-jsc'])
    assert.equal(prebuilt.pod_target_xcconfig.HEADER_SEARCH_PATHS, '"a" "b" "${PODS_ROOT}/React-jsinspector" "${PODS_ROOT}/ReactCommon" "${PODS_ROOT}/ReactCommon/react/nativemodule/core"')
    assert.deepEqual([parsed(spec(body), { reactNative: '0.85.1' }).module_name, parsed(spec(body), { reactNative: '0.85.1' }).header_mappings_dir], [undefined, undefined])
    // What each family has, and has not.
    const config = "  s.compiler_flags = get_folly_config()[:compiler_flags] + ' ' + get_boost_config()[:compiler_flags]\n  s.dependency 'RCT-Folly', get_folly_config()[:version]\n  s.summary = [folly_flags == get_folly_config()[:compiler_flags], create_header_search_path_for_frameworks('React-Fabric', :include_base_folder => false, :additional_framework_paths => ['a']).join].join(' ')\n"
    const old = parsed(spec(config), { reactNative: '0.78.3', prebuilt: { core: true } })
    assert.deepEqual([old.compiler_flags.split(' ')[0], old.compiler_flags.split(' ').at(-1), old.dependencies, old.summary], ['-DFOLLY_NO_CONFIG', '-Wno-documentation', { 'RCT-Folly': ['2024.11.18.00'] }, `true ${frameworks}/React-Fabric/React_Fabric.framework/Headers/a`])
    assert.equal(parsed(spec(config), { reactNative: '0.88.1', prebuilt: { core: true } }).summary, 'true ${PODS_ROOT}/React-Fabric/a')
    const marked = "  s.pod_target_xcconfig = { 'GCC_PREPROCESSOR_DEFINITIONS' => ['A=1', 'B=2'] }\n  mark_as_react_native_build(s)\n  s.summary = [js_engine_flags(), use_hermes ? 'hermes' : 'jsc', ReactNativeCoreUtils.build_rncore_from_source() ? 'built' : 'prebuilt'].join(' ')\n"
    assert.deepEqual([parsed(spec(marked), { reactNative: '0.88.0', prebuilt: { core: true } }).pod_target_xcconfig, parsed(spec(marked), { reactNative: '0.88.0' }).summary], [{ GCC_PREPROCESSOR_DEFINITIONS: 'A=1 B=2 RN_BUILDING=1' }, '-DUSE_HERMES=1 hermes built'])
    refuses(spec(marked), /line 4: `mark_as_react_native_build`, which React Native 0\.86\.3 has not/u, { reactNative: '0.86.3' })
    refuses(spec("  add_dependency(s, 'A', :path => 'a')\n"), /line 3: a helper given what it does not take/u, { reactNative: '0.86.3' })
    refuses(spec("  add_dependency(s, 'A')\n"), /line 3: `add_dependency` of a specification without a pod_target_xcconfig/u, { reactNative: '0.78.3' })
  })

  it('reads what a podspec makes of lists and hashes, each of a list, and the line Ruby reads on from', () => {
    const before = "source = { :git => 'https://example.com/a.git' }\nif ENV['X'] == '1'\n  source[:commit] = `git rev-parse HEAD`.strip if system('git rev-parse')\nelse\n  source[:tag] = 'v1'\nend\npaths = ['a'].concat(ENV['X'] ? ['x'] : []).append('b')\npaths += ['c']\nflags = ''\nflags << ' -DA' << ' -DB'\nheaders = { 'One' => 'one/*.h', 'Two' => 'two/*.h' }\nkinds = :static, :dynamic\n"
    const body = "  s.source = source\n  ['d', 'e']\n    .each { |path| paths << \"#{path}!\" }\n  headers.each do |name, files|\n    s.subspec name do |ss|\n      ss.source_files = files\n    end\n  end\n  s.subspec 'Empty' do\n  end\n  s.source_files = paths - ['a'],\n  s.compiler_flags = flags\n  s.pod_target_xcconfig = { 'A' => '1' }.merge!(kinds.join == 'staticdynamic' ? { 'A' => '2' } : {}).merge({ 'B' => kinds.join(' ') })\n  [].each do |none|\n    s.summary = `uname`\n  end\n"
    const read = parsed(spec(body, before))
    assert.deepEqual(read.source, { git: 'https://example.com/a.git', tag: 'v1' })
    // A line that ends with a comma takes the assignment after it for one more of its values.
    assert.deepEqual([read.source_files, read.compiler_flags], [[['b', 'c', 'd!', 'e!'], ' -DA -DB'], '-DA -DB'])
    assert.deepEqual([Object.keys(read).indexOf('compiler_flags') < Object.keys(read).indexOf('source_files'), read.pod_target_xcconfig], [true, { A: '2', B: 'static dynamic' }])
    assert.deepEqual(read.subspecs, [{ name: 'One', source_files: 'one/*.h' }, { name: 'Two', source_files: 'two/*.h' }, { name: 'Empty' }])
    refuses(spec('', "list = ['a']\nlist.each { |one, two| a = one }\n"), /line 2: an `each` of what is no list, or no hash by its keys and values/u)
    refuses(spec('', "list = ['a']\nlist.each do |one|\n  while true\n  end\nend\n"), /line 3: `while`/u)
    refuses(spec("  s.summary = ['a'] == ['a'] ? 'A' : 'B'\n"), /line 3: a `==` of what is no text, symbol/u)
  })

  it('tells a symbol from a text, compares numbers and versions, and asks only what is not nil', () => {
    const body = "  s.summary = [:a == 'a', :a == :a, 'a' != :a, 2 > 1, 2 <= 1, Gem::Version.new(Pod::VERSION) >= Gem::Version.new('1.13.0'), Gem::Version.new('1.9') < Gem::Version.new('1.10')].join(' ')\n  s.description = [ENV['N']&.include?('b'), ENV['N'].nil?, ENV['N'].to_i, ' 12 a'.to_i, ''.empty?, [nil, 'b', 'a'].compact.sort.join, ['a'].include?('a'), ENV.include?('N'), ENV.key?('S')].join(' ')\n"
    const { summary, description } = parsed(spec(body), { cocoapods: '1.16.2', env: { S: 'abc' } })
    assert.deepEqual([summary, description], ['false true true true false true true', 'true 0 12 true ab true false true'])
    assert.equal(parsed(spec("  s.summary = ENV['N']&.include?('b').to_s\n"), { env: { N: 'abc' } }).summary, 'true')
    refuses(spec("  s.summary = Pod::VERSION\n"), /line 3: `Pod::VERSION`/u)
    refuses(spec("  s.summary = 'a' > 'b' ? 'A' : 'B'\n"), /line 3: a `>` of what is not two numbers or two versions/u)
    refuses(spec("  s.summary = ENV['N'].include?('b').to_s\n"), /line 3: `include\?` of what it is not of/u)
  })

  it('reads a global as pod.config.json gives it, and what a podspec prints as nothing of it', () => {
    const body = "  if defined?($Static)\n    Pod::UI.puts \"#{s.name}: static is '#{$Static}'\"\n    s.static_framework = $Static\n  else\n    puts 'not static'\n    s.static_framework = false\n  end\n  $Seen = true\n  s.requires_arc = $Seen && defined?($Seen) == 'global-variable' && defined?(Pod::UI) != nil && !defined?($Other)\n  s.summary = $Kinds&.include?('a') ? 'a' : 'none'\n"
    const read = (globals) => {
      const { forms, conditions } = convert(spec(body), { globals })
      const { static_framework: kind, requires_arc: arc, summary } = JSON.parse(forms[1])
      return [kind, arc, summary, conditions]
    }
    assert.deepEqual(read({}), [false, true, 'none', ['$Static not set', '$Seen=set', '$Other not set', '$Kinds not set']])
    assert.deepEqual(read({ Static: true, Kinds: ['a'] }), [true, true, 'a', ['$Static=true', '$Seen=set', '$Other not set', '$Kinds=["a"]']])
    assert.deepEqual(read({ Static: null }).slice(0, 2), [null, true])
    refuses(spec('  Pod::UI.puts use_helper\n'), /line 3: `use_helper`/u)
    refuses(spec('  $Seen ||= true\n'), /line 3: `\|\|=`/u)
  })

  it('asks the files it is given what is there, and lists them as Dir.glob does', () => {
    const body = "  s.summary = [File.exist?('a.xcframework'), Dir.exist?('a.xcframework'), File.exist?('a.h'), Dir.exist?('a.h'), File.exist?('none')].join(' ')\n  s.private_header_files = Dir.glob('core/**/*.podspec').sort - Dir.glob('core/*-debug.podspec').sort\n"
    const files = { read: () => undefined, kind: (path) => ({ '/pod/a.xcframework': 'directory', '/pod/a.h': 'file' })[path], glob: (dir, pattern, where) => dirGlob(FIXTURES, pattern, where) }
    assert.deepEqual([parsed(spec(body), {}, files).summary, parsed(spec(body), {}, files).private_header_files], ['true true true false false', ['core/React-RCTFBReactNativeSpec.podspec']])
    assert.deepEqual(dirGlob(FIXTURES, '{core,modules}/R*.{podspec,md}', 'pods["Name"]'), ['core/README.md', 'core/React-RCTFBReactNativeSpec.podspec', 'core/React-debug.podspec', 'modules/RNCPicker.podspec', 'modules/react-native-slider.podspec'], 'letters are matched in either case, as on the volume of a Mac')
    assert.deepEqual(dirGlob(FIXTURES, 'Plain/*', 'pods["Name"]'), ['Plain/ios', 'Plain/package.json'])
    assert.throws(() => dirGlob(FIXTURES, '/etc/*', 'pods["Name"]'), /pods\["Name"\]: the glob "\/etc\/\*" is absolute or has no wildcard/u)
    refuses(spec(body), /line 3: the call `File\.exist\?`/u)
  })
})
