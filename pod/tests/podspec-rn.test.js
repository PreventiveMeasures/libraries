import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { podspecJson } from '../src/podspec/read.js'

const FIXTURES = new URL('fixtures/podspecs/modules/', import.meta.url).pathname
const sha1 = (text) => createHash('sha1').update(text).digest('hex')
const context = ({ env = {}, ...rest } = {}) => ({ env: new Map(Object.entries(env)), prebuilt: {}, ...rest })
const convert = (source, given) => podspecJson('/pod/Name.podspec', source, { read: () => undefined }, 'pods["Name"]', context(given))
const spec = (body, before = '') => `${before}Pod::Spec.new do |s|\n  s.name = 'Name'\n${body}end\n`
const parsed = (source, given) => JSON.parse(convert(source, given).forms[1])

// Each fixture says what a published podspec says, in the form read, and is held to the checksum a public
// Podfile.lock has of that podspec: the sha1 of the JSON CocoaPods itself wrote of it, with the helper of the
// React Native that project had. The lockfiles, each `ios/Podfile.lock` of its project:
//   software-mansion/react-native-reanimated 3.17.1, apps/fabric-example and apps/paper-example: 0.78.0
//   mattermost/mattermost-mobile fca832c: 0.83.9, static frameworks, built from source
//   RocketChat/Rocket.Chat.ReactNative 757e79e: 0.86.3, static frameworks, core and dependencies prebuilt
//   expo/expo a28c831, apps/bare-expo: 0.88.1, core and dependencies prebuilt
const LOCKED = [
  ['react-native-slider', { reactNative: '0.78.0' }, '54e7f67e9e4c92c0edac77bbf58abfaf1f60055f'],
  ['react-native-slider', { reactNative: '0.78.0', env: { RCT_NEW_ARCH_ENABLED: '0', RCT_FABRIC_ENABLED: '0' } }, 'd1358b33bc126281514fe480bb9a00c0aa9f9aac'],
  ['mattermost-hardware-keyboard', { reactNative: '0.83.9', frameworks: 'static' }, '95eb9c1e3d32b9e9921abcbb8765c516beaba9fd'],
  ['RNCPicker', { reactNative: '0.86.3', frameworks: 'static', prebuilt: { core: true, deps: true } }, 'a3921be99ae291e420e3e8940e5b2b53e572c543'],
  ['RNCPicker', { reactNative: '0.88.1', prebuilt: { core: true, deps: true } }, 'd3db4b004e95a5bd224e1c926f84978b45bc0040'],
]

describe('a podspec of a React Native module', () => {
  for (const [name, given, checksum] of LOCKED) {
    it(`reads ${name} as the CocoaPods of a project on React Native ${given.reactNative} did${given.env ? ', in its environment' : ''}`, () => {
      const path = `${FIXTURES}${name}.podspec`
      const { forms } = podspecJson(path, readFileSync(path, 'utf8'), { read: () => undefined }, name, context(given))
      assert.ok(forms.map(sha1).includes(checksum), forms[1])
    })
  }

  it('has every version of a family read as the one, and the helper refused of any other', () => {
    const source = spec('  install_modules_dependencies(s)\n')
    const same = (versions, given) => assert.equal(new Set(versions.map((reactNative) => convert(source, { ...given, reactNative }).forms[1])).size, 1, versions.join(' '))
    same(['0.78.0', '0.78.1', '0.78.2', '0.78.3'])
    same(['0.83.0', '0.83.9', '0.83.10'], { prebuilt: { core: true } })
    same(['0.85.0', '0.85.1', '0.85.2', '0.85.3', '0.86.0', '0.86.2', '0.86.3'], { prebuilt: { core: true } })
    same(['0.88.0', '0.88.1'])
    assert.equal(new Set(['0.78.3', '0.83.9', '0.85.1', '0.88.1'].map((reactNative) => convert(source, { reactNative, frameworks: 'static', prebuilt: { core: true } }).forms[1])).size, 4)
    for (const reactNative of ['0.77.3', '0.78.4', '0.79.0', '0.83.11', '0.84.1', '0.86.1', '0.87.0', '0.88.2', '0.89.0-rc.1', '1000.0.0']) {
      assert.throws(() => convert(source, { reactNative }), (error) => error.name === 'PodError' && error.message === `pods["Name"]: line 3: \`install_modules_dependencies\` is React Native's, which is known only of React Native 0.78.0 to 0.78.3, 0.83.0 to 0.83.10, 0.85.0 to 0.86.3, 0.88.0 and 0.88.1: the lockfile has React-Core at ${reactNative}`, reactNative)
    }
    assert.throws(() => convert(source), /line 3: `install_modules_dependencies` is React Native's, .*: the lockfile has no React-Core/u)
    assert.throws(() => convert(spec('  install_modules_dependencies(t)\n'), { reactNative: '0.78.3' }), /line 3: `t`/u)
    assert.throws(() => convert(spec("  install_modules_dependencies('s')\n"), { reactNative: '0.78.3' }), /line 3: a helper given what it does not take/u)
    assert.throws(() => convert(spec('  podspec_sources([], [])\n'), { reactNative: '0.78.3' }), /line 3: `podspec_sources`, which React Native 0\.78\.3 has not/u)
  })

  it('adds to what the podspec has, in the order React Native 0.78.3 does', () => {
    const body = "  s.compiler_flags = '-DA'\n  s.pod_target_xcconfig = { 'OTHER_SWIFT_FLAGS' => '-DB', 'HEADER_SEARCH_PATHS' => '\"a\"' }\n  s.dependency 'glog', '~> 1'\n  install_modules_dependencies(s)\n"
    const { compiler_flags: flags, pod_target_xcconfig: config, dependencies } = parsed(spec(body), { reactNative: '0.78.3', env: { USE_HERMES: '0' } })
    const folly = '-DFOLLY_NO_CONFIG -DFOLLY_MOBILE=1 -DFOLLY_USE_LIBCPP=1 -DFOLLY_CFG_NO_COROUTINES=1 -DFOLLY_HAVE_CLOCK_GETTIME=1 -Wno-comma -Wno-shorten-64-to-32'
    assert.equal(flags, `-DA  -DRCT_NEW_ARCH_ENABLED=1 ${folly}`)
    assert.deepEqual(Object.entries(config), [
      ['OTHER_SWIFT_FLAGS', '$(inherited) -DB -DRCT_NEW_ARCH_ENABLED'],
      ['HEADER_SEARCH_PATHS', '"a" "$(PODS_ROOT)/boost" "$(PODS_ROOT)/Headers/Private/Yoga"'],
      ['CLANG_CXX_LANGUAGE_STANDARD', 'c++20'],
      ['OTHER_CPLUSPLUSFLAGS', `$(inherited) -DRCT_NEW_ARCH_ENABLED=1 ${folly}`],
    ])
    assert.deepEqual(Object.entries(dependencies).slice(0, 4), [['glog', []], ['React-Core', []], ['RCT-Folly', ['2024.11.18.00']], ['React-RCTFabric', []]])
    assert.deepEqual(Object.keys(dependencies).slice(-2), ['DoubleConversion', 'React-jsi'])
    // Without the new architecture, and with frameworks, whose headers it then gives the paths of.
    const old = parsed(spec('  install_modules_dependencies(s)\n'), { reactNative: '0.78.3', frameworks: 'dynamic', env: { RCT_NEW_ARCH_ENABLED: '0' } })
    assert.equal(old.compiler_flags, folly)
    assert.equal(old.pod_target_xcconfig.OTHER_SWIFT_FLAGS, '$(inherited)')
    assert.equal(Object.keys(old.dependencies).at(-1), 'hermes-engine')
    const paths = old.pod_target_xcconfig.HEADER_SEARCH_PATHS.split(' ')
    assert.deepEqual([paths.length, paths[2], paths[5], paths[6], paths.at(-1)], [19, '"$(PODS_ROOT)/DoubleConversion"', '"${PODS_CONFIGURATION_BUILD_DIR}/React-graphics/React_graphics.framework/Headers"', '"${PODS_CONFIGURATION_BUILD_DIR}/React-graphics/React_graphics.framework/Headers/react/renderer/graphics/platform/ios"', '"${PODS_CONFIGURATION_BUILD_DIR}/React-rendererdebug/React_rendererdebug.framework/Headers"'])
  })

  it('has what is prebuilt, and what is built from source, as React Native 0.85.1 does', () => {
    const source = spec("  s.pod_target_xcconfig = { 'HEADER_SEARCH_PATHS' => '\"a\"' }\n  install_modules_dependencies(s)\n")
    const yoga = '"$(PODS_ROOT)/Headers/Private/Yoga"'
    const built = parsed(source, { reactNative: '0.85.1' })
    assert.equal(built.compiler_flags, '-DRCT_NEW_ARCH_ENABLED=1')
    assert.deepEqual(built.pod_target_xcconfig, { HEADER_SEARCH_PATHS: ['"a"', yoga, ...['glog', 'boost', 'DoubleConversion', 'fast_float/include', 'fmt/include', 'SocketRocket', 'RCT-Folly'].map((one) => `$(PODS_ROOT)/${one}`)], CLANG_CXX_LANGUAGE_STANDARD: 'c++20', OTHER_CPLUSPLUSFLAGS: '$(inherited) -DRCT_NEW_ARCH_ENABLED=1 ', OTHER_SWIFT_FLAGS: '$(inherited) -DRCT_NEW_ARCH_ENABLED' })
    assert.deepEqual(Object.keys(built.dependencies).slice(-10), ['React-renderercss', 'hermes-engine', 'glog', 'boost', 'DoubleConversion', 'fast_float', 'fmt', 'RCT-Folly', 'SocketRocket', 'RCT-Folly/Fabric'])
    const prebuilt = parsed(source, { reactNative: '0.85.1', frameworks: 'static', prebuilt: { core: true, deps: true }, env: { USE_THIRD_PARTY_JSC: '1' } })
    const overlay = '-ivfsoverlay $(PODS_ROOT)/React-Core-prebuilt/React-VFS.yaml'
    assert.deepEqual(Object.keys(prebuilt.dependencies).slice(-3), ['React-jsc', 'ReactNativeDependencies', 'React-Core-prebuilt'])
    assert.deepEqual([prebuilt.pod_target_xcconfig.OTHER_CFLAGS, prebuilt.pod_target_xcconfig.OTHER_CPLUSPLUSFLAGS, prebuilt.pod_target_xcconfig.OTHER_SWIFT_FLAGS], [`$(inherited) ${overlay}`, `$(inherited) -DRCT_NEW_ARCH_ENABLED=1  ${overlay}`, '$(inherited) -DRCT_NEW_ARCH_ENABLED -Xcc -ivfsoverlay -Xcc $(PODS_ROOT)/React-Core-prebuilt/React-VFS.yaml'])
    assert.deepEqual(prebuilt.pod_target_xcconfig.HEADER_SEARCH_PATHS.split(' ').slice(0, 4), ['"a"', yoga, '"${PODS_ROOT}/React-graphics"', '"${PODS_ROOT}/React-graphics/react/renderer/graphics/platform/ios"'])
    // A podspec with no config of its own: what the dependencies' helper adds to the paths is lost.
    assert.equal(parsed(spec('  install_modules_dependencies(s)\n'), { reactNative: '0.85.1' }).pod_target_xcconfig.HEADER_SEARCH_PATHS, yoga)
  })

  it('reads the environment as pod.config.json gives it, else as a known React Native leaves it', () => {
    const source = spec("  s.summary = [ENV['RCT_NEW_ARCH_ENABLED'], ENV['USE_FRAMEWORKS'], ENV['USE_HERMES'], ENV['RCT_USE_RN_DEP'], ENV['OTHER']].join('|')\n")
    const summary = (given) => [parsed(source, given).summary, convert(source, given).conditions]
    assert.deepEqual(summary()[0], '||||')
    assert.deepEqual(summary({ reactNative: '0.78.3' })[0], '1||1||')
    assert.deepEqual(summary({ reactNative: '0.83.9', frameworks: 'static', prebuilt: { deps: true } })[0], '1|static||1|')
    assert.deepEqual(summary({ reactNative: '0.85.1', frameworks: false })[0], '1|||0|')
    assert.deepEqual(summary({ reactNative: '0.88.1', frameworks: 'dynamic', env: { RCT_NEW_ARCH_ENABLED: null, USE_HERMES: '0', OTHER: 'x' } }), ['|dynamic|0|0|x', ['RCT_NEW_ARCH_ENABLED not set', 'USE_FRAMEWORKS=dynamic', 'USE_HERMES=0', 'RCT_USE_RN_DEP=0', 'OTHER=x']])
    // Of a React Native that is not known, only what is given is known; and what the Podfile gave never is.
    assert.deepEqual(summary({ reactNative: '0.79.0', env: { RCT_NEW_ARCH_ENABLED: '1', USE_FRAMEWORKS: null, USE_HERMES: null, RCT_USE_RN_DEP: null, OTHER: null } })[0], '1||||')
    assert.throws(() => convert(source, { reactNative: '0.79.0', env: { RCT_NEW_ARCH_ENABLED: '1' } }), /line 3: `ENV\['USE_FRAMEWORKS'\]` is not given by pod\.config\.json's `env`, and is then as React Native leaves it, which is known only of React Native 0\.78\.0 .*: the lockfile has React-Core at 0\.79\.0/u)
    const app = spec("  s.summary = ENV['APP_PATH']\n")
    assert.throws(() => convert(app, { reactNative: '0.85.1' }), /line 3: `ENV\['APP_PATH'\]` is as the Podfile had it, which pod\.config\.json's `env` has to give/u)
    assert.equal(parsed(app, { reactNative: '0.85.1', env: { APP_PATH: '..' } }).summary, '..')
    assert.equal(parsed(app).summary, null)
  })

  it('knows the helpers of a known React Native as defined, and no helper without React Native', () => {
    const body = "  s.summary = defined?(install_modules_dependencies) != nil ? 'defined' : 'not'\n  s.description = respond_to?(:install_modules_dependencies, true) ? 'responds' : 'not'\n  if defined? install_modules_dependencies\n    s.platforms = { :ios => min_ios_version_supported }\n  end\n"
    const { summary, description, platforms } = parsed(spec(body), { reactNative: '0.78.3' })
    assert.deepEqual([summary, description, platforms], ['defined', 'responds', { ios: '15.1' }])
    assert.deepEqual([parsed(spec(body)).summary, parsed(spec(body)).description, Object.keys(parsed(spec(body)).platforms).length], ['not', 'not', 5])
    assert.throws(() => convert(spec(body), { reactNative: '0.80.0' }), /line 3: `install_modules_dependencies` is React Native's, .*: the lockfile has React-Core at 0\.80\.0/u)
    assert.throws(() => convert(spec('  s.platforms = { :ios => min_ios_version_supported }\n')), /line 3: `min_ios_version_supported` is React Native's, .*: the lockfile has no React-Core/u)
  })
})
