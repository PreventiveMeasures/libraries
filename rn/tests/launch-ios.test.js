import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import { chooseSimulator, launchIos, simulatorsOf } from '../src/launch-ios.js'

// `xcrun simctl list devices available --json`, as Xcode 26 lists them: of
// two iOS runtimes, a watchOS one, and a simulator no longer available.
const LIST = JSON.stringify({
  devices: {
    'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [
      { udid: 'OLD-17', name: 'iPhone 17', state: 'Shutdown', isAvailable: true },
      { udid: 'OLD-SE', name: 'iPhone SE (3rd generation)', state: 'Shutdown', isAvailable: true },
    ],
    'com.apple.CoreSimulator.SimRuntime.iOS-26-0': [
      { udid: 'IPAD', name: 'iPad Pro 13-inch (M5)', state: 'Shutdown', isAvailable: true },
      { udid: 'NEW-17', name: 'iPhone 17', state: 'Shutdown', isAvailable: true, lastBootedAt: '2026-10-01T09:00:00Z' },
      { udid: 'GONE', name: 'iPhone 16', state: 'Shutdown', isAvailable: false },
    ],
    'com.apple.CoreSimulator.SimRuntime.watchOS-26-0': [{ udid: 'WATCH', name: 'Apple Watch Series 11 (46mm)', state: 'Booted', isAvailable: true }],
  },
})
const udids = (list) => list.map(({ udid }) => udid)

describe('simulatorsOf', () => {
  it("lists the iOS simulators available, of the newest runtime first, of each its runtime's version", () => {
    const simulators = simulatorsOf(LIST)
    assert.deepEqual(udids(simulators), ['IPAD', 'NEW-17', 'OLD-17', 'OLD-SE'])
    assert.deepEqual(simulators[1], { udid: 'NEW-17', name: 'iPhone 17', state: 'Shutdown', version: '26.0', lastBootedAt: '2026-10-01T09:00:00Z' })
    assert.equal(simulators[2].version, '18.6')
  })
})

describe('chooseSimulator', () => {
  const simulators = simulatorsOf(LIST)
  const booted = (udid) => simulators.map((each) => (each.udid === udid ? { ...each, state: 'Booted' } : each))

  it('takes it by name, of several the booted, else the newest runtime\'s; by name and version, as run-ios; by UDID', () => {
    assert.equal(chooseSimulator(simulators, 'iPhone 17').udid, 'NEW-17')
    assert.equal(chooseSimulator(booted('OLD-17'), 'iPhone 17').udid, 'OLD-17')
    assert.equal(chooseSimulator(simulators, 'iPhone 17 (18.6)').udid, 'OLD-17')
    assert.equal(chooseSimulator(simulators, 'iPhone SE (3rd generation)').udid, 'OLD-SE')
    assert.equal(chooseSimulator(simulators, 'OLD-SE').udid, 'OLD-SE')
  })

  it('takes, of none named, the one booted, else the one last booted, else the first iPhone', () => {
    assert.equal(chooseSimulator(booted('OLD-SE')).udid, 'OLD-SE')
    assert.equal(chooseSimulator(simulators).udid, 'NEW-17')
    assert.equal(chooseSimulator(simulators.map((each) => ({ ...each, lastBootedAt: null }))).udid, 'NEW-17')
  })

  it('throws of one not there, listing those there are, and of none', () => {
    assert.throws(() => chooseSimulator(simulators, 'iPhone 99'), { message: 'no iOS simulator "iPhone 99": of iPad Pro 13-inch (M5) (26.0) IPAD, iPhone 17 (26.0) NEW-17, iPhone 17 (18.6) OLD-17, iPhone SE (3rd generation) (18.6) OLD-SE' })
    assert.throws(() => chooseSimulator(simulators, 'iPhone 16'), { message: /^no iOS simulator "iPhone 16"/u })
    assert.throws(() => chooseSimulator([]), { message: /^no iOS simulator: Xcode lists none available/u })
  })
})

describe('launchIos', () => {
  const DEVELOPER = '/Applications/Xcode.app/Contents/Developer'
  // The commands it runs, each answered as Xcode's would; `fails`, those
  // that fail, by their command line's start.
  const runner = ({ platforms = ['iPhoneSimulator'], list = LIST, fails = [] } = {}) => {
    const calls = []
    const answer = (file, args) => {
      const line = [file, ...args]
      calls.push(line)
      if (fails.some((start) => line.join(' ').startsWith(start))) throw new Error(`${line.join(' ')}: it failed`)
      if (file === 'plutil') {
        const [, key, format] = args
        const value = key === 'CFBundleIdentifier' ? 'com.example.app' : platforms
        // As plutil: of json, an array or a dictionary alone; of raw, a string as it is.
        if (format === 'json' && typeof value === 'string') throw new Error(`plutil: ${args.at(-1)}: invalid object in plist for JSON format`)
        return format === 'raw' ? `${value}\n` : JSON.stringify(value)
      }
      if (file === 'xcode-select') return `${DEVELOPER}\n`
      if (args.join(' ') === 'simctl list devices available --json') return list
      return ''
    }
    // As a command's, a promise: rejected of one that fails.
    const run = (file, args) => new Promise((done) => {
      done(answer(file, args))
    })
    return { calls, run }
  }
  const launched = async (options = {}, exists = (path) => path === `${DEVELOPER}/Applications/Simulator.app`) => {
    const { calls, run } = runner(options)
    const logged = []
    const result = await launchIos({ appPath: '/app/App.app', simulator: 'iPhone 17', location: '127.0.0.1:8082', log: (line) => logged.push(line), run, exists, ...options.launch })
    return { calls, logged, result }
  }

  it('opens Simulator.app on it, boots it, installs the app and launches it, told where rn-serve is', async () => {
    const { calls, logged, result } = await launched()
    assert.deepEqual(calls, [
      ['plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', '/app/App.app/Info.plist'],
      ['plutil', '-extract', 'CFBundleSupportedPlatforms', 'json', '-o', '-', '/app/App.app/Info.plist'],
      ['xcrun', 'simctl', 'list', 'devices', 'available', '--json'],
      ['xcode-select', '-p'],
      ['open', `${DEVELOPER}/Applications/Simulator.app`, '--args', '-CurrentDeviceUDID', 'NEW-17'],
      ['xcrun', 'simctl', 'bootstatus', 'NEW-17', '-b'],
      ['xcrun', 'simctl', 'install', 'NEW-17', '/app/App.app'],
      ['xcrun', 'simctl', 'launch', '--terminate-running-process', 'NEW-17', 'com.example.app', '-RCT_jsLocation', '127.0.0.1:8082'],
    ])
    assert.deepEqual(logged, ['rn-serve: launching com.example.app (App.app) on iPhone 17 (iOS 26.0)'])
    assert.deepEqual([result.bundleId, result.simulator.udid], ['com.example.app', 'NEW-17'])
  })

  it("opens Xcode 27's DeviceHub where there's no Simulator.app, and neither where there's none", async () => {
    const hub = await launched({}, (path) => path === '/Applications/Xcode.app/Contents/Applications/DeviceHub.app')
    assert.deepEqual(hub.calls.find(([file]) => file === 'open'), ['open', 'devices://device/open?id=NEW-17'])
    const none = await launched({}, () => false)
    assert.equal(none.calls.find(([file]) => file === 'open'), undefined)
    assert.ok(none.calls.some((line) => line.includes('launch')))
  })

  it('boots none booted already', async () => {
    const list = LIST.replace('"udid":"NEW-17","name":"iPhone 17","state":"Shutdown"', '"udid":"NEW-17","name":"iPhone 17","state":"Booted"')
    const { calls } = await launched({ list })
    assert.equal(calls.find((line) => line.includes('bootstatus')), undefined)
  })

  it("launches it though Simulator.app doesn't open, saying so", async () => {
    const { calls, logged } = await launched({ fails: ['open'] })
    assert.match(logged[1], /^rn-serve: can't open the simulator's window, the app runs in none: open .*: it failed$/u)
    assert.ok(calls.at(-1).includes('launch'))
  })

  it("refuses a device's build, and an .app of no bundle ID, before running simctl", async () => {
    await assert.rejects(launched({ platforms: ['iPhoneOS'] }), { message: 'App.app is built for iPhoneOS, not a simulator: build it for one (xcodebuild -sdk iphonesimulator)' })
    const { calls, run } = runner({ fails: ['plutil -extract CFBundleIdentifier'] })
    await assert.rejects(launchIos({ appPath: '/app/App.app', location: '127.0.0.1:8081', run }), { message: '/app/App.app has no CFBundleIdentifier in its Info.plist: it is no app' })
    assert.ok(!calls.some(([file]) => file === 'xcrun'))
  })

  // plutil, macOS's alone: of an Info.plist as Xcode writes it, binary.
  it("reads the app's bundle ID and platforms off its Info.plist by plutil", { skip: process.platform !== 'darwin' && "plutil is macOS's" }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'launch-ios-'))
    try {
      const app = join(dir, 'App.app')
      mkdirSync(app)
      const plist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.real</string><key>CFBundleSupportedPlatforms</key><array><string>iPhoneSimulator</string></array></dict></plist>\n'
      writeFileSync(join(app, 'Info.plist'), plist)
      execFileSync('plutil', ['-convert', 'binary1', join(app, 'Info.plist')])
      const { calls, run: fake } = runner()
      const real = (file, args) => (file === 'plutil' ? new Promise((done, failed) => execFile(file, args, { encoding: 'utf8' }, (error, stdout) => (error === null ? done(stdout) : failed(error)))) : fake(file, args))
      const { bundleId } = await launchIos({ appPath: app, simulator: 'iPhone 17', location: '127.0.0.1:8081', run: real, exists: () => false })
      assert.equal(bundleId, 'com.example.real')
      assert.deepEqual(calls.at(-1).slice(-3), ['com.example.real', '-RCT_jsLocation', '127.0.0.1:8081'])
      // A device's build, refused.
      execFileSync('plutil', ['-replace', 'CFBundleSupportedPlatforms', '-json', '["iPhoneOS"]', join(app, 'Info.plist')])
      await assert.rejects(launchIos({ appPath: app, location: '127.0.0.1:8081', run: real }), { message: /^App\.app is built for iPhoneOS, not a simulator/u })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('fails as the install fails, launching nothing', async () => {
    await assert.rejects(launched({ fails: ['xcrun simctl install'] }), { message: /^xcrun simctl install NEW-17 \/app\/App\.app: it failed$/u })
  })
})
