import assert from 'node:assert/strict'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'

import { writeTree } from './fixtures.js'
import { applicationIdOf, devicesOf, launchAndroid, sdkTool, variantApk } from '../src/launch-android.js'

// Gradle's output-metadata.json of a variant's APKs, as AGP 8 writes it.
const metadata = (variantName, applicationId, elements) => ({ version: 3, artifactType: { type: 'APK', kind: 'Directory' }, applicationId, variantName, elements })
const single = (outputFile) => ({ type: 'SINGLE', filters: [], versionCode: 1, versionName: '1.0', outputFile })

describe('sdkTool', () => {
  it("is of ANDROID_HOME, else ANDROID_SDK_ROOT, else on PATH, as run-android's", () => {
    assert.equal(sdkTool('platform-tools/adb', { ANDROID_HOME: '/sdk', ANDROID_SDK_ROOT: '/old' }), join('/sdk', 'platform-tools/adb'))
    assert.equal(sdkTool('emulator/emulator', { ANDROID_SDK_ROOT: '/old' }), join('/old', 'emulator/emulator'))
    assert.equal(sdkTool('platform-tools/adb', { ANDROID_HOME: '' }), 'adb')
  })
})

describe('devicesOf', () => {
  it('lists the devices of `adb devices`, of each its state, past what the daemon says starting', () => {
    const text = '* daemon not running; starting now at tcp:5037\n* daemon started successfully\nList of devices attached\nemulator-5554\tdevice\nR58M123\tunauthorized\n192.168.1.9:5555\toffline\n\n'
    assert.deepEqual(devicesOf(text), [{ serial: 'emulator-5554', state: 'device' }, { serial: 'R58M123', state: 'unauthorized' }, { serial: '192.168.1.9:5555', state: 'offline' }])
    assert.deepEqual(devicesOf('List of devices attached\n\n'), [])
  })
})

describe('variantApk, applicationIdOf', () => {
  const APK = 'android/app/build/outputs/apk'
  const { root, cleanup } = writeTree({
    [`${APK}/debug/output-metadata.json`]: metadata('debug', 'com.example.app.debug', [single('app-debug.apk')]),
    [`${APK}/debug/app-debug.apk`]: 'PK',
    [`${APK}/free/debug/output-metadata.json`]: metadata('freeDebug', 'com.example.free', [single('app-free-debug.apk')]),
    [`${APK}/free/debug/app-free-debug.apk`]: 'PK',
    [`${APK}/split/debug/output-metadata.json`]: metadata('splitDebug', 'com.example.split', [{ ...single('app-split-arm64-v8a-debug.apk'), type: 'ONE_OF_MANY', filters: [{ filterType: 'ABI', value: 'arm64-v8a' }] }]),
    'elsewhere/app.apk': 'PK',
  })
  after(cleanup)

  it('finds the APK Gradle built of a variant, of its flavors too, by the output-metadata.json beside it, with its application ID', () => {
    assert.deepEqual(variantApk(root, 'debug'), { apkPath: join(root, APK, 'debug/app-debug.apk'), applicationId: 'com.example.app.debug' })
    assert.deepEqual(variantApk(root, 'freeDebug'), { apkPath: join(root, APK, 'free/debug/app-free-debug.apk'), applicationId: 'com.example.free' })
  })

  it('refuses a variant Gradle built none of, saying how to build it, and one of an APK per ABI alone', () => {
    assert.throws(() => variantApk(root, 'release'), { message: 'no APK of the variant release in android/app/build/outputs/apk: build one (cd android && ./gradlew assembleRelease), or give one by --binary-path' })
    assert.throws(() => variantApk(root, 'splitDebug'), { message: `the variant splitDebug has an APK per ABI, in ${join(APK, 'split/debug')}: give the one to install, by --binary-path` })
    assert.throws(() => variantApk(join(root, 'elsewhere'), 'debug'), { message: /^no APK of the variant debug/u })
  })

  it('reads the application ID of an APK off the output-metadata.json that lists it, else none', () => {
    assert.equal(applicationIdOf(join(root, APK, 'debug/app-debug.apk')), 'com.example.app.debug')
    assert.equal(applicationIdOf(join(root, APK, 'debug/renamed.apk')), null)
    assert.equal(applicationIdOf(join(root, 'elsewhere/app.apk')), null)
  })
})

describe('launchAndroid', () => {
  const ENV = { ANDROID_HOME: '' }
  // The commands it runs, each answered as the SDK's would. `online`, the serials `adb devices` lists,
  // each call the next of them (the last thereafter); `avds`, the emulator's AVDs and, by serial, those running.
  const runner = ({ online = [['emulator-5554']], avds = { list: ['Pixel_8'], running: { 'emulator-5554': 'Pixel_8' } }, activity = 'com.example.app/.MainActivity', started = 'Starting: Intent { cmp=com.example.app/.MainActivity }\nStatus: ok\nLaunchState: COLD\nActivity: com.example.app/.MainActivity\nTotalTime: 812\nWaitTime: 815\nComplete', booted = ['1'], aapt2 = '' } = {}) => {
    const calls = []
    let listed = 0
    let polled = 0
    const answer = (file, args) => {
      calls.push([file, ...args])
      const line = args.join(' ')
      if (file.endsWith('emulator')) return `${avds.list.join('\n')}\n`
      if (file.endsWith('aapt2')) {
        if (aapt2 === '') throw new Error('aapt2: not found')
        return `${aapt2}\n`
      }
      if (line === 'devices') return `List of devices attached\n${online[Math.min(listed++, online.length - 1)].map((serial) => `${serial}\tdevice\n`).join('')}\n`
      if (line.endsWith('emu avd name')) return `${avds.running[args[1]]}\r\nOK\r\n`
      if (line.endsWith('getprop sys.boot_completed')) return `${booted[Math.min(polled++, booted.length - 1)]}\n`
      if (line.includes('resolve-activity')) return `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${activity}\n`
      if (line.includes(' am start ')) return `${started}\n`
      return ''
    }
    const run = (file, args) => new Promise((done) => {
      done(answer(file, args))
    })
    const starts = []
    return { calls, run, starts, start: (file, args) => starts.push([file, ...args]) }
  }
  const launched = async (options = {}, launch = {}) => {
    const fake = runner(options)
    const logged = []
    const result = await launchAndroid({ apkPath: '/app/app-debug.apk', applicationId: 'com.example.app', port: 8082, log: (line) => logged.push(line), env: ENV, run: fake.run, start: fake.start, interval: 0, ...launch })
    return { ...fake, logged, result }
  }
  const MAIN = ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER']

  it("installs it on the device online, once booted, reverses the dev server's port to this machine, and starts its launcher activity", async () => {
    const { calls, logged, result } = await launched()
    assert.deepEqual(calls, [
      ['adb', 'devices'],
      ['adb', '-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed'],
      ['adb', '-s', 'emulator-5554', 'install', '-r', '-d', '/app/app-debug.apk'],
      ['adb', '-s', 'emulator-5554', 'reverse', 'tcp:8082', 'tcp:8082'],
      ['adb', '-s', 'emulator-5554', 'shell', 'cmd', 'package', 'resolve-activity', '--brief', ...MAIN, 'com.example.app'],
      ['adb', '-s', 'emulator-5554', 'shell', 'am', 'start', '-W', '-n', 'com.example.app/.MainActivity', ...MAIN],
    ])
    assert.deepEqual(logged, ['rn-serve: launching com.example.app (app-debug.apk) on emulator-5554'])
    assert.deepEqual(result, { applicationId: 'com.example.app', devices: ['emulator-5554'] })
  })

  it('launches on each device online, as run-android does, but the one named, by its serial or its AVD', async () => {
    const both = { online: [['emulator-5554', 'R58M123']] }
    assert.deepEqual((await launched(both)).result.devices, ['emulator-5554', 'R58M123'])
    assert.deepEqual((await launched(both, { device: 'R58M123' })).result.devices, ['R58M123'])
    const { calls, result } = await launched(both, { device: 'Pixel_8' })
    assert.deepEqual(result.devices, ['emulator-5554'])
    assert.deepEqual(calls[1], ['adb', '-s', 'emulator-5554', 'emu', 'avd', 'name'])
  })

  it('waits for a device online to have booted, as adb has one online before it has', async () => {
    const { calls, starts } = await launched({ booted: ['', '0', '1'] })
    assert.deepEqual(starts, [])
    assert.deepEqual(calls.slice(1, 5).map((line) => line.slice(3).join(' ')), ['shell getprop sys.boot_completed', 'shell getprop sys.boot_completed', 'shell getprop sys.boot_completed', 'install -r -d /app/app-debug.apk'])
    await assert.rejects(launched({ booted: ['0'] }, { timeouts: { online: 0, booted: 0 } }), { message: 'emulator-5554 to boot took longer than 0 s' })
  })

  it('starts the emulator of the first AVD where no device is online, or of the one named, and waits till it has booted', async () => {
    const options = { online: [[], [], ['emulator-5556']], avds: { list: ['Pixel_8', 'Tablet'], running: { 'emulator-5556': 'Pixel_8' } }, booted: ['', '0', '1'] }
    const { calls, starts, logged, result } = await launched(options)
    assert.deepEqual(starts, [['emulator', '@Pixel_8']])
    assert.deepEqual(result.devices, ['emulator-5556'])
    assert.equal(logged[0], 'rn-serve: starting the emulator Pixel_8')
    assert.equal(calls.filter((line) => line.at(-1) === 'sys.boot_completed').length, 3)
    assert.ok(calls.findIndex((line) => line.includes('install')) > calls.findLastIndex((line) => line.at(-1) === 'sys.boot_completed'))
    const tablet = await launched({ ...options, avds: { list: ['Pixel_8', 'Tablet'], running: { 'emulator-5556': 'Tablet' } } }, { device: 'Tablet' })
    assert.deepEqual([tablet.starts, tablet.result.devices], [[['emulator', '@Tablet']], ['emulator-5556']])
  })

  it('refuses a device not there, listing those there are, and gives up on an emulator that never comes online', async () => {
    await assert.rejects(launched({}, { device: 'Phone' }), { message: 'no Android device or emulator "Phone": of emulator-5554, Pixel_8' })
    await assert.rejects(launched({ online: [[]], avds: { list: [], running: {} } }), { message: 'no Android device online, and no emulator to start: emulator -list-avds lists none' })
    await assert.rejects(launched({ online: [[]] }, { timeouts: { online: 0, booted: 0 } }), { message: 'the emulator Pixel_8 to come online took longer than 0 s' })
  })

  // With -W, am start says of an error on stdout, as of its start (ActivityManagerShellCommand's runStartActivity).
  it("refuses an app of no launcher activity, and what am start says it failed to start, though it exits 0", async () => {
    await assert.rejects(launched({ activity: 'No activity found' }), { message: 'com.example.app has no launcher activity on emulator-5554: No activity found' })
    await assert.rejects(launched({ started: 'Error: Activity class {com.example.app/.MainActivity} does not exist.' }), { message: 'am start -n com.example.app/.MainActivity on emulator-5554: Error: Activity class {com.example.app/.MainActivity} does not exist.' })
  })

  it("reads the package of an APK no output-metadata.json names by the newest aapt2 of the SDK's build-tools, else refuses it", async () => {
    const { root, cleanup } = writeTree({ 'build-tools/9.0.0/aapt2': '', 'build-tools/35.0.0/aapt2': '', 'build-tools/36.1.0/aapt2': '' })
    try {
      const { calls, result } = await launched({ aapt2: 'com.example.other', activity: 'com.example.other/.MainActivity' }, { applicationId: null, env: { ANDROID_HOME: root } })
      assert.deepEqual(calls[0], [join(root, 'build-tools/36.1.0/aapt2'), 'dump', 'packagename', '/app/app-debug.apk'])
      assert.deepEqual([calls[1], result.applicationId], [[join(root, 'platform-tools/adb'), 'devices'], 'com.example.other'])
    } finally {
      cleanup()
    }
    await assert.rejects(launched({}, { applicationId: null }), { message: "can't tell the package of app-debug.apk: no output-metadata.json of Gradle's beside it, and no aapt2 (the SDK's build-tools) to read it" })
  })
})
