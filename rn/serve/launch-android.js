// Launches a prebuilt APK on Android devices and emulators, as `react-native run-android --no-packager
// --binary-path APK` (or --mode VARIANT) does, but with no Gradle build: installed, the dev server's port
// reversed to this machine (adb reverse), and its launcher activity started. With no device online, the
// emulator of the first AVD, or the one named, is started and waited for, as run-android starts one.

import { execFile, spawn } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

// Resolves to stdout; rejects with the command line and its stderr.
const exec = (file, args) => new Promise((done, failed) => {
  execFile(file, args, { encoding: 'utf8' }, (error, stdout, stderr) => (error === null ? done(stdout) : failed(new Error(`${[file, ...args].join(' ')}: ${stderr.trim() || error.message}`))))
})

// The emulator, in a process group of its own: it stays open as rn-serve quits, as Simulator.app does.
const startDetached = (file, args) => {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' })
  child.on('error', () => {})
  child.unref()
}

const sdkHome = (env) => env.ANDROID_HOME || env.ANDROID_SDK_ROOT || null

// The SDK's tool at `path` (platform-tools/adb, emulator/emulator) in ANDROID_HOME, else
// ANDROID_SDK_ROOT, else on PATH, as run-android finds it.
export const sdkTool = (path, env = process.env) => (sdkHome(env) === null ? basename(path) : join(sdkHome(env), path))

// The devices of `adb devices`: [{ serial, state }], state `device` where online.
export const devicesOf = (text) => [...text.matchAll(/^(\S+)\t(\S+)\s*$/gmu)].map(([, serial, state]) => ({ serial, state }))

// Gradle's output-metadata.json in `dir`, of the APKs it built there, or null.
function metadataOf(dir) {
  try {
    const metadata = JSON.parse(readFileSync(join(dir, 'output-metadata.json'), 'utf8'))
    return Array.isArray(metadata?.elements) ? metadata : null
  } catch {
    return null
  }
}

// The application ID of the APK at `apkPath`, as the output-metadata.json Gradle wrote beside it has it, or null.
export function applicationIdOf(apkPath) {
  const metadata = metadataOf(dirname(apkPath))
  const listed = metadata?.elements.some(({ outputFile }) => outputFile === basename(apkPath))
  return listed && typeof metadata.applicationId === 'string' ? metadata.applicationId : null
}

// The APK Gradle built of `variant` ("debug", "freeDebug", as debuggableVariants names it) for the project's
// android/app, by the output-metadata.json of its outputs: { apkPath, applicationId }. Throws where it built
// none, or one per ABI alone, of which --binary-path names the one to install.
export function variantApk(projectRoot, variant) {
  const outputs = join(projectRoot, 'android', 'app', 'build', 'outputs', 'apk')
  let names = []
  try {
    names = readdirSync(outputs, { recursive: true }).filter((name) => basename(name) === 'output-metadata.json')
  } catch {
    // Not built.
  }
  for (const name of names) {
    const dir = dirname(join(outputs, name))
    const metadata = metadataOf(dir)
    if (metadata?.variantName !== variant) continue
    const whole = metadata.elements.find(({ filters, outputFile }) => (filters ?? []).length === 0 && typeof outputFile === 'string')
    if (whole === undefined) throw new Error(`the variant ${variant} has an APK per ABI, in ${relative(projectRoot, dir)}: give the one to install, by --binary-path`)
    return { apkPath: join(dir, whole.outputFile), applicationId: typeof metadata.applicationId === 'string' ? metadata.applicationId : null }
  }
  const task = `assemble${variant.charAt(0).toUpperCase()}${variant.slice(1)}`
  throw new Error(`no APK of the variant ${variant} in android/app/build/outputs/apk: build one (cd android && ./gradlew ${task}), or give one by --binary-path`)
}

// The package of the APK, by the newest aapt2 of the SDK's build-tools, where no output-metadata.json gives it.
async function packageOf(run, apkPath, env) {
  let aapt2 = 'aapt2'
  try {
    const [newest] = readdirSync(join(sdkHome(env), 'build-tools')).toSorted((a, b) => b.localeCompare(a, 'en', { numeric: true }))
    if (newest !== undefined) aapt2 = join(sdkHome(env), 'build-tools', newest, 'aapt2')
  } catch {
    // No ANDROID_HOME, or no build-tools: aapt2 on PATH, if there.
  }
  const found = await run(aapt2, ['dump', 'packagename', apkPath]).then((out) => out.trim(), () => '')
  if (found === '') throw new Error(`can't tell the package of ${basename(apkPath)}: no output-metadata.json of Gradle's beside it, and no aapt2 (the SDK's build-tools) to read it`)
  return found
}

// Calls get() each `interval` ms till it gives other than null, which it resolves to; rejects past `timeout` ms.
async function poll(get, { interval, timeout, what }) {
  for (const end = Date.now() + timeout; ; await sleep(interval)) {
    const value = await get()
    if (value !== null) return value
    if (Date.now() >= end) throw new Error(`${what} took longer than ${Math.round(timeout / 1000)} s`)
  }
}

// The serials to launch on: the one `wanted` names by serial or by its AVD's name, else each online, as
// run-android installs on each. With none, an emulator started, of the AVD wanted, else the first, and
// waited for till adb has it online.
async function devicesFor({ run, adb, emulator, start, wanted, log, interval, timeouts }) {
  const online = async () => devicesOf(await run(adb, ['devices'])).filter(({ state }) => state === 'device').map(({ serial }) => serial)
  const avdOf = async (serial) => (serial.startsWith('emulator-') ? (await run(adb, ['-s', serial, 'emu', 'avd', 'name']).catch(() => '')).split('\n')[0].trim() : '')
  const serials = await online()
  if (wanted === null && serials.length > 0) return serials
  if (serials.includes(wanted)) return [wanted]
  for (const serial of serials) if ((await avdOf(serial)) === wanted) return [serial]
  const avds = (await run(emulator, ['-list-avds']).catch(() => '')).split('\n').map((line) => line.trim()).filter((line) => /^[\w.-]+$/u.test(line))
  const avd = wanted ?? avds[0]
  if (!avds.includes(avd)) {
    if (wanted === null) throw new Error('no Android device online, and no emulator to start: emulator -list-avds lists none')
    throw new Error(`no Android device or emulator ${JSON.stringify(wanted)}: of ${[...serials, ...avds].join(', ') || 'none'}`)
  }
  log(`rn-serve: starting the emulator ${avd}`)
  start(emulator, [`@${avd}`])
  const serial = await poll(async () => {
    for (const each of await online().catch(() => [])) if (!serials.includes(each) && (await avdOf(each)) === avd) return each
    return null
  }, { interval, timeout: timeouts.online, what: `the emulator ${avd} to come online` })
  return [serial]
}

const MAIN = ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER']

// Installs and launches the APK at `apkPath` on each device of `device` (see devicesFor()), its dev server
// port `port` reversed to this machine's, as run-android reverses it, once it has booted (adb has a
// device online before its package service is up, which install needs): the app, built for that port, reaches
// the dev server at localhost on a device, and at 10.0.2.2 (this machine) on an emulator. Its launcher
// activity is the one Android resolves, of its package: `applicationId`, else the APK's own. Rejects if a
// step fails. -> { applicationId, devices }.
export async function launchAndroid({ apkPath, applicationId = null, device = null, port, log = () => {}, env = process.env, run = exec, start = startDetached, interval = 1000, timeouts = { online: 60_000, booted: 180_000 } }) {
  const adb = sdkTool('platform-tools/adb', env)
  const id = applicationId ?? (await packageOf(run, apkPath, env))
  const devices = await devicesFor({ run, adb, emulator: sdkTool('emulator/emulator', env), start, wanted: device, log, interval, timeouts })
  for (const serial of devices) {
    await poll(async () => ((await run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']).catch(() => '')).trim() === '1' ? true : null), { interval, timeout: timeouts.booted, what: `${serial} to boot` })
    log(`rn-serve: launching ${id} (${basename(apkPath)}) on ${serial}`)
    await run(adb, ['-s', serial, 'install', '-r', '-d', apkPath])
    await run(adb, ['-s', serial, 'reverse', `tcp:${port}`, `tcp:${port}`])
    const resolved = (await run(adb, ['-s', serial, 'shell', 'cmd', 'package', 'resolve-activity', '--brief', ...MAIN, id])).trim().split('\n').at(-1).trim()
    if (!resolved.startsWith(`${id}/`)) throw new Error(`${id} has no launcher activity on ${serial}: ${resolved}`)
    // -W: waits for the activity to start, and says of what fails on stdout (else stderr, which exec drops
    // where the command exits 0, as am start does of an error).
    const started = await run(adb, ['-s', serial, 'shell', 'am', 'start', '-W', '-n', resolved, ...MAIN])
    if (/^Error/mu.test(started)) throw new Error(`am start -n ${resolved} on ${serial}: ${started.trim()}`)
  }
  return { applicationId: id, devices }
}
