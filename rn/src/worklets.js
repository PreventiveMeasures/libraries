// Skips Reanimated's Babel plugin in files it would leave unchanged.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// The package of each plugin key: Reanimated 3's own, Reanimated 4's react-native-worklets.
const PACKAGES = new Map([
  ['reanimated', 'react-native-reanimated'],
  ['worklets', 'react-native-worklets'],
])
// Holds the plugin files Babel loaded for the config.
const LOADED = createRequire(import.meta.url).cache
// Calls whose callbacks the plugin makes worklets.
const NAMES = [
  'useFrameCallback', 'useAnimatedStyle', 'useAnimatedProps', 'createAnimatedPropAdapter', 'useDerivedValue', 'useAnimatedScrollHandler',
  'useAnimatedReaction', 'useWorkletCallback', 'useAnimatedGestureHandler', 'withTiming', 'withSpring', 'withDecay', 'withRepeat', 'withCallback',
  'runOnUI', 'executeOnUIRuntimeSync', 'scheduleOnUI', 'runOnUISync', 'runOnUIAsync', 'runOnRuntime', 'runOnRuntimeSync', 'runOnRuntimeAsync',
  'scheduleOnRuntime', 'runOnRuntimeSyncWithId', 'scheduleOnRuntimeWithId', 'useTapGesture', 'usePanGesture', 'usePinchGesture',
  'useRotationGesture', 'useFlingGesture', 'useLongPressGesture', 'useNativeGesture', 'useManualGesture', 'useHoverGesture', 'Gesture',
]
// More such names, as quoted in the plugin's own code, for versions newer than NAMES.
const NAMED = /(["'])((?:use|with|run|schedule|execute|create)[A-Z][A-Za-z]*)\1/gu
// The plugin's isRelease(), which decides whether it warns of `.value` read in an inline style:
// Reanimated 3 reads BABEL_ENV or NODE_ENV, 4 Babel's envName first.
const RELEASE = /prod|release|stag[ei]/iu
const VALUE = /\bvalue\b/u

// -> (plugin, source) => whether the plugin is Reanimated's and would leave the source as is: it has no
// `worklet`, none of the names above, and (outside a release) no `value`.
export function workletsGate({ cwd, envName = '' }) {
  const byEnv = RELEASE.test(process.env.BABEL_ENV ?? '') || RELEASE.test(process.env.NODE_ENV ?? '')
  const release = byEnv && (RELEASE.test(envName) || !/dev/iu.test(envName))
  // The names the plugin acts on, read from its files Babel loaded, else as the project resolves it; null
  // if unreadable, which keeps the plugin.
  const wordsOf = (name) => {
    const file = new RegExp(String.raw`[\\/]${name}[\\/]plugin(?:\.js$|[\\/].*\.c?js$)`, 'u')
    const loaded = Object.keys(LOADED).filter((path) => file.test(path))
    try {
      const paths = loaded.length > 0 ? loaded : [createRequire(join(cwd, 'package.json')).resolve(`${name}/plugin`)]
      const code = paths.map((path) => readFileSync(path, 'utf8')).join('\n')
      const names = new Set([...NAMES, ...code.matchAll(NAMED).map(([, , named]) => named)])
      return new RegExp(`worklet|\\b(?:${[...names].join('|')})\\b`, 'u')
    } catch {
      return null
    }
  }
  const words = new Map()
  return ({ key, options }, source) => {
    // For the web or a worklets bundle, it changes more.
    if (!PACKAGES.has(key) || options.substituteWebPlatformChecks || options.bundleMode) return false
    if (!words.has(key)) words.set(key, wordsOf(PACKAGES.get(key)))
    const found = words.get(key)
    if (found === null || found.test(source)) return false
    return release || options.disableInlineStylesWarning === true || !VALUE.test(source)
  }
}
