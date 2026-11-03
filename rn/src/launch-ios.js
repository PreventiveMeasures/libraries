// Launches a prebuilt .app on an iOS simulator, as `react-native run-ios --no-packager --simulator NAME
// --binary-path APP` does, but with no Xcode project. The simulator's window is Simulator.app or, from
// Xcode 27, DeviceHub.app, whichever the selected Xcode has.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'

// Resolves to stdout; rejects with the command line and its stderr.
const exec = (file, args) => new Promise((done, failed) => {
  execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => (error === null ? done(stdout) : failed(new Error(`${[file, ...args].join(' ')}: ${stderr.trim() || error.message}`))))
})

// The iOS simulators of `xcrun simctl list devices available --json`, newest runtime first.
export function simulatorsOf(json) {
  const simulators = Object.entries(JSON.parse(json).devices ?? {}).flatMap(([runtime, devices]) => {
    const version = /\.SimRuntime\.iOS-(\d+(?:-\d+)*)$/u.exec(runtime)?.[1].replaceAll('-', '.')
    if (version === undefined) return []
    return devices.filter((device) => device.isAvailable !== false).map(({ udid, name, state, lastBootedAt }) => ({ udid, name, state, version, lastBootedAt: lastBootedAt ?? null }))
  })
  // Numeric collation compares each run of digits as a number: 18.10 is newer than 18.6.
  return simulators.toSorted((a, b) => b.version.localeCompare(a.version, 'en', { numeric: true }))
}

// The simulator `wanted` names by UDID, name, or as run-ios takes it, name and version ("iPhone 17 (26.0)"),
// preferring a booted one, then the newest runtime's. With no `wanted`: the booted one, else the last booted,
// else the first iPhone. Throws if there's none.
export function chooseSimulator(simulators, wanted = null) {
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
  if (found === undefined) {
    const listed = simulators.map(({ name, version, udid }) => `${name} (${version}) ${udid}`).join(', ') || 'none'
    throw new Error(`no iOS simulator ${JSON.stringify(wanted)}: of ${listed}`)
  }
  return found
}

// A value of the app's Info.plist, or null. Strings need format `raw`: plutil's `json` refuses non-collections.
async function infoOf(run, appPath, key, format) {
  try {
    const out = await run('plutil', ['-extract', key, format, '-o', '-', join(appPath, 'Info.plist')])
    return format === 'raw' ? out.trim() || null : JSON.parse(out)
  } catch {
    return null
  }
}

// Installs and launches `appPath` on the simulator `simulator` names, pointing it at the dev server `location`
// (host:port) by an RCT_jsLocation argument: RCTBundleURLProvider reads it from user defaults, for this launch only.
// Rejects if a step fails, except opening the window, which is only logged.
export async function launchIos({ appPath, simulator: wanted = null, location, log = () => {}, run = exec, exists = existsSync }) {
  const bundleId = await infoOf(run, appPath, 'CFBundleIdentifier', 'raw')
  if (bundleId === null) throw new Error(`${appPath} has no CFBundleIdentifier in its Info.plist: it is no app`)
  const platforms = await infoOf(run, appPath, 'CFBundleSupportedPlatforms', 'json')
  if (Array.isArray(platforms) && !platforms.includes('iPhoneSimulator')) throw new Error(`${basename(appPath)} is built for ${platforms.join(', ')}, not a simulator: build it for one (xcodebuild -sdk iphonesimulator)`)
  const simulator = chooseSimulator(simulatorsOf(await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])), wanted)
  const { udid } = simulator
  log(`rn-serve: launching ${bundleId} (${basename(appPath)}) on ${simulator.name} (iOS ${simulator.version})`)
  // DeviceHub.app is in the Xcode app's Applications, not Developer's, and opens a simulator by URL.
  try {
    const developer = (await run('xcode-select', ['-p'])).trim()
    const simulatorApp = join(developer, 'Applications', 'Simulator.app')
    const deviceHub = join(developer, '..', 'Applications', 'DeviceHub.app')
    if (exists(simulatorApp)) await run('open', [simulatorApp, '--args', '-CurrentDeviceUDID', udid])
    else if (exists(deviceHub)) await run('open', [`devices://device/open?id=${udid}`])
  } catch (error) {
    log(`rn-serve: can't open the simulator's window, the app runs in none: ${error.message}`)
  }
  // bootstatus -b boots it and waits for the boot to finish, which `simctl boot` doesn't if Simulator.app is booting it.
  if (simulator.state !== 'Booted') await run('xcrun', ['simctl', 'bootstatus', udid, '-b'])
  await run('xcrun', ['simctl', 'install', udid, appPath])
  await run('xcrun', ['simctl', 'launch', '--terminate-running-process', udid, bundleId, '-RCT_jsLocation', location])
  return { bundleId, simulator }
}
