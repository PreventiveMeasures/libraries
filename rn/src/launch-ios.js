// An app launched on an iOS simulator, as `react-native run-ios
// --no-packager --simulator NAME --binary-path APP` launches it
// (@react-native-community/cli-platform-apple's runOnSimulator() and
// installApp()), but of no Xcode project, of which run-ios asks xcodebuild
// its build settings even so: the simulator's window opened, the simulator
// booted, the app installed, and launched, told where rn-serve is. The
// window is Xcode's Simulator.app, else, from Xcode 27, its DeviceHub.app,
// whichever Xcode has (`xcode-select -p`'s): run-ios before 20.2 opens
// Simulator.app where Xcode has none, which a shim of `open` on PATH then
// takes to DeviceHub; none is needed here.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

// A command's output: -> a promise of its stdout; rejects of its stderr.
const exec = (file, args) => new Promise((done, failed) => {
  execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => (error === null ? done(stdout) : failed(new Error(`${[file, ...args].join(' ')}: ${stderr.trim() || error.message}`))))
})

// `xcrun simctl list devices available --json`'s iOS simulators: { udid,
// name, state, version ('26.0'), lastBootedAt }, of the newest runtime
// first, then as it lists them.
export function simulatorsOf(json) {
  const runtimes = Object.entries(JSON.parse(json).devices ?? {}).flatMap(([runtime, devices]) => {
    const match = /\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/u.exec(runtime)
    return match === null ? [] : [{ version: match[1].replaceAll('-', '.'), devices }]
  })
  const newer = (a, b) => {
    const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)]
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0)
    return 0
  }
  return runtimes.toSorted((a, b) => newer(a.version, b.version)).flatMap(({ version, devices }) => devices
    .filter((device) => device.isAvailable !== false)
    .map(({ udid, name, state, lastBootedAt }) => ({ udid, name, state, version, lastBootedAt: lastBootedAt ?? null })))
}

// The simulator `wanted` names: its UDID, its name, or as run-ios takes it,
// its name and its runtime's version ("iPhone 17 (26.0)"); of several of
// the name, the one booted, else the newest runtime's. Of none named, the
// one booted, else the one last booted, else the first iPhone of the newest
// runtime. -> it; throws, listing those there are, where there's none.
export function chooseSimulator(simulators, wanted = null) {
  const listed = () => simulators.map(({ name, version, udid }) => `${name} (${version}) ${udid}`).join(', ') || 'none'
  if (wanted === null) {
    const found = simulators.find(({ state }) => state === 'Booted')
      ?? simulators.filter(({ lastBootedAt }) => lastBootedAt !== null).toSorted((a, b) => String(b.lastBootedAt).localeCompare(String(a.lastBootedAt)))[0]
      ?? simulators.find(({ name }) => name.startsWith('iPhone'))
      ?? simulators[0]
    if (found === undefined) throw new Error('no iOS simulator: Xcode lists none available (xcrun simctl list devices available)')
    return found
  }
  const byName = /^(.*) \((\d+(?:\.\d+)*)\)$/u.exec(wanted)
  const named = simulators.filter(({ udid, name, version }) => udid === wanted || (byName === null ? name === wanted : name === byName[1] && version === byName[2]))
  const found = named.find(({ state }) => state === 'Booted') ?? named[0]
  if (found === undefined) throw new Error(`no iOS simulator ${JSON.stringify(wanted)}: of ${listed()}`)
  return found
}

// A value of the app's Info.plist, as plutil gives it (JSON); null where
// it has none.
async function infoOf(run, appPath, key) {
  try {
    return JSON.parse(await run('plutil', ['-extract', key, 'json', '-o', '-', join(appPath, 'Info.plist')]))
  } catch {
    return null
  }
}

// Launches the app at `appPath` (a simulator's build of it, an .app) on the
// simulator `simulator` names (chooseSimulator()'s), telling it where its
// dev server is (`location`, host:port): as its RCT_jsLocation, which React
// Native's RCTBundleURLProvider reads of its user defaults, given it as an
// argument, of this launch alone. `run(file, args)` runs a command, `exists`
// tells whether a path is. -> a promise of { bundleId, simulator }; rejects
// of a step that fails, but opening the simulator's window, which is logged.
export async function launchIos({ appPath, simulator: wanted = null, location, log = () => {}, run = exec, exists = existsSync }) {
  const bundleId = await infoOf(run, appPath, 'CFBundleIdentifier')
  if (typeof bundleId !== 'string') throw new Error(`${appPath} has no CFBundleIdentifier in its Info.plist: it is no app`)
  const platforms = await infoOf(run, appPath, 'CFBundleSupportedPlatforms')
  if (Array.isArray(platforms) && !platforms.includes('iPhoneSimulator')) throw new Error(`${basename(appPath)} is built for ${platforms.join(', ')}, not a simulator: build it for one (xcodebuild -sdk iphonesimulator)`)
  const simulator = chooseSimulator(simulatorsOf(await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])), wanted)
  const { udid } = simulator
  log(`rn-serve: launching ${bundleId} (${basename(appPath)}) on ${simulator.name} (iOS ${simulator.version})`)
  // Simulator.app, else Xcode 27's DeviceHub.app (in the Xcode app's
  // Applications, not its Developer's), which opens the simulator by URL.
  try {
    const developer = (await run('xcode-select', ['-p'])).trim()
    const simulatorApp = join(developer, 'Applications', 'Simulator.app')
    const deviceHub = join(developer, '..', 'Applications', 'DeviceHub.app')
    if (exists(simulatorApp)) await run('open', [simulatorApp, '--args', '-CurrentDeviceUDID', udid])
    else if (exists(deviceHub)) await run('open', [`devices://device/open?id=${udid}`])
  } catch (error) {
    log(`rn-serve: can't open the simulator's window, the app runs in none: ${error.message}`)
  }
  // Booted, and its boot done (bootstatus waits for it, as `simctl boot`
  // doesn't of one Simulator.app boots), before the app is installed.
  if (simulator.state !== 'Booted') await run('xcrun', ['simctl', 'bootstatus', udid, '-b'])
  await run('xcrun', ['simctl', 'install', udid, appPath])
  await run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId, '-RCT_jsLocation', location])
  return { bundleId, simulator }
}
