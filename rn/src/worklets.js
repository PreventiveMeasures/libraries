// Reanimated's Babel plugin, left out of each file it would leave as it is.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Each one's key, and its module: Reanimated 3's own, Reanimated 4's of
// react-native-worklets.
const PLUGINS = new Map([
  ['reanimated', 'react-native-reanimated/plugin'],
  ['worklets', 'react-native-worklets/plugin'],
])
// The paths of each one's code: its module, or a file in its directory.
const FILES = new Map([
  ['reanimated', /[\\/]react-native-reanimated[\\/]plugin(?:\.js$|[\\/].*\.c?js$)/u],
  ['worklets', /[\\/]react-native-worklets[\\/]plugin(?:\.js$|[\\/].*\.c?js$)/u],
])
// The modules loaded, Babel's of the config's plugins too: one cache of a thread's.
const LOADED = createRequire(import.meta.url).cache
// What they make a worklet of the callbacks to, by name: Reanimated's hooks,
// animations and what runs a function on another runtime, gesture
// handler's hooks, a Gesture's object (its onStart, onUpdate...), a layout
// animation's withCallback.
const NAMES = [
  'useFrameCallback', 'useAnimatedStyle', 'useAnimatedProps', 'createAnimatedPropAdapter', 'useDerivedValue', 'useAnimatedScrollHandler',
  'useAnimatedReaction', 'useWorkletCallback', 'useAnimatedGestureHandler', 'withTiming', 'withSpring', 'withDecay', 'withRepeat', 'withCallback',
  'runOnUI', 'executeOnUIRuntimeSync', 'scheduleOnUI', 'runOnUISync', 'runOnUIAsync', 'runOnRuntime', 'runOnRuntimeSync', 'runOnRuntimeAsync',
  'scheduleOnRuntime', 'runOnRuntimeSyncWithId', 'scheduleOnRuntimeWithId', 'useTapGesture', 'usePanGesture', 'usePinchGesture',
  'useRotationGesture', 'useFlingGesture', 'useLongPressGesture', 'useNativeGesture', 'useManualGesture', 'useHoverGesture', 'Gesture',
]
// Each name of that kind the plugin's own code has, of a version that has
// more than these.
const NAMED = /(["'])((?:use|with|run|schedule|execute|create)[A-Z][A-Za-z]*)\1/gu
// As each has it (isRelease()), where it warns of a shared value read in an
// inline style: Reanimated 3 of BABEL_ENV or NODE_ENV, 4 of Babel's env first.
const RELEASE = /(prod|release|stag[ei])/iu
const VALUE = /\bvalue\b/u

// ({ cwd, envName }) -> (plugin, source) => whether the file's source has
// nothing the plugin, if Reanimated's, acts on, which leaves it as it is,
// though it visits each call, function, class and JSX attribute of it (and
// Reanimated 4's walks it all once more first): a worklet's directive or a
// marker of one (`worklet` in each), the names it makes a worklet of the
// callbacks to, of NAMES and of the plugin's code; or, but in a release,
// the word `value`, of a member `.value` however it is spaced or commented
// (a shared value's, in a style, which it warns of). With its
// options of the web or of a bundle of worklets, it changes more: kept.
export function workletsGate({ cwd, envName = '' }) {
  const byEnv = RELEASE.test(process.env.BABEL_ENV ?? '') || RELEASE.test(process.env.NODE_ENV ?? '')
  const release = byEnv && (RELEASE.test(envName) || !/dev/iu.test(envName))
  const words = new Map()
  // The plugin's code: of the files of it Babel loaded, by the config's
  // plugin, wherever from (a preset's own, a parent's node_modules); else of
  // its module as the project resolves it; null where none can be read.
  const codeOf = (key) => {
    const loaded = Object.keys(LOADED).filter((path) => FILES.get(key).test(path))
    try {
      const paths = loaded.length > 0 ? loaded : [createRequire(join(cwd, 'package.json')).resolve(PLUGINS.get(key))]
      return paths.map((path) => readFileSync(path, 'utf8')).join('\n')
    } catch {
      return null
    }
  }
  // The plugin's words, or null where its code can't be read, which keeps it.
  const wordsOf = (key) => {
    if (!words.has(key)) {
      const code = codeOf(key)
      const names = code === null ? null : new Set([...NAMES, ...Array.from(code.matchAll(NAMED), ([, , name]) => name)])
      words.set(key, names === null ? null : new RegExp(`worklet|\\b(?:${[...names].join('|')})\\b`, 'u'))
    }
    return words.get(key)
  }
  return ({ key, options }, source) => {
    if (!PLUGINS.has(key) || options.substituteWebPlatformChecks || options.bundleMode) return false
    const found = wordsOf(key)
    if (found === null || found.test(source)) return false
    return release || options.disableInlineStylesWarning === true || !VALUE.test(source)
  }
}
