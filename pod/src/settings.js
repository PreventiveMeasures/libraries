// What Target::BuildSettings shares: a setting's values written as an .xcconfig takes them, and the xcconfigs
// that specs give merged into one.

import { byBytes, mergeSettings, newConfig } from './xcconfig.js'

export const PLURAL = new Set([
  'ALTERNATE_PERMISSIONS_FILES', 'ARCHS', 'BUILD_VARIANTS', 'EXCLUDED_SOURCE_FILE_NAMES', 'FRAMEWORK_SEARCH_PATHS', 'GCC_PREPROCESSOR_DEFINITIONS',
  'GCC_PREPROCESSOR_DEFINITIONS_NOT_USED_IN_PRECOMPS', 'HEADER_SEARCH_PATHS', 'INCLUDED_SOURCE_FILE_NAMES', 'INFOPLIST_PREPROCESSOR_DEFINITIONS',
  'LD_RUNPATH_SEARCH_PATHS', 'LIBRARY_SEARCH_PATHS', 'LOCALIZED_STRING_MACRO_NAMES', 'OTHER_CFLAGS', 'OTHER_CPLUSPLUSFLAGS', 'OTHER_LDFLAGS',
  'OTHER_MODULE_VERIFIER_FLAGS', 'OTHER_SWIFT_FLAGS', 'REZ_SEARCH_PATHS', 'SECTORDER_FLAGS', 'SWIFT_ACTIVE_COMPILATION_CONDITIONS', 'SWIFT_INCLUDE_PATHS',
  'SYSTEM_FRAMEWORK_SEARCH_PATHS', 'SYSTEM_HEADER_SEARCH_PATHS', 'USER_HEADER_SEARCH_PATHS', 'WARNING_CFLAGS', 'WARNING_LDFLAGS',
])

export const BUILD_DIR = '${PODS_CONFIGURATION_BUILD_DIR}'
export const XCFRAMEWORKS_DIR = '${PODS_XCFRAMEWORKS_BUILD_DIR}'

// BuildSettings#quote_array.
function quoteArray(values) {
  return values.map((value) => {
    const pair = /^([\w-]+?)=(.+)$/su.exec(value)
    if (pair !== null) return `${pair[1]}=${/[^\w\d]/u.test(pair[2]) ? `"${pair[2]}"` : pair[2]}`
    return /[$[\] ]/u.test(value) ? `"${value}"` : value
  }).join(' ')
}

// An object whose properties are each computed once, when first read, by `definitions`.
export function lazy(definitions) {
  const out = {}
  for (const [name, compute] of Object.entries(definitions)) {
    Object.defineProperty(out, name, {
      enumerable: true,
      configurable: true,
      get() {
        const value = compute(out)
        Object.defineProperty(out, name, { value, enumerable: true })
        return value
      },
    })
  }
  return out
}

// BuildSettings#xcconfig: the settings named, in order, a plural one after `$(inherited)`; then the specs' own,
// a singular one in place of what is there and a plural one merged with it.
export function configOf(settings, names, specSettings) {
  const hash = {}
  for (const name of [...names].sort(byBytes)) {
    const value = settings[name]
    if (value === undefined || value === null) hash[name] = '$(inherited)'
    else hash[name] = PLURAL.has(name) ? `$(inherited) ${quoteArray(value)}` : value
  }
  const config = newConfig(hash)
  const plural = {}
  for (const [key, value] of Object.entries(specSettings)) {
    if (PLURAL.has(key)) plural[key] = value
    else config.attributes[key] = value
  }
  return mergeSettings(config, plural)
}

// BuildSettings#merged_xcconfigs: `byConsumer` is each consumer's xcconfig. A setting they give alike stands;
// a plural one has each of its values once; one that is singular, or yes or no, and given otherwise by two, is
// left out, as CocoaPods warns and leaves it.
export function mergedXcconfigs(byConsumer) {
  const values = new Map()
  for (const xcconfig of byConsumer) {
    for (const [key, value] of Object.entries(xcconfig)) {
      if (!values.has(key)) values.set(key, [])
      if (!values.get(key).includes(value)) values.get(key).push(value)
    }
  }
  const merged = {}
  for (const [key, unique] of values) {
    const flags = unique.every((value) => typeof value === 'string' && /^(?:yes|no)$/iu.test(value))
    if (!flags && PLURAL.has(key)) merged[key] = unique.join(' ')
    else if (unique.length === 1) [merged[key]] = unique
  }
  return merged
}

const sorted = (values) => [...values].sort(byBytes)
export const uniqueSorted = (values) => sorted(new Set(values))
export { sorted }
