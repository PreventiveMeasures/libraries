// React Native's part of reading a podspec: what a Podfile's use_react_native! leaves in the environment, and
// the helpers its scripts give a podspec. Each is a port of one version's own Ruby, and is had only of the
// versions whose Ruby is that, word for word, which are families by the minor version each begins at: 78, every
// 0.78; 83, every 0.83; 85, every 0.85 and 0.86; 88, every 0.88. Of another version nothing is known, and a
// podspec that needs it is refused.

import { helpersOf } from './podspec-rn-core.js'

// The variables use_react_native! sets from what the Podfile gave it, which no lockfile says.
const PODFILE = new Set(['APP_PATH', 'REACT_NATIVE_PATH'])

// The environment after use_react_native!, where the Podfile and the shell set nothing of it. `frameworks` is
// what pods are built as, which USE_FRAMEWORKS is set by; `prebuilt` what the lockfile has prebuilt, which is
// what the variables that ask for it are taken to have been.
function environment(family, { frameworks, prebuilt }) {
  const env = { RCT_NEW_ARCH_ENABLED: '1', RCT_FABRIC_ENABLED: '1', RCT_AGGREGATE_PRIVACY_FILES: '1' }
  if (typeof frameworks === 'string') env.USE_FRAMEWORKS = frameworks
  if (family === 78) return { ...env, USE_HERMES: '1' }
  // 83 has prebuilt what is asked for, and the later ones what is not refused.
  if (prebuilt.deps || family > 83) env.RCT_USE_RN_DEP = prebuilt.deps ? '1' : '0'
  if (prebuilt.core || family > 83) env.RCT_USE_PREBUILT_RNCORE = prebuilt.core ? '1' : '0'
  if (family > 83) Object.assign(env, { RCT_REMOVE_LEGACY_ARCH: '1', RCT_HERMES_V1_ENABLED: '1' })
  if (family >= 88) Object.assign(env, { RCT_REMOVE_LEGACY_MODULE_INTEROP: '0', RCT_REMOVE_LEGACY_COMPONENT_INTEROP: '0' })
  return { ...env, RCT_SKIP_CODEGEN: '0' }
}

const FAMILIES = [[78, /^0\.78\.[0-3]$/u], [83, /^0\.83\.(?:\d|10)$/u], [85, /^0\.(?:85\.[0-3]|86\.[023])$/u], [88, /^0\.88\.[01]$/u]]
export const KNOWN = '0.78.0 to 0.78.3, 0.83.0 to 0.83.10, 0.85.0 to 0.86.3, 0.88.0 and 0.88.1'
// The name of every helper, of any family: what a podspec may ask whether is defined.
export const HELPERS = new Set(FAMILIES.flatMap(([family]) => Object.keys(helpersOf(family))))

// React Native's part of `version`, or undefined where it is not known: `env(context)`, the variables it
// leaves set; `podfile`, those it has of the Podfile; and `helpers`, its helpers by name, podspec-rn-core.js's.
export function reactNative(version) {
  const family = FAMILIES.find(([, versions]) => versions.test(version))?.[0]
  return family === undefined ? undefined : { env: (context) => environment(family, context), podfile: PODFILE, helpers: helpersOf(family) }
}
